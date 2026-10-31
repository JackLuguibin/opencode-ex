export * as Replay from "./replay.js"

import { Gateway } from "@opencode/protocol/gateway"
import { Proxy } from "./proxy.js"
import type { PlatformWrite } from "@opencode/util/platform-write"
import { RuntimeRegistry } from "@opencode/util/runtime-registry"
import type { RedisClient } from "bun"

const BATCH = 100
const LOCK_SECONDS = 30

/**
 * Brings every online execution layer up to date with the platform writes it missed: it was offline, or refused one the
 * others took. Writes are sent in the order they were made, each with a freshly signed header for the actor who made it,
 * and a layer's position moves after each one, so a failure stops that layer at the right place for the next round. A
 * layer the gateway sees for the first time starts at the newest write, which is the state it was deployed with.
 */
export async function once(input: {
  readonly redis: RedisClient
  readonly store: PlatformWrite.Store
  readonly secret: string
  readonly log: (line: string) => void
}) {
  const [runtimes, latest, trimmed] = await Promise.all([
    RuntimeRegistry.list(input.redis),
    input.store.latest(),
    RuntimeRegistry.platformTrimmed(input.redis),
  ])
  for (const runtime of runtimes) {
    const applied = await RuntimeRegistry.platformApplied(input.redis, runtime.id)
    if (applied === undefined) {
      await RuntimeRegistry.markPlatformApplied(input.redis, runtime.id, latest)
      continue
    }
    if (applied >= latest) continue
    if (applied < trimmed) {
      input.log(`layer ${runtime.id} is behind platform writes that were already trimmed; it needs to be reset by hand`)
      continue
    }
    // Several gateways run this loop; one replays a layer at a time.
    const lock = `platform-replay:${runtime.id}`
    if ((await input.redis.set(lock, "1", "EX", String(LOCK_SECONDS), "NX")) === null) continue
    try {
      for (const entry of await input.store.after(applied, BATCH)) {
        const response = await fetch(`${runtime.url}${entry.path}${entry.search}`, {
          method: entry.method,
          headers: {
            ...(entry.contentType ? { "content-type": entry.contentType } : {}),
            "accept-encoding": "identity",
            [Gateway.ACTOR_HEADER]: Gateway.sign(input.secret, entry.actor as Gateway.Actor),
            [Proxy.REQUEST_ID_HEADER]: `replay-${entry.seq}`,
          },
          body: Buffer.from(entry.body),
        }).catch(() => undefined)
        // A layer that cannot answer is tried again next round. A refusal would be the same every time, so it is
        // passed over rather than left to hold up everything after it.
        if (!response || response.status >= 500) break
        if (!response.ok) input.log(`layer ${runtime.id} refused platform write ${entry.seq} (${response.status}); skipped`)
        await RuntimeRegistry.markPlatformApplied(input.redis, runtime.id, entry.seq)
      }
    } finally {
      await input.redis.del(lock)
    }
  }
}

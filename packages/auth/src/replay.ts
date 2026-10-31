export * as Replay from "./replay.js"

import { Gateway } from "@opencode/protocol/gateway"
import { Proxy } from "./proxy.js"
import type { PlatformWrite } from "@opencode/util/platform-write"
import { RuntimeRegistry } from "@opencode/util/runtime-registry"
import type { RedisClient } from "bun"

const BATCH = 100
const LOCK_SECONDS = 30
const REQUEST_TIMEOUT_MS = 10_000

/**
 * Brings every online execution layer up to date with the platform writes it missed: it was offline, or refused one the
 * others took. Writes are sent in the order they were made, each with a freshly signed header for the actor who made it,
 * and a layer's position moves after each one, so a failure stops that layer at the right place for the next round.
 * Layers are caught up side by side, and a request that gets no answer in time counts as a failure, so one layer that
 * hangs holds up neither the others nor the next round.
 */
export async function once(input: {
  readonly redis: RedisClient
  readonly store: PlatformWrite.Store
  readonly secret: string
  readonly log: (line: string) => void
  readonly timeoutMs?: number
}) {
  const [runtimes, latest, trimmed] = await Promise.all([
    RuntimeRegistry.list(input.redis),
    input.store.latest(),
    RuntimeRegistry.platformTrimmed(input.redis),
  ])
  await Promise.all(runtimes.map((runtime) => catchUp(runtime)))

  async function catchUp(runtime: (typeof runtimes)[number]) {
    // A layer the gateway has not recorded yet has taken no write it knows of: it may be new, or it may have been down
    // for one while no gateway was watching, so it starts from the beginning of what the log still holds.
    const applied = await RuntimeRegistry.platformApplied(input.redis, runtime.id)
    if (applied >= latest) return
    if (applied < trimmed)
      input.log(`layer ${runtime.id} is behind platform writes that were already trimmed; replaying what is left`)
    // Several gateways run this loop; one replays a layer at a time.
    const lock = `platform-replay:${runtime.id}`
    if ((await input.redis.set(lock, "1", "EX", String(LOCK_SECONDS), "NX")) === null) return
    try {
      for (const entry of await input.store.after(applied, BATCH)) {
        // A long catch-up keeps the lock for as long as it makes progress.
        await input.redis.expire(lock, LOCK_SECONDS)
        const response = await fetch(`${runtime.url}${entry.path}${entry.search}`, {
          method: entry.method,
          headers: {
            ...(entry.contentType ? { "content-type": entry.contentType } : {}),
            "accept-encoding": "identity",
            [Gateway.ACTOR_HEADER]: Gateway.sign(input.secret, entry.actor as Gateway.Actor),
            [Proxy.REQUEST_ID_HEADER]: `replay-${entry.seq}`,
          },
          body: Buffer.from(entry.body),
          signal: AbortSignal.timeout(input.timeoutMs ?? REQUEST_TIMEOUT_MS),
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

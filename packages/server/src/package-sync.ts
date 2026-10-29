export * as PackageSync from "./package-sync"

import { GlobalSync } from "@opencode/core/global-sync"
import { RuntimeRegistry } from "@opencode/util/runtime-registry"
import type { RedisClient } from "bun"

/** Where a layer's copy of the global state is read from by a peer that is behind. */
export const PATH = "/internal/global-state"

/**
 * A layer that was offline, or refused a global package or shared MCP write the others took, is behind. It copies the
 * state of a layer the gateway recorded as having the latest, then says so. Returns what it did.
 */
export async function reconcile(input: {
  readonly redis: RedisClient
  readonly id: string
  readonly password: string
  readonly config: string
  readonly data: string
}) {
  const sync = await RuntimeRegistry.packageSync(input.redis, input.id)
  if (sync.applied >= sync.latest) return "current" as const
  const holder = sync.holders.toSorted((a, b) => a.load - b.load || a.id.localeCompare(b.id))[0]
  if (!holder) return "unavailable" as const
  const response = await fetch(`${holder.url}${PATH}`, {
    headers: { authorization: `Basic ${btoa(`opencode:${input.password}`)}` },
    signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok) throw new Error(`${holder.id} answered ${response.status}`)
  await GlobalSync.restore(input.config, input.data, new Uint8Array(await response.arrayBuffer()))
  await RuntimeRegistry.markPackagesApplied(input.redis, input.id, sync.latest)
  return "copied" as const
}

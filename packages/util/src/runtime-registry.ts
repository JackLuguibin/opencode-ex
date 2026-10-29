export * as RuntimeRegistry from "./runtime-registry.js"

import type { RedisClient } from "bun"

// Execution layers announce themselves here and keep a short lease alive. A layer that dies stops renewing, so Redis
// expires its entry and the scheduler never sees it again; no cleanup job is involved.
export const LEASE_MS = 15_000

export type Runtime = {
  readonly id: string
  readonly url: string
  readonly version: string
  readonly load: number
  readonly draining: boolean
}

const key = (id: string) => `runtime:${id}`

export async function register(redis: RedisClient, runtime: Pick<Runtime, "id" | "url" | "version">) {
  await redis.hset(key(runtime.id), {
    url: runtime.url,
    version: runtime.version,
    load: "0",
    draining: "0",
  })
  await redis.pexpire(key(runtime.id), LEASE_MS)
}

// Renews the lease and reports current load. Returns false once the lease has already expired, so the caller can
// re-register instead of silently heartbeating a runtime the scheduler no longer knows.
export async function heartbeat(redis: RedisClient, id: string, load: number) {
  if (!(await redis.exists(key(id)))) return false
  await redis.hset(key(id), { load: String(load) })
  await redis.pexpire(key(id), LEASE_MS)
  return true
}

// Stops new sessions landing here while the ones already running finish.
export async function drain(redis: RedisClient, id: string) {
  if (!(await redis.exists(key(id)))) return false
  await redis.hset(key(id), { draining: "1" })
  return true
}

export async function deregister(redis: RedisClient, id: string) {
  await redis.del(key(id))
}

export async function list(redis: RedisClient): Promise<Runtime[]> {
  const keys = await scan(redis)
  const entries = await Promise.all(
    keys.map(async (name) => {
      const [url, version, load, draining] = await redis.hmget(name, ["url", "version", "load", "draining"])
      // The key can expire between the scan and the read.
      if (url === null || url === undefined) return []
      return [
        { id: name.slice("runtime:".length), url, version: version ?? "", load: Number(load ?? 0), draining: draining === "1" },
      ]
    }),
  )
  return entries.flat()
}

// Work goes to the runtime holding the fewest organizations, then the least loaded one that is accepting work; ties
// break on id so the choice is stable.
export function pick(runtimes: readonly Runtime[], held: ReadonlyMap<string, number> = new Map()) {
  return runtimes
    .filter((runtime) => !runtime.draining)
    .sort(
      (a, b) =>
        (held.get(a.id) ?? 0) - (held.get(b.id) ?? 0) || a.load - b.load || a.id.localeCompare(b.id),
    )[0]
}

async function scan(redis: RedisClient) {
  const keys: string[] = []
  let cursor = "0"
  do {
    const [next, batch] = await redis.scan(cursor, "MATCH", "runtime:*", "COUNT", "100")
    keys.push(...batch)
    cursor = next
  } while (cursor !== "0")
  return keys
}

/** Forgets where a deleted organization was placed, so its ID is not tied to a layer that has nothing of it any more. */
export async function release(redis: RedisClient, organizationID: string) {
  await redis.hdel("organization-runtime", organizationID)
}

// An organization's projects, sessions and files live in one execution layer's database, so the organization stays on
// the layer it was first given. If that layer is offline its organization is unavailable rather than silently moved to
// a layer that has none of its data. Organizations nobody has opened yet go to the least loaded layer.
export async function runtimeFor(redis: RedisClient, organizationID: string | undefined) {
  const runtimes = await list(redis)
  // Requests without an organization (a platform admin outside any) need a layer that stays the same between calls, or
  // what they list would change as load moves.
  if (!organizationID) return runtimes.filter((runtime) => !runtime.draining).sort((a, b) => a.id.localeCompare(b.id))[0]
  const assigned = (await redis.hget("organization-runtime", organizationID)) ?? undefined
  if (assigned) return runtimes.find((runtime) => runtime.id === assigned)
  // Load alone would put every new organization on the same layer while all of them are idle, so layers that already
  // hold fewer organizations go first.
  const held = new Map<string, number>()
  for (const id of await redis.hvals("organization-runtime")) held.set(id, (held.get(id) ?? 0) + 1)
  const chosen = pick(runtimes, held)
  if (!chosen) return undefined
  // Two Auth servers can race to place the same organization; the first write wins and both read it back.
  await redis.hsetnx("organization-runtime", organizationID, chosen.id)
  const winner = (await redis.hget("organization-runtime", organizationID)) ?? undefined
  return runtimes.find((runtime) => runtime.id === winner)
}

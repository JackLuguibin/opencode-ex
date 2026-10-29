export * as Registry from "./registry.js"

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

// New sessions go to the least loaded runtime that is accepting work; ties break on id so the choice is stable.
export function pick(runtimes: readonly Runtime[]) {
  return runtimes
    .filter((runtime) => !runtime.draining)
    .sort((a, b) => a.load - b.load || a.id.localeCompare(b.id))[0]
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

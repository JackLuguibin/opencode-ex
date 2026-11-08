export * as KnowledgeRegistry from "./knowledge-registry.js"

import type { RedisClient } from "bun"

// The knowledge service announces itself here and keeps a short lease alive, like an execution layer does in
// `RuntimeRegistry`. A service that dies stops renewing and the entry expires, so callers never keep a stale address.
export const LEASE_MS = 15_000

const KEY = "knowledge:service"

export type Service = { readonly id: string; readonly url: string; readonly version: string }

/** Takes the lease if nobody holds it. Returns false when another instance does, so only one service runs at a time. */
export async function claim(redis: RedisClient, service: Service) {
  const taken = await redis.set(KEY, JSON.stringify(service), "NX", "PX", String(LEASE_MS))
  return taken === "OK"
}

/** Renews the lease. Returns false once it has expired or another instance holds it, so the caller must stop serving writes. */
export async function renew(redis: RedisClient, id: string) {
  const current = await lookup(redis)
  if (!current || current.id !== id) return false
  await redis.pexpire(KEY, LEASE_MS)
  return true
}

export async function lookup(redis: RedisClient): Promise<Service | undefined> {
  const raw = await redis.get(KEY)
  return raw ? (JSON.parse(raw) as Service) : undefined
}

export async function release(redis: RedisClient, id: string) {
  const current = await lookup(redis)
  if (current?.id === id) await redis.del(KEY)
}

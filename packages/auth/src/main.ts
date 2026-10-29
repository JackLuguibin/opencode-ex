import { RuntimeRegistry } from "@opencode/util/runtime-registry"
import { Proxy } from "./proxy.js"
import { Redis } from "./redis.js"

const secret = process.env.OPENCODE_GATEWAY_SECRET
const fixed = process.env.OPENCODE_UPSTREAM_URL
const redisURL = process.env.OPENCODE_REDIS_URL
if (!secret || (!fixed && !redisURL)) {
  console.error("OPENCODE_GATEWAY_SECRET and one of OPENCODE_REDIS_URL or OPENCODE_UPSTREAM_URL are required")
  process.exit(1)
}

// With Redis, execution layers announce themselves and each organization is pinned to one of them; a fixed URL is for
// running a single layer without Redis. Placement is cached briefly so a busy proxy does not query Redis per request.
const redis = redisURL ? Redis.connect(redisURL) : undefined
const placements = new Map<string, { url: string | undefined; expires: number }>()
// A burst of requests for one organization shares a single registry lookup.
const lookups = new Map<string, Promise<string | undefined>>()
const upstream = async (organizationID?: string) => {
  if (!redis) return fixed
  const key = organizationID ?? ""
  const hit = placements.get(key)
  if (hit && hit.expires > Date.now()) return hit.url
  const pending = lookups.get(key)
  if (pending) return pending
  const lookup = RuntimeRegistry.runtimeFor(redis, organizationID)
    .then((runtime) => {
      placements.set(key, { url: runtime?.url, expires: Date.now() + 2_000 })
      return runtime?.url
    })
    .finally(() => lookups.delete(key))
  lookups.set(key, lookup)
  return lookup
}
const all = async () => (redis ? (await RuntimeRegistry.list(redis)).map((runtime) => runtime.url) : [fixed!])

const released = async (organizationID: string) => {
  placements.delete(organizationID)
  if (redis) await RuntimeRegistry.release(redis, organizationID)
}

// Healthy while the registry answers; having no execution layer online is reported but does not fail the gateway.
const health = async () => {
  if (!redis) return { ok: true, runtimes: 1 }
  // A disconnected client queues commands instead of failing them, so an unanswered listing is a failure too.
  const runtimes = await Promise.race([
    RuntimeRegistry.list(redis).catch(() => undefined),
    Bun.sleep(2_000).then(() => undefined),
  ])
  return runtimes
    ? { ok: true, runtimes: runtimes.length, draining: runtimes.filter((runtime) => runtime.draining).length }
    : { ok: false, runtimes: 0 }
}

const accepted = redis
  ? async (urls: readonly string[]) => {
      const ids = (await RuntimeRegistry.list(redis)).filter((runtime) => urls.includes(runtime.url)).map((runtime) => runtime.id)
      await RuntimeRegistry.recordPackageWrite(redis, ids)
    }
  : undefined

const proxy = Proxy.make({ secret, upstream, all, released, accepted, health, log: (line) => console.error(line) })
const server = Bun.serve({
  hostname: process.env.OPENCODE_AUTH_HOST ?? "127.0.0.1",
  port: Number(process.env.OPENCODE_AUTH_PORT ?? 4100),
  idleTimeout: 0,
  fetch: (request, server) => proxy.fetch(request, server),
  websocket: proxy.websocket,
})
console.log(`auth gateway listening on ${server.url}`)

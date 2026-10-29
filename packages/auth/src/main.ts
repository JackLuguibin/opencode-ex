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
const upstream = async (organizationID?: string) => {
  if (!redis) return fixed
  const key = organizationID ?? ""
  const hit = placements.get(key)
  if (hit && hit.expires > Date.now()) return hit.url
  const url = (await RuntimeRegistry.runtimeFor(redis, organizationID))?.url
  placements.set(key, { url, expires: Date.now() + 2_000 })
  return url
}
const all = async () => (redis ? (await RuntimeRegistry.list(redis)).map((runtime) => runtime.url) : [fixed!])

const proxy = Proxy.make({ secret, upstream, all })
const server = Bun.serve({
  hostname: process.env.OPENCODE_AUTH_HOST ?? "127.0.0.1",
  port: Number(process.env.OPENCODE_AUTH_PORT ?? 4100),
  idleTimeout: 0,
  fetch: (request, server) => proxy.fetch(request, server),
  websocket: proxy.websocket,
})
console.log(`auth gateway listening on ${server.url}`)

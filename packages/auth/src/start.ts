import { Placement } from "@opencode/util/placement"
import { Postgres } from "@opencode/util/postgres"
import { RuntimeRegistry } from "@opencode/util/runtime-registry"
import { Proxy } from "./proxy.js"
import { Redis } from "./redis.js"

/** Runs the gateway until the process exits. Shared by `bun src/main.ts` and `opencode gateway`. */
export async function start(options?: { readonly ui?: Proxy.Options["ui"] }) {
  const secret = process.env.OPENCODE_GATEWAY_SECRET
  const fixed = process.env.OPENCODE_UPSTREAM_URL
  // The execution layers call the same Redis OPENCODE_REGISTRY_URL, so one env file can serve both.
  const redisURL = process.env.OPENCODE_REDIS_URL ?? process.env.OPENCODE_REGISTRY_URL
  if (!secret || (!fixed && !redisURL)) {
    console.error("OPENCODE_GATEWAY_SECRET and one of OPENCODE_REDIS_URL (or OPENCODE_REGISTRY_URL) or OPENCODE_UPSTREAM_URL are required")
    process.exit(1)
  }

  // With Redis, execution layers announce themselves and each organization is pinned to one of them; a fixed URL is for
  // running a single layer without Redis. Placement is cached briefly so a busy proxy does not query Redis per request.
  const redis = redisURL ? Redis.connect(redisURL) : undefined
  // Which layer holds each organization is durable, so it lives in the same Postgres as the accounts; Redis only holds
  // the leases. The execution layers call that Postgres OPENCODE_IDENTITY_POSTGRES_URL, so one env file serves both.
  const placements = await openPlacements(redis)
  const cache = new Map<string, { url: string | undefined; expires: number }>()
  // A burst of requests for one organization shares a single registry lookup.
  const lookups = new Map<string, Promise<string | undefined>>()
  const upstream = async (organizationID?: string) => {
    if (!redis) return fixed
    const key = organizationID ?? ""
    const hit = cache.get(key)
    if (hit && hit.expires > Date.now()) return hit.url
    const pending = lookups.get(key)
    if (pending) return pending
    const lookup = RuntimeRegistry.runtimeFor(redis, placements!, organizationID)
      .then((runtime) => {
        cache.set(key, { url: runtime?.url, expires: Date.now() + 2_000 })
        return runtime?.url
      })
      .finally(() => lookups.delete(key))
    lookups.set(key, lookup)
    return lookup
  }
  const all = async () => (redis ? (await RuntimeRegistry.list(redis)).map((runtime) => runtime.url) : [fixed!])

  const released = async (organizationID: string) => {
    cache.delete(organizationID)
    await placements?.release(organizationID)
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

  // Ten wrong passwords for one employee ID lock sign-in for that ID for 15 minutes; a correct one clears the count.
  const MAX_FAILURES = 10
  const LOCK_SECONDS = 900
  const attempts = redis
    ? {
        blocked: async (employeeID: string) => Number((await redis.get(`login-failures:${employeeID}`)) ?? 0) >= MAX_FAILURES,
        record: async (employeeID: string, ok: boolean) => {
          const key = `login-failures:${employeeID}`
          if (ok) return void (await redis.del(key))
          if ((await redis.incr(key)) === 1) await redis.expire(key, LOCK_SECONDS)
        },
      }
    : undefined

  const proxy = Proxy.make({ secret, ui: options?.ui, attempts, upstream, all, released, accepted, health, log: (line) => console.error(line) })
  // One address to listen on, e.g. http://0.0.0.0:4100.
  const listen = new URL(process.env.OPENCODE_AUTH_URL ?? "http://127.0.0.1:4100")
  const server = Bun.serve({
    hostname: listen.hostname,
    port: Number(listen.port || 4100),
    idleTimeout: 0,
    fetch: (request, server) => proxy.fetch(request, server),
    websocket: proxy.websocket,
  })
  console.log(`auth gateway listening on ${server.url}`)
}

async function openPlacements(redis: ReturnType<typeof Redis.connect> | undefined) {
  if (!redis) return undefined
  const url = process.env.OPENCODE_IDENTITY_POSTGRES_URL
  if (!url) {
    console.error("OPENCODE_IDENTITY_POSTGRES_URL is required with a registry: it records which execution layer holds each organization")
    process.exit(1)
  }
  const sql = Postgres.connect(url)
  await Postgres.migrate(sql, Placement.migrations)
  const copied = await Placement.importLegacy(sql, redis)
  if (copied > 0) console.error(`moved ${copied} organization placements from Redis to Postgres`)
  return Placement.make(sql)
}

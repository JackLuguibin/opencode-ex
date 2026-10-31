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
  // `blocked` counts the attempt before it is forwarded, so guesses sent at the same moment cannot all pass the check,
  // and the key is created with its expiry so no interruption can leave a count that never lapses.
  const MAX_FAILURES = 10
  const LOCK_SECONDS = 900
  const attempts = redis
    ? {
        blocked: async (employeeID: string) => {
          const key = `login-failures:${employeeID}`
          await redis.set(key, "0", "EX", String(LOCK_SECONDS), "NX")
          return (await redis.incr(key)) > MAX_FAILURES
        },
        record: async (employeeID: string, ok: boolean) => {
          if (ok) await redis.del(`login-failures:${employeeID}`)
        },
      }
    : undefined

  // An account write on one gateway must drop the identities every other gateway cached, or a switched organization or
  // a revoked membership keeps working there until the cache lapses.
  const gatewayID = crypto.randomUUID()
  const invalidated = redis ? async () => void (await redis.publish(ACCOUNT_CHANNEL, gatewayID)) : undefined
  const proxy = Proxy.make({ secret, ui: options?.ui, attempts, upstream, all, released, accepted, invalidated, health, log: (line) => console.error(line) })
  if (redisURL) void watchAccountWrites(redisURL, gatewayID, proxy.invalidate)
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

export const ACCOUNT_CHANNEL = "account-write"

/**
 * Drops this gateway's cached identities when another gateway reports an account write. A subscribed connection can do
 * nothing else, so it has its own; after it drops, messages may have been missed, so the cache is cleared on every
 * (re)subscribe.
 */
export async function watchAccountWrites(url: string, gatewayID: string, invalidate: () => void) {
  for (;;) {
    const subscriber = Redis.connect(url)
    const closed = new Promise<void>((resolve) => {
      subscriber.onclose = () => resolve()
    })
    await subscriber
      .subscribe(ACCOUNT_CHANNEL, (origin) => {
        if (origin !== gatewayID) invalidate()
      })
      .then(() => {
        invalidate()
        return closed
      })
      .catch(() => undefined)
    subscriber.close()
    await Bun.sleep(1_000)
  }
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

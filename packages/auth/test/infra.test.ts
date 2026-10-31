import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Postgres } from "@opencode/util/postgres"
import { Redis } from "../src/redis.js"
import { ACCOUNT_CHANNEL, watchAccountWrites } from "../src/start.js"
import { Placement } from "@opencode/util/placement"
import { PlatformWrite } from "@opencode/util/platform-write"
import { Replay } from "../src/replay.js"
import { Gateway } from "@opencode/protocol/gateway"
import { RuntimeRegistry } from "@opencode/util/runtime-registry"

const postgresURL = process.env.OPENCODE_TEST_POSTGRES_URL
const redisURL = process.env.OPENCODE_TEST_REDIS_URL

describe.skipIf(!postgresURL)("postgres", () => {
  const db = Postgres.connect(postgresURL!)
  afterAll(() => db.close())

  test("applies each migration once, even when started concurrently", async () => {
    await db`DROP TABLE IF EXISTS auth_migration, auth_probe`
    const migrations = [{ id: "001_probe", sql: "CREATE TABLE auth_probe (id int)" }]
    await Promise.all([Postgres.migrate(db, migrations), Postgres.migrate(db, migrations)])
    await Postgres.migrate(db, [...migrations, { id: "002_probe", sql: "INSERT INTO auth_probe VALUES (1)" }])
    expect((await db`SELECT count(*)::int AS count FROM auth_migration`)[0].count).toBe(2)
    expect((await db`SELECT count(*)::int AS count FROM auth_probe`)[0].count).toBe(1)
    await db`DROP TABLE auth_migration, auth_probe`
  })
})

describe.skipIf(!redisURL || !postgresURL)("runtime registry", () => {
  const redis = Redis.connect(redisURL!)
  const db = Postgres.connect(postgresURL!)
  const placements = Placement.make(db)
  beforeAll(async () => {
    // The migration test above leaves the applied-migrations list empty, so start from no table to match it.
    await db`DROP TABLE IF EXISTS organization_placement, auth_migration`
    await Postgres.migrate(db, Placement.migrations)
    for (const runtime of await RuntimeRegistry.list(redis)) await RuntimeRegistry.deregister(redis, runtime.id)
  })
  afterAll(async () => {
    await db`DROP TABLE IF EXISTS organization_placement, auth_migration`
    redis.close()
    db.close()
  })

  test("a layer that missed a package write is behind, and learns who has the latest", async () => {
    await redis.del("global-revision")
    await redis.del("global-applied")
    for (const id of ["a", "b"]) await RuntimeRegistry.register(redis, { id, url: `http://${id}`, version: "1" })
    expect((await RuntimeRegistry.packageSync(redis, "b")).latest).toBe(0)

    // The gateway saw layer a take the write; b was down.
    await RuntimeRegistry.recordPackageWrite(redis, ["a"])
    const behind = await RuntimeRegistry.packageSync(redis, "b")
    expect([behind.latest, behind.applied, behind.holders.map((runtime) => runtime.id)]).toEqual([1, 0, ["a"]])
    expect((await RuntimeRegistry.packageSync(redis, "a")).applied).toBe(1)

    await RuntimeRegistry.markPackagesApplied(redis, "b", behind.latest)
    expect(await RuntimeRegistry.packageSync(redis, "b")).toMatchObject({ latest: 1, applied: 1, holders: [] })
    for (const id of ["a", "b"]) await RuntimeRegistry.deregister(redis, id)
    await redis.del("global-revision")
    await redis.del("global-applied")
  })

  test("a layer that missed an earlier package write stays behind after taking a later one", async () => {
    await redis.del("global-revision")
    await redis.del("global-applied")
    for (const id of ["a", "b"]) await RuntimeRegistry.register(redis, { id, url: `http://${id}`, version: "1" })

    // Write 1 reaches only a; write 2 reaches both. b has write 2 but not write 1.
    await RuntimeRegistry.recordPackageWrite(redis, ["a"])
    await RuntimeRegistry.recordPackageWrite(redis, ["a", "b"])
    const behind = await RuntimeRegistry.packageSync(redis, "b")
    expect([behind.latest, behind.applied, behind.holders.map((runtime) => runtime.id)]).toEqual([2, 0, ["a"]])
    expect((await RuntimeRegistry.packageSync(redis, "a")).applied).toBe(2)
    for (const id of ["a", "b"]) await RuntimeRegistry.deregister(redis, id)
    await redis.del("global-revision")
    await redis.del("global-applied")
  })

  test("picks the least loaded runtime and skips draining ones", async () => {
    await RuntimeRegistry.register(redis, { id: "a", url: "http://a", version: "1" })
    await RuntimeRegistry.register(redis, { id: "b", url: "http://b", version: "1" })
    await RuntimeRegistry.register(redis, { id: "c", url: "http://c", version: "1" })
    await RuntimeRegistry.heartbeat(redis, "a", 5)
    await RuntimeRegistry.heartbeat(redis, "b", 2)
    await RuntimeRegistry.heartbeat(redis, "c", 1)
    await RuntimeRegistry.drain(redis, "c")
    const runtimes = await RuntimeRegistry.list(redis)
    expect(runtimes.map((runtime) => runtime.id).sort()).toEqual(["a", "b", "c"])
    expect(RuntimeRegistry.pick(runtimes)?.id).toBe("b")
    for (const id of ["a", "b", "c"]) await RuntimeRegistry.deregister(redis, id)
    expect(RuntimeRegistry.pick(await RuntimeRegistry.list(redis))).toBeUndefined()
  })

  test("requests without an organization keep going to the same runtime as load changes", async () => {
    await RuntimeRegistry.register(redis, { id: "m", url: "http://m", version: "1" })
    await RuntimeRegistry.register(redis, { id: "n", url: "http://n", version: "1" })
    await RuntimeRegistry.heartbeat(redis, "m", 9)
    await RuntimeRegistry.heartbeat(redis, "n", 1)
    expect((await RuntimeRegistry.runtimeFor(redis, placements, undefined))?.id).toBe("m")
    await RuntimeRegistry.heartbeat(redis, "m", 1)
    await RuntimeRegistry.heartbeat(redis, "n", 9)
    expect((await RuntimeRegistry.runtimeFor(redis, placements, undefined))?.id).toBe("m")
    await RuntimeRegistry.drain(redis, "m")
    expect((await RuntimeRegistry.runtimeFor(redis, placements, undefined))?.id).toBe("n")
    for (const id of ["m", "n"]) await RuntimeRegistry.deregister(redis, id)
  })

  test("a runtime that stops heartbeating expires and cannot be revived by a late heartbeat", async () => {
    await RuntimeRegistry.register(redis, { id: "gone", url: "http://gone", version: "1" })
    await redis.pexpire("runtime:gone", 1)
    await Bun.sleep(20)
    expect(await RuntimeRegistry.heartbeat(redis, "gone", 1)).toBe(false)
    expect((await RuntimeRegistry.list(redis)).some((runtime) => runtime.id === "gone")).toBe(false)
  })

  test("an organization stays on the runtime it was first given, even when it goes offline", async () => {
    await db`DELETE FROM organization_placement`
    await RuntimeRegistry.register(redis, { id: "x", url: "http://x", version: "1" })
    await RuntimeRegistry.register(redis, { id: "y", url: "http://y", version: "1" })
    await RuntimeRegistry.heartbeat(redis, "x", 1)
    await RuntimeRegistry.heartbeat(redis, "y", 3)
    expect((await RuntimeRegistry.runtimeFor(redis, placements, "org_a"))?.id).toBe("x")
    await RuntimeRegistry.heartbeat(redis, "x", 9)
    expect((await RuntimeRegistry.runtimeFor(redis, placements, "org_a"))?.id).toBe("x")
    expect((await RuntimeRegistry.runtimeFor(redis, placements, "org_b"))?.id).toBe("y")
    expect((await RuntimeRegistry.runtimeFor(redis, placements, "org_c"))?.id).toBe("y")
    await RuntimeRegistry.deregister(redis, "x")
    expect(await RuntimeRegistry.runtimeFor(redis, placements, "org_a")).toBeUndefined()
    await RuntimeRegistry.deregister(redis, "y")
    await db`DELETE FROM organization_placement`
  })

  test("two gateways placing the same organization at once agree on one layer", async () => {
    await db`DELETE FROM organization_placement`
    for (const id of ["p", "q"]) await RuntimeRegistry.register(redis, { id, url: `http://${id}`, version: "1" })
    const found = await Promise.all(
      Array.from({ length: 8 }, () => RuntimeRegistry.runtimeFor(redis, placements, "org_race")),
    )
    expect(new Set(found.map((runtime) => runtime?.id)).size).toBe(1)
    await placements.release("org_race")
    expect(await placements.get("org_race")).toBeUndefined()
    for (const id of ["p", "q"]) await RuntimeRegistry.deregister(redis, id)
  })

  test("moves placements that were kept in Redis into Postgres once", async () => {
    await db`DELETE FROM organization_placement`
    await redis.del("organization-runtime", "organization-runtime:imported")
    await redis.hset("organization-runtime", { org_old: "x", org_older: "y" })
    expect(await Placement.importLegacy(db, redis)).toBe(2)
    expect(await placements.get("org_old")).toBe("x")
    // A released organization stays released: the old hash is gone, so a later start has nothing to copy back.
    await placements.release("org_old")
    expect(await Placement.importLegacy(db, redis)).toBe(0)
    expect(await placements.get("org_old")).toBeUndefined()
    await db`DELETE FROM organization_placement`
    await redis.del("organization-runtime:imported")
  })
})

describe.skipIf(!redisURL)("account writes", () => {
  test("a gateway drops its cached identities when another one publishes an account write", async () => {
    const redis = Redis.connect(redisURL!)
    let dropped = 0
    void watchAccountWrites(redisURL!, "me", () => dropped++)
    // Subscribing clears once, because messages sent while it was down are lost.
    await waitFor(() => dropped === 1)
    await redis.publish(ACCOUNT_CHANNEL, "someone-else")
    await waitFor(() => dropped === 2)
    // Its own write already cleared its cache.
    await redis.publish(ACCOUNT_CHANNEL, "me")
    await Bun.sleep(100)
    expect(dropped).toBe(2)
    redis.close()
  })
})

async function waitFor(done: () => boolean) {
  for (let index = 0; index < 50 && !done(); index++) await Bun.sleep(40)
  expect(done()).toBe(true)
}

describe.skipIf(!redisURL || !postgresURL)("platform write replay", () => {
  const redis = Redis.connect(redisURL!)
  const db = Postgres.connect(postgresURL!)
  const store = PlatformWrite.make(db)
  const secret = "replay-secret"
  const actor: Gateway.Actor = {
    userID: "usr_a",
    employeeID: "1",
    admin: true,
    organizationID: undefined,
    organizationAdmin: false,
    settingsPages: [],
    organizations: [],
  }
  const layer = (received: string[]) =>
    Bun.serve({
      port: 0,
      async fetch(request) {
        const who = Gateway.verify(secret, request.headers.get(Gateway.ACTOR_HEADER) ?? "")?.userID
        received.push(`${request.method} ${new URL(request.url).pathname} ${await request.text()} ${who}`)
        return Response.json({})
      },
    })
  const write = (body: string) =>
    store.append({ method: "PATCH", path: "/api/experimental/config", search: "", contentType: "application/json", body: new TextEncoder().encode(body), actor })
  const log: string[] = []
  const round = () => Replay.once({ redis, store, secret, log: (line) => log.push(line) })

  beforeAll(async () => {
    await db`DROP TABLE IF EXISTS platform_write_log, auth_migration`
    await Postgres.migrate(db, PlatformWrite.migrations)
  })
  afterAll(async () => {
    await db`DROP TABLE IF EXISTS platform_write_log, auth_migration`
    redis.close()
    db.close()
  })

  test("a layer that missed writes gets them in order, and a current one gets nothing", async () => {
    await redis.del("platform-applied")
    await redis.del("platform-trimmed")
    const [a, b] = [[], []] as string[][]
    const servers = [layer(a), layer(b)]
    for (const [index, id] of ["a", "b"].entries())
      await RuntimeRegistry.register(redis, { id, url: `http://127.0.0.1:${servers[index]!.port}`, version: "1" })
    try {
      await round()
      const first = await write('{"one":1}')
      await store.accept(first)
      await RuntimeRegistry.recordPlatformWrite(redis, first, await store.before(first), ["a"])
      const second = await write('{"two":2}')
      await store.accept(second)
      // b took the second write but missed the first, so it is still behind.
      await RuntimeRegistry.recordPlatformWrite(redis, second, await store.before(second), ["a", "b"])
      expect([await RuntimeRegistry.platformApplied(redis, "a"), await RuntimeRegistry.platformApplied(redis, "b")]).toEqual([second, 0])

      await round()
      expect(a).toEqual([])
      expect(b).toEqual(['PATCH /api/experimental/config {"one":1} usr_a', 'PATCH /api/experimental/config {"two":2} usr_a'])
      expect(await RuntimeRegistry.platformApplied(redis, "b")).toBe(second)
      await round()
      expect(b).toHaveLength(2)
    } finally {
      servers.forEach((server) => server.stop(true))
      for (const id of ["a", "b"]) await RuntimeRegistry.deregister(redis, id)
    }
  })

  test("a layer the gateway never recorded replays the log from its start", async () => {
    await redis.del("platform-applied")
    await db`DELETE FROM platform_write_log`
    const received: string[] = []
    const up = layer(received)
    await RuntimeRegistry.register(redis, { id: "n", url: `http://127.0.0.1:${up.port}`, version: "1" })
    try {
      // Written while nobody was watching this layer; when it shows up it still gets everything.
      for (const body of ['{"one":1}', '{"two":2}']) await store.accept(await write(body))
      await round()
      expect(received).toEqual(['PATCH /api/experimental/config {"one":1} usr_a', 'PATCH /api/experimental/config {"two":2} usr_a'])
    } finally {
      up.stop(true)
      await RuntimeRegistry.deregister(redis, "n")
    }
  })

  test("a layer that is down stays where it was; a write nobody took leaves nothing behind", async () => {
    await redis.del("platform-applied")
    await db`DELETE FROM platform_write_log`
    const received: string[] = []
    const up = layer(received)
    await RuntimeRegistry.register(redis, { id: "c", url: `http://127.0.0.1:${up.port}`, version: "1" })
    await RuntimeRegistry.markPlatformApplied(redis, "c", 0)
    try {
      const refused = await write('{"nobody":true}')
      await store.discard(refused)
      expect(await store.latest()).toBe(0)

      const kept = await write('{"kept":true}')
      await store.accept(kept)
      up.stop(true)
      await round()
      expect(await RuntimeRegistry.platformApplied(redis, "c")).toBe(0)
    } finally {
      await RuntimeRegistry.deregister(redis, "c")
    }
  })

  test("a layer behind trimmed writes is reported, not skipped", async () => {
    await redis.del("platform-applied")
    log.length = 0
    await RuntimeRegistry.register(redis, { id: "d", url: "http://127.0.0.1:1", version: "1" })
    await RuntimeRegistry.markPlatformApplied(redis, "d", 1)
    await RuntimeRegistry.markPlatformTrimmed(redis, 5)
    const newest = await write('{"x":1}')
    await store.accept(newest)
    await round()
    expect(log.some((line) => line.includes("layer d is behind"))).toBe(true)
    await RuntimeRegistry.deregister(redis, "d")
    await redis.del("platform-trimmed")
  })

  test("trimming keeps recent and the newest entries", async () => {
    await db`DELETE FROM platform_write_log`
    const seqs = [await write("1"), await write("2")]
    expect(await store.trim()).toBe(0)
    expect((await store.after(0, 10)).length).toBe(0)
    for (const seq of seqs) await store.accept(seq)
    expect((await store.after(0, 10)).map((entry) => entry.seq)).toEqual(seqs)
  })
})

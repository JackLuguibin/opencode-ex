import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Postgres } from "@opencode/util/postgres"
import { Redis } from "../src/redis.js"
import { Placement } from "@opencode/util/placement"
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

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Postgres } from "@opencode/util/postgres"
import { Redis } from "../src/redis.js"
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

describe.skipIf(!redisURL)("runtime registry", () => {
  const redis = Redis.connect(redisURL!)
  beforeAll(async () => {
    for (const runtime of await RuntimeRegistry.list(redis)) await RuntimeRegistry.deregister(redis, runtime.id)
  })
  afterAll(() => redis.close())

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
    expect((await RuntimeRegistry.runtimeFor(redis, undefined))?.id).toBe("m")
    await RuntimeRegistry.heartbeat(redis, "m", 1)
    await RuntimeRegistry.heartbeat(redis, "n", 9)
    expect((await RuntimeRegistry.runtimeFor(redis, undefined))?.id).toBe("m")
    await RuntimeRegistry.drain(redis, "m")
    expect((await RuntimeRegistry.runtimeFor(redis, undefined))?.id).toBe("n")
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
    await redis.del("organization-runtime")
    await RuntimeRegistry.register(redis, { id: "x", url: "http://x", version: "1" })
    await RuntimeRegistry.register(redis, { id: "y", url: "http://y", version: "1" })
    await RuntimeRegistry.heartbeat(redis, "x", 1)
    await RuntimeRegistry.heartbeat(redis, "y", 3)
    expect((await RuntimeRegistry.runtimeFor(redis, "org_a"))?.id).toBe("x")
    await RuntimeRegistry.heartbeat(redis, "x", 9)
    expect((await RuntimeRegistry.runtimeFor(redis, "org_a"))?.id).toBe("x")
    expect((await RuntimeRegistry.runtimeFor(redis, "org_b"))?.id).toBe("y")
    expect((await RuntimeRegistry.runtimeFor(redis, "org_c"))?.id).toBe("y")
    await RuntimeRegistry.deregister(redis, "x")
    expect(await RuntimeRegistry.runtimeFor(redis, "org_a")).toBeUndefined()
    await RuntimeRegistry.deregister(redis, "y")
    await redis.del("organization-runtime")
  })
})

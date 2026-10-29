import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Postgres } from "../src/postgres.js"
import { Redis } from "../src/redis.js"
import { Registry } from "../src/registry.js"

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

describe.skipIf(!redisURL)("registry", () => {
  const redis = Redis.connect(redisURL!)
  beforeAll(async () => {
    for (const runtime of await Registry.list(redis)) await Registry.deregister(redis, runtime.id)
  })
  afterAll(() => redis.close())

  test("picks the least loaded runtime and skips draining ones", async () => {
    await Registry.register(redis, { id: "a", url: "http://a", version: "1" })
    await Registry.register(redis, { id: "b", url: "http://b", version: "1" })
    await Registry.register(redis, { id: "c", url: "http://c", version: "1" })
    await Registry.heartbeat(redis, "a", 5)
    await Registry.heartbeat(redis, "b", 2)
    await Registry.heartbeat(redis, "c", 1)
    await Registry.drain(redis, "c")
    const runtimes = await Registry.list(redis)
    expect(runtimes.map((runtime) => runtime.id).sort()).toEqual(["a", "b", "c"])
    expect(Registry.pick(runtimes)?.id).toBe("b")
    for (const id of ["a", "b", "c"]) await Registry.deregister(redis, id)
    expect(Registry.pick(await Registry.list(redis))).toBeUndefined()
  })

  test("a runtime that stops heartbeating expires and cannot be revived by a late heartbeat", async () => {
    await Registry.register(redis, { id: "gone", url: "http://gone", version: "1" })
    await redis.pexpire("runtime:gone", 1)
    await Bun.sleep(20)
    expect(await Registry.heartbeat(redis, "gone", 1)).toBe(false)
    expect((await Registry.list(redis)).some((runtime) => runtime.id === "gone")).toBe(false)
  })
})

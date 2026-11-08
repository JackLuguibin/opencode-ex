import { describe, expect, test } from "bun:test"
import { KnowledgeRegistry } from "@opencode/util/knowledge-registry"
import { RedisConnection } from "@opencode/util/redis-connection"

// Needs a Redis of its own (database 15 of the one in OPENCODE_TEST_REDIS_URL); skipped when none is configured.
const url = process.env.OPENCODE_TEST_REDIS_URL
const run = url ? describe : describe.skip

run("knowledge registry", () => {
  const connect = () => RedisConnection.connect(url!)

  test("only one service holds the lease, and it can renew and release it", async () => {
    const redis = connect()
    await redis.del("knowledge:service")
    const first = { id: "knowledge_a", url: "http://a", version: "1" }
    const second = { id: "knowledge_b", url: "http://b", version: "1" }
    expect(await KnowledgeRegistry.claim(redis, first)).toBe(true)
    expect(await KnowledgeRegistry.claim(redis, second)).toBe(false)
    expect(await KnowledgeRegistry.lookup(redis)).toEqual(first)
    expect(await KnowledgeRegistry.renew(redis, "knowledge_a")).toBe(true)
    expect(await KnowledgeRegistry.renew(redis, "knowledge_b")).toBe(false)
    await KnowledgeRegistry.release(redis, "knowledge_b")
    expect(await KnowledgeRegistry.lookup(redis)).toEqual(first)
    await KnowledgeRegistry.release(redis, "knowledge_a")
    expect(await KnowledgeRegistry.lookup(redis)).toBeUndefined()
    expect(await KnowledgeRegistry.claim(redis, second)).toBe(true)
    await KnowledgeRegistry.release(redis, "knowledge_b")
  })
})

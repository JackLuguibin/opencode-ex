import { afterAll, describe, expect, test } from "bun:test"
import { RedisClient } from "bun"
import * as Presence from "../src/presence"

const url = process.env.OPENCODE_TEST_REDIS_URL

test("without Redis, viewers are kept in memory and expire", async () => {
  await Presence.touch("ses_memory", "usr_1", "8900", 1_000)
  await Presence.touch("ses_memory", "usr_2", "8902", 1_000)
  expect(await Presence.list("ses_memory", 2_000)).toEqual(["8900", "8902"])
  expect(await Presence.list("ses_memory", 1_000 + 46_000)).toEqual([])
})

describe.skipIf(!url)("presence on a shared redis", () => {
  const redis = new RedisClient(url!)
  afterAll(async () => {
    Presence.shared.redis = undefined
    await redis.del("presence:ses_shared")
    redis.close()
  })

  test("viewers are shared through Redis and expire", async () => {
    Presence.shared.redis = redis
    const now = Date.now()
    await redis.del("presence:ses_shared")
    await Presence.touch("ses_shared", "usr_1", "8902", now)
    await Presence.touch("ses_shared", "usr_2", "8900", now - 60_000)
    await Presence.touch("ses_shared", "usr_3", "8901", now - 1_000)
    expect(await Presence.list("ses_shared", now)).toEqual(["8901", "8902"])
  })
})

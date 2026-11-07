import { afterAll, describe, expect, setSystemTime, test } from "bun:test"
import { RedisClient } from "bun"
import * as Presence from "../src/presence"

const url = process.env.OPENCODE_TEST_REDIS_URL

test("without Redis, viewers are kept in memory and expire", async () => {
  await Presence.touch("ses_memory", "usr_1", "8900", 1_000)
  await Presence.touch("ses_memory", "usr_2", "8902", 1_000)
  expect(await Presence.list("ses_memory", 2_000)).toEqual(["8900", "8902"])
  expect(await Presence.list("ses_memory", 1_000 + 46_000)).toEqual([])
})

test("announces when someone arrives or a heartbeat lapses, not on every heartbeat", async () => {
  const notices: string[] = []
  const notify = () => notices.push("changed")
  setSystemTime(new Date(10_000_000))
  try {
    await Presence.touch("ses_announce", "usr_1", "8900", Date.now())
    await Presence.announce("ses_announce", notify)
    expect(notices.length).toBe(1)

    // The same viewer's next heartbeat changes nothing.
    await Presence.touch("ses_announce", "usr_1", "8900", Date.now())
    await Presence.announce("ses_announce", notify)
    expect(notices.length).toBe(1)

    await Presence.touch("ses_announce", "usr_2", "8902", Date.now())
    await Presence.announce("ses_announce", notify)
    expect(notices.length).toBe(2)

    // usr_2 keeps beating while usr_1 goes quiet; the check that follows the lapse reports the departure.
    setSystemTime(new Date(10_000_000 + 30_000))
    await Presence.touch("ses_announce", "usr_2", "8902", Date.now())
    setSystemTime(new Date(10_000_000 + 50_000))
    await Presence.announce("ses_announce", notify)
    expect(notices.length).toBe(3)
    expect(await Presence.list("ses_announce")).toEqual(["8902"])

    // The last viewer leaving is announced too.
    setSystemTime(new Date(10_000_000 + 120_000))
    await Presence.announce("ses_announce", notify)
    expect(notices.length).toBe(4)
  } finally {
    setSystemTime()
  }
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

import type { RedisClient } from "bun"

/**
 * Who has a session open right now. Viewers send a heartbeat while they look at it and drop out when it stops. With
 * Redis every execution layer sees the same viewers; without it (single process, TUI) they are kept in memory.
 */
const TTL = 45_000

const viewers = new Map<string, Map<string, { employeeID: string; seen: number }>>()

const key = (sessionID: string) => `presence:${sessionID}`

/** The shared store, set once the layer has connected to Redis. */
export const shared: { redis?: RedisClient } = {}

const known = new Map<string, { viewers: string; timer?: ReturnType<typeof setTimeout> }>()

/**
 * Calls `notify` when the viewers of a session differ from the last time it was asked, and asks again once the
 * oldest heartbeat can have lapsed, so a viewer who just closed the tab disappears without anyone polling.
 */
export async function announce(sessionID: string, notify: () => void) {
  const current = (await list(sessionID)).join(",")
  const state = known.get(sessionID)
  if (state) clearTimeout(state.timer)
  if (current === "") known.delete(sessionID)
  else
    known.set(sessionID, {
      viewers: current,
      timer: setTimeout(() => void announce(sessionID, notify), TTL + 1_000),
    })
  known.get(sessionID)?.timer?.unref?.()
  if ((state?.viewers ?? "") !== current) notify()
}

export async function touch(sessionID: string, userID: string, employeeID: string, now = Date.now()) {
  const redis = shared.redis
  if (redis) {
    // Employee IDs are unique, so the member itself identifies the viewer; the score is when they were last seen.
    const stored = await redis
      .send("ZADD", [key(sessionID), String(now), employeeID])
      .then(() => redis.send("PEXPIRE", [key(sessionID), String(TTL * 2)]))
      .then(() => true)
      .catch(() => false)
    if (stored) return
  }
  const session = viewers.get(sessionID) ?? new Map()
  session.set(userID, { employeeID, seen: now })
  viewers.set(sessionID, session)
}

export async function list(sessionID: string, now = Date.now()) {
  const redis = shared.redis
  if (redis) {
    const found = await redis
      .send("ZREMRANGEBYSCORE", [key(sessionID), "-inf", String(now - TTL)])
      .then(() => redis.send("ZRANGEBYSCORE", [key(sessionID), String(now - TTL), "+inf"]))
      .then((members: unknown) => (members as string[]).toSorted())
      .catch(() => undefined)
    if (found) return found
  }
  const session = viewers.get(sessionID)
  if (!session) return []
  for (const [userID, viewer] of session) if (now - viewer.seen > TTL) session.delete(userID)
  if (session.size === 0) viewers.delete(sessionID)
  return [...session.values()].map((viewer) => viewer.employeeID).toSorted()
}

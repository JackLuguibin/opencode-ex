/**
 * Who has a session open right now. Viewers send a heartbeat while they look at it and drop out when it stops. It is
 * kept in memory, so it is per server process: fine for one node, and the thing to move to a shared store when more
 * than one serves the same sessions.
 */
const TTL = 45_000

const viewers = new Map<string, Map<string, { employeeID: string; seen: number }>>()

export function touch(sessionID: string, userID: string, employeeID: string, now = Date.now()) {
  const session = viewers.get(sessionID) ?? new Map()
  session.set(userID, { employeeID, seen: now })
  viewers.set(sessionID, session)
}

export function list(sessionID: string, now = Date.now()) {
  const session = viewers.get(sessionID)
  if (!session) return []
  for (const [userID, viewer] of session) if (now - viewer.seen > TTL) session.delete(userID)
  if (session.size === 0) viewers.delete(sessionID)
  return [...session.values()].map((viewer) => viewer.employeeID).toSorted()
}

export * as PresenceEvent from "./presence-event.js"

import { Event } from "./event.js"
import { SessionID } from "./session-id.js"

/** Who has a session open changed: someone arrived, or a heartbeat lapsed. Clients reread the viewers instead of polling. */
export const Changed = Event.ephemeral({
  type: "session.presence.changed",
  schema: { sessionID: SessionID },
})

export const Definitions = Event.inventory(Changed)

export * as ServerEvent from "./server-event.js"

import { Schema } from "effect"
import { Event } from "./event.js"

/** `resumed` is true when the stream picked up after the client's `Last-Event-ID` and nothing was missed. */
export const Connected = Event.ephemeral({ type: "server.connected", schema: { resumed: Schema.optional(Schema.Boolean) } })
export const Disposed = Event.ephemeral({ type: "global.disposed", schema: {} })

export const Definitions = Event.inventory(Connected, Disposed)

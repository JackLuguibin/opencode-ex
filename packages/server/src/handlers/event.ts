import { Event } from "@opencode/schema/event"
import { Identity } from "@opencode/core/identity"
import { Session } from "@opencode/core/session"
import type { OpenCodeEvent } from "@opencode/protocol/groups/event"
import { Effect, Stream } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { accessFor } from "../access"
import { Api } from "../api"
import { ServerAuth } from "../auth"
import { EventFeed } from "../event-feed"

export const EventHandler = HttpApiBuilder.group(Api, "server.event", (handlers) =>
  Effect.gen(function* () {
    const feed = yield* EventFeed.Service
    const identity = yield* Identity.Service
    const config = yield* ServerAuth.Config
    const sessions = yield* Session.Service

    // Events raised inside a location carry it. Some session events have none, so those are placed by their session.
    const scoped = (root: string) => {
      const known = new Map<string, boolean>()
      return (event: OpenCodeEvent) => {
        if (event.location) return Effect.succeed(EventFeed.within(root, event.location.directory))
        const sessionID = sessionIDOf(event)
        if (!sessionID) return Effect.succeed(false)
        const cached = known.get(sessionID)
        if (cached !== undefined) return Effect.succeed(cached)
        return sessions.get(Session.ID.make(sessionID)).pipe(
          Effect.map((info) => EventFeed.within(root, info.location.directory)),
          Effect.tap((inside) => Effect.sync(() => known.set(sessionID, inside))),
          Effect.catch(() => Effect.succeed(false)),
        )
      }
    }
    return handlers.handleRaw("event.subscribe", (ctx) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const access = yield* accessFor(request, config, identity)
        const root =
          access.kind === "user" && access.organizationID
            ? yield* identity.organizationRoot(access.organizationID)
            : undefined
        // Operators and platform admins see every event; other users only their organization's.
        const allow =
          access.kind === "operator" || (access.kind === "user" && access.admin)
            ? undefined
            : root
              ? scoped(root)
              : () => Effect.succeed(false)
        const connected = {
          id: Event.ID.create(),
          type: "server.connected",
          data: {},
        } as const
        const output = Stream.unwrap(
          feed
            .subscribe(ctx.query.types, allow)
            .pipe(Effect.map((live) => Stream.make(EventFeed.frame(connected)).pipe(Stream.concat(live)))),
        )
        const heartbeat = Stream.tick("15 seconds").pipe(Stream.map(() => ": heartbeat\n\n"))
        return HttpServerResponse.stream(
          output.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }), Stream.encodeText),
          {
            contentType: "text/event-stream",
            headers: {
              "Cache-Control": "no-cache, no-transform",
              "X-Accel-Buffering": "no",
              "X-Content-Type-Options": "nosniff",
            },
          },
        )
      }),
    )
  }),
)

function sessionIDOf(event: OpenCodeEvent) {
  const data: Record<string, unknown> = event.data
  return typeof data.sessionID === "string" ? data.sessionID : undefined
}

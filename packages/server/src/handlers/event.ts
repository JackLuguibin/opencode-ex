import { Event } from "@opencode/schema/event"
import { Identity } from "@opencode/core/identity"
import { Session } from "@opencode/core/session"
import type { OpenCodeEvent } from "@opencode/protocol/groups/event"
import { Effect, Stream } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { accessFor, type Access } from "../access"
import { canSee, visibilityEpoch } from "../visibility"
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
    const scoped = (root: string, access: Access) => {
      const known = new Map<string, boolean>()
      // Private sessions and sessions in private projects only reach their creator and the admins. Visibility can
      // change while a stream is open, so what is learned is only trusted briefly.
      const seen = new Map<string, { visible: boolean; at: number; epoch: number }>()
      const visible = (sessionID: string) => {
        const cached = seen.get(sessionID)
        if (cached && cached.epoch === visibilityEpoch() && Date.now() - cached.at < 5_000)
          return Effect.succeed(cached.visible)
        const epoch = visibilityEpoch()
        return Effect.gen(function* () {
          const id = Session.ID.make(sessionID)
          const info = yield* sessions.get(id)
          const project = yield* identity.projectAccess(info.projectID)
          const owner = yield* identity.sessionAccess(id)
          return (
            (!project || canSee(access, project.visibility, project.creatorUserID)) &&
            (!owner || canSee(access, owner.visibility, owner.creatorUserID))
          )
        }).pipe(
          Effect.catch(() => Effect.succeed(false)),
          Effect.tap((result) => Effect.sync(() => seen.set(sessionID, { visible: result, at: Date.now(), epoch }))),
        )
      }
      return (event: OpenCodeEvent) => {
        const sessionID = sessionIDOf(event)
        const inside = event.location
          ? Effect.succeed(EventFeed.within(root, event.location.directory))
          : !sessionID
            ? Effect.succeed(false)
            : known.has(sessionID)
              ? Effect.succeed(known.get(sessionID)!)
              : sessions.get(Session.ID.make(sessionID)).pipe(
                  Effect.map((info) => EventFeed.within(root, info.location.directory)),
                  Effect.tap((result) => Effect.sync(() => known.set(sessionID, result))),
                  Effect.catch(() => Effect.succeed(false)),
                )
        return inside.pipe(Effect.flatMap((ok) => (ok && sessionID ? visible(sessionID) : Effect.succeed(ok))))
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
              ? scoped(root, access)
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

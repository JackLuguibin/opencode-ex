import { Identity } from "@opencode/core/identity"
import { Instance } from "@opencode/core/instance/service"
import { Session } from "@opencode/core/session"
import { Effect, Layer } from "effect"
import { HttpRouter, HttpServerRequest } from "effect/http"
import { HttpApiMiddleware } from "effect/http-api"
import { LocationNotFoundError, InvalidRequestError, SessionNotFoundError } from "@opencode/protocol/errors"
import { accessFor, actingAs } from "../access"
import { ServerAuth } from "../auth"
import { locationErrors, sessionInfo, type LocationServices } from "../location"
import { requireOwnedProject } from "../owned-project"

export class SessionLocationMiddleware extends HttpApiMiddleware.Service<
  SessionLocationMiddleware,
  { provides: LocationServices }
>()("@opencode/HttpApiSessionLocation", {
  error: [InvalidRequestError, SessionNotFoundError, LocationNotFoundError],
}) {}

export const sessionLocationLayer = Layer.effect(
  SessionLocationMiddleware,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const instances = yield* Instance.Service
    const identity = yield* Identity.Service
    const config = yield* ServerAuth.Config

    return SessionLocationMiddleware.of((effect) =>
      Effect.gen(function* () {
        const route = yield* HttpRouter.RouteContext
        const request = yield* HttpServerRequest.HttpServerRequest
        const session = yield* sessionInfo(sessions, route.params.sessionID)
        const access = yield* accessFor(request, config, identity)
        yield* requireOwnedProject(session.projectID, session.id, access, identity)
        // Prompting, resuming or otherwise changing a session hands its runs to this user's credentials; merely
        // reading it, as when opening someone else's session, does not.
        if (access.kind === "user" && request.method !== "GET" && request.method !== "HEAD")
          yield* identity.touchSessionUser(session.id, access.userID)
        return yield* actingAs(effect, access).pipe(instances.provide(session), locationErrors)
      }),
    )
  }),
)

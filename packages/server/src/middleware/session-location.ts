import { Identity } from "@opencode/core/identity"
import { Instance } from "@opencode/core/instance/service"
import { Session } from "@opencode/core/session"
import { Effect, Layer } from "effect"
import { HttpRouter, HttpServerRequest } from "effect/http"
import { HttpApiMiddleware } from "effect/http-api"
import { LocationNotFoundError, InvalidRequestError, SessionNotFoundError } from "@opencode/protocol/errors"
import { accessFor } from "../access"
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
        return yield* effect.pipe(instances.provide(session), locationErrors)
      }),
    )
  }),
)

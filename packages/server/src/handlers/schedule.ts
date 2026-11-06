import { Permission } from "@opencode/core/permission"
import { Identity } from "@opencode/core/identity"
import { Schedule } from "@opencode/core/schedule"
import { Session } from "@opencode/core/session"
import { ForbiddenError, InvalidRequestError, ScheduleNotFoundError } from "@opencode/protocol/errors"
import type { CreatePayload } from "@opencode/protocol/groups/schedule"
import { Effect } from "effect"
import { HttpServerRequest } from "effect/http"
import { HttpApiSchema } from "effect/http-api"
import { accessFor } from "../access"
import { ServerAuth } from "../auth"
import { requireOwnedProject } from "../owned-project"
import { canManage } from "../visibility"
import { missingSession } from "./session-error"

/** `schedule.*` in the `server.experimental` group. Every route needs experimental.schedules where the Session lives. */
export const makeSchedule = Effect.gen(function* () {
  const schedules = yield* Schedule.Service
  const sessions = yield* Session.Service
  const identity = yield* Identity.Service
  const config = yield* ServerAuth.Config

  // The authorization middleware only checks routes that carry the session in their path, and schedule routes carry it
  // in the query, the payload or not at all, so apply the same rule here: the caller must be able to see the session,
  // and to manage it (its creator or an admin) to change what wakes it.
  const authorize = Effect.fnUntraced(function* (sessionID: Session.ID, manage: boolean) {
    const request = yield* HttpServerRequest.HttpServerRequest
    const access = yield* accessFor(request, config, identity)
    const session = yield* sessions.get(sessionID).pipe(Effect.catchTag("Session.NotFoundError", missingSession))
    yield* requireOwnedProject(session.projectID, session.id, access, identity)
    if (!manage || access.kind !== "user") return
    const owner = yield* identity.sessionAccess(session.id)
    if (!canManage(access, owner?.creatorUserID))
      return yield* new ForbiddenError({ message: "Only the session's creator or an admin can do this" })
  })

  const allowed = (sessionID: Session.ID, manage = false) =>
    authorize(sessionID, manage).pipe(
      Effect.andThen(
        schedules.enabled(sessionID).pipe(
          Effect.mapError(missingSession),
          Effect.flatMap((enabled) => (enabled ? Effect.void : Effect.fail(disabled()))),
        ),
      ),
    )

  // A schedule whose Session is gone, or whose location has the flag off, reads as missing or forbidden like the rest.
  const find = (id: Schedule.ID, manage = false) =>
    Effect.gen(function* () {
      const info = yield* schedules.get(id).pipe(Effect.mapError(missingSchedule))
      if (info.sessionID === undefined) return yield* missingSchedule({ scheduleID: id })
      yield* allowed(info.sessionID, manage).pipe(
        Effect.catchTag("SessionNotFoundError", () => Effect.fail(missingSchedule({ scheduleID: id }))),
      )
      return info
    })

  return {
    create: (payload: CreatePayload) =>
      authorize(payload.sessionID, true).pipe(
        // Stateless HTTP callers have no guaranteed UI listener to answer an interactive ask, so settle asks unattended.
        Effect.andThen(schedules.create(Schedule.toCreateInput(payload.sessionID, payload))),
        Effect.provideService(Permission.Unattended, []),
        Effect.map((data) => ({ data })),
        Effect.catchTags({
          "Schedule.InvalidError": (error) =>
            Effect.fail(new InvalidRequestError({ message: error.message, kind: "schedule" })),
          "Schedule.DisabledError": () => Effect.fail(disabled()),
          "Permission.BlockedError": (error) => Effect.fail(new ForbiddenError({ message: error.message })),
          "Permission.CorrectedError": (error) => Effect.fail(new ForbiddenError({ message: error.feedback })),
          "Session.NotFoundError": (error) => Effect.fail(missingSession(error)),
        }),
      ),
    list: (sessionID: Session.ID) =>
      allowed(sessionID).pipe(
        Effect.andThen(schedules.list({ sessionID })),
        Effect.map((data) => ({ data })),
      ),
    get: (id: Schedule.ID) => find(id).pipe(Effect.map((data) => ({ data }))),
    pause: (id: Schedule.ID) =>
      find(id, true).pipe(
        Effect.andThen(schedules.pause(id).pipe(Effect.mapError(missingSchedule))),
        Effect.map((data) => ({ data })),
      ),
    resume: (id: Schedule.ID) =>
      find(id, true).pipe(
        Effect.andThen(schedules.resume(id).pipe(Effect.mapError(missingSchedule))),
        Effect.map((data) => ({ data })),
      ),
    remove: (id: Schedule.ID) =>
      find(id, true).pipe(
        Effect.andThen(schedules.remove(id).pipe(Effect.mapError(missingSchedule))),
        Effect.as(HttpApiSchema.NoContent.make()),
      ),
  }
})

function missingSchedule(error: { readonly scheduleID: Schedule.ID }) {
  return new ScheduleNotFoundError({ scheduleID: error.scheduleID, message: `Schedule not found: ${error.scheduleID}` })
}

function disabled() {
  return new ForbiddenError({ message: new Schedule.DisabledError().message })
}

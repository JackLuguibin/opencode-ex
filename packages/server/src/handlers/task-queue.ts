import { Identity } from "@opencode/core/identity"
import { Project } from "@opencode/core/project"
import { Session } from "@opencode/core/session"
import { TaskQueue } from "@opencode/core/task-queue"
import { ConflictError, ForbiddenError, InvalidRequestError, TaskQueueNotFoundError } from "@opencode/protocol/errors"
import { Effect } from "effect"
import path from "node:path"
import { HttpServerRequest } from "effect/http"
import { HttpApiSchema } from "effect/http-api"
import { accessFor } from "../access"
import { ServerAuth } from "../auth"
import { requireOwnedDirectory, requireOwnedProject } from "../owned-project"
import { canManage } from "../visibility"
import { missingSession } from "./session-error"

/** `taskQueue.*` in the `server.experimental` group. */
export const makeTaskQueue = Effect.gen(function* () {
  const queues = yield* TaskQueue.Service
  const sessions = yield* Session.Service
  const projects = yield* Project.Service
  const identity = yield* Identity.Service
  const config = yield* ServerAuth.Config

  const accessOf = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    return yield* accessFor(request, config, identity)
  })

  // A queue belongs to the member who made it, and runs sessions as them: other members never see it, not even when the
  // session it feeds is shared. The admins of the organization it was made in may see and manage it, and platform
  // admins every queue.
  const authorize = Effect.fnUntraced(function* (info: TaskQueue.Info) {
    const access = yield* accessOf
    if (access.kind === "operator") return
    if (access.kind !== "user") return yield* missingQueue({ queueID: info.id })
    if (access.admin) return
    if (info.organizationID !== access.organizationID) return yield* missingQueue({ queueID: info.id })
    if (access.organizationAdmin || (!!info.userID && info.userID === access.userID)) return
    return yield* missingQueue({ queueID: info.id })
  })

  const find = (id: TaskQueue.ID) =>
    Effect.gen(function* () {
      const info = yield* queues.get(id).pipe(Effect.mapError(missingQueue))
      yield* authorize(info)
      return info
    })

  // The target must be somewhere the caller may work: a Session they manage, or a folder inside their organization.
  // The shared space is everyone's, so a queue there would run one member's prompts in a place all of them can see.
  const authorizeTarget = Effect.fnUntraced(function* (target: { sessionID?: Session.ID; directory?: string }) {
    const access = yield* accessOf
    const directory = yield* Effect.gen(function* () {
      if (target.sessionID === undefined) return target.directory
      const session = yield* sessions
        .get(target.sessionID)
        .pipe(Effect.catchTag("Session.NotFoundError", missingSession))
      yield* requireOwnedProject(session.projectID, session.id, access, identity)
      if (access.kind === "user") {
        const owner = yield* identity.sessionAccess(session.id)
        if (!canManage(access, owner?.creatorUserID))
          return yield* new ForbiddenError({ message: "Only the session's creator or an admin can do this" })
      }
      return session.location.directory
    })
    if (target.directory !== undefined) yield* requireOwnedDirectory(target.directory, access, projects, identity)
    if (directory === undefined || access.kind !== "user" || !access.organizationID) return
    const shared = path.relative(
      yield* identity.organizationSharedDirectory(access.organizationID),
      path.resolve(directory),
    )
    if (shared === "" || !(shared.startsWith("..") || path.isAbsolute(shared)))
      return yield* new ForbiddenError({ message: "The shared space cannot be a queue target" })
  })

  const invalid = (error: { readonly message: string }) =>
    Effect.fail(new InvalidRequestError({ message: error.message, kind: "taskQueue" }))

  return {
    create: (payload: TaskQueue.CreateInput) =>
      Effect.gen(function* () {
        yield* authorizeTarget(payload)
        const access = yield* accessOf
        const data = yield* queues.create(
          payload,
          access.kind === "user" ? { userID: access.userID, organizationID: access.organizationID } : undefined,
        )
        return { data }
      }).pipe(
        Effect.catchTags({
          "TaskQueue.InvalidError": invalid,
          "Session.NotFoundError": (error) => Effect.fail(missingSession(error)),
        }),
      ),
    list: (sessionID?: Session.ID) =>
      Effect.gen(function* () {
        const all = yield* queues.list(sessionID === undefined ? undefined : { sessionID })
        const data = yield* Effect.filter(all, (info) =>
          authorize(info).pipe(
            Effect.as(true),
            Effect.catch(() => Effect.succeed(false)),
          ),
        )
        return { data }
      }),
    get: (id: TaskQueue.ID) => find(id).pipe(Effect.map((data) => ({ data }))),
    update: (id: TaskQueue.ID, payload: TaskQueue.UpdateInput) =>
      Effect.gen(function* () {
        yield* find(id)
        yield* authorizeTarget(payload)
        return { data: yield* queues.update(id, payload) }
      }).pipe(
        Effect.catchTags({
          "TaskQueue.NotFoundError": (error) => Effect.fail(missingQueue(error)),
          "TaskQueue.InvalidError": invalid,
          "Session.NotFoundError": (error) => Effect.fail(missingSession(error)),
        }),
      ),
    pause: (id: TaskQueue.ID) =>
      find(id).pipe(
        Effect.andThen(queues.pause(id).pipe(Effect.mapError(missingQueue))),
        Effect.map((data) => ({ data })),
      ),
    resume: (id: TaskQueue.ID) =>
      find(id).pipe(
        Effect.andThen(queues.resume(id).pipe(Effect.mapError(missingQueue))),
        Effect.map((data) => ({ data })),
      ),
    remove: (id: TaskQueue.ID) =>
      find(id).pipe(
        Effect.andThen(queues.remove(id).pipe(Effect.mapError(missingQueue))),
        Effect.as(HttpApiSchema.NoContent.make()),
      ),
    items: (id: TaskQueue.ID) =>
      find(id).pipe(
        Effect.andThen(queues.items(id).pipe(Effect.mapError(missingQueue))),
        Effect.map((data) => ({ data })),
      ),
    enqueue: (id: TaskQueue.ID, payload: TaskQueue.EnqueueInput) =>
      find(id).pipe(
        Effect.andThen(queues.enqueue(id, payload)),
        Effect.map((data) => ({ data })),
        Effect.catchTags({
          "TaskQueue.NotFoundError": (error) => Effect.fail(missingQueue(error)),
          "TaskQueue.FullError": (error) => Effect.fail(new ConflictError({ message: error.message, resource: id })),
        }),
      ),
    cancel: (id: TaskQueue.ID, itemID: TaskQueue.ItemID) =>
      find(id).pipe(
        Effect.andThen(queues.cancel(id, itemID)),
        Effect.as(HttpApiSchema.NoContent.make()),
        Effect.catchTags({
          "TaskQueue.NotFoundError": (error) => Effect.fail(missingQueue(error)),
          "TaskQueue.ItemNotFoundError": (error) =>
            Effect.fail(new TaskQueueNotFoundError({ id: error.itemID, message: error.message })),
          "TaskQueue.InvalidError": invalid,
        }),
      ),
    clear: (id: TaskQueue.ID) =>
      find(id).pipe(
        Effect.andThen(queues.clear(id).pipe(Effect.mapError(missingQueue))),
        Effect.as(HttpApiSchema.NoContent.make()),
      ),
  }
})

function missingQueue(error: { readonly queueID: TaskQueue.ID }) {
  return new TaskQueueNotFoundError({ id: error.queueID, message: `Queue not found: ${error.queueID}` })
}

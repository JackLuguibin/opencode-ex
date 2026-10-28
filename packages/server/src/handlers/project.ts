import { realpath, rm } from "node:fs/promises"
import path from "node:path"
import { Database } from "@opencode/core/database/database"
import { Identity } from "@opencode/core/identity"
import { Project } from "@opencode/core/project"
import { ProjectRemoval } from "@opencode/core/project/removal"
import { Session } from "@opencode/core/session"
import { Effect } from "effect"
import { HttpServerRequest } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../api"
import { accessFor } from "../access"
import { ServerAuth } from "../auth"
import { InvalidRequestError, ProjectNotFoundError } from "@opencode/protocol/errors"

/** Where a project folder sits relative to its organization's directory. */
const organizationSpace = Effect.fnUntraced(function* (
  identity: Identity.Interface,
  organizationID: string,
  worktree: string,
) {
  // Project folders are stored resolved, so compare real paths: the data directory can sit behind a symlink.
  const real = (input: string) => Effect.promise(() => realpath(input).catch(() => path.resolve(input)))
  const defaultDirectory = yield* real(yield* identity.organizationDirectory(organizationID))
  const root = yield* real(yield* identity.organizationRoot(organizationID))
  const target = yield* real(worktree)
  if (target === defaultDirectory) return "default" as const
  const relative = path.relative(root, target)
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return "inside" as const
  return "outside" as const
})

const missing = (projectID: Project.ID) =>
  new ProjectNotFoundError({ projectID, message: `Project not found: ${projectID}` })

export const ProjectHandler = HttpApiBuilder.group(Api, "server.project", (handlers) =>
  Effect.gen(function* () {
    const project = yield* Project.Service
    const identity = yield* Identity.Service
    const config = yield* ServerAuth.Config
    const db = (yield* Database.Service).db
    const sessions = yield* Session.Service
    return handlers
      .handle("project.list", (ctx) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const access = yield* accessFor(request, config, identity)
          const listed = yield* project.list(ctx.query)
          if (access.kind === "operator") return listed
          if (access.kind !== "user" || !access.organizationID) return []
          const inOrganization = yield* identity.projectIDs(access.organizationID)
          return listed.filter((item) => inOrganization.has(item.id))
        }),
      )
      .handle("project.remove", (ctx) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const access = yield* accessFor(request, config, identity)
          const projectID = ctx.params.projectID
          if (access.kind === "user") {
            if (!access.organizationID) return yield* missing(projectID)
            const allowed = yield* identity.claimOrAllow(projectID, {
              userID: access.userID,
              organizationID: access.organizationID,
            })
            if (!allowed) return yield* missing(projectID)
          }
          if (access.kind === "unset") return yield* missing(projectID)
          const row = yield* ProjectRemoval.describe(db, projectID)
          if (!row) return yield* missing(projectID)
          const space = row.organizationID ? yield* organizationSpace(identity, row.organizationID, row.worktree) : undefined
          if (space === "default")
            return yield* new InvalidRequestError({
              message: "The organization's default directory can't be deleted",
              field: "projectID",
            })

          yield* ProjectRemoval.remove(db, sessions, project, projectID)
          // Only folders the organization owns are deleted from disk. Anything else, such as a repository that was
          // opened from elsewhere before organizations existed, is just forgotten.
          if (space !== "inside") return { files: false }
          yield* Effect.promise(() => rm(row.worktree, { recursive: true, force: true }))
          return { files: true }
        }),
      )
      .handle("project.update", (ctx) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const access = yield* accessFor(request, config, identity)
          if (access.kind === "user") {
            if (!access.organizationID) return yield* missing(ctx.params.projectID)
            const allowed = yield* identity.claimOrAllow(ctx.params.projectID, {
              userID: access.userID,
              organizationID: access.organizationID,
            })
            if (!allowed) return yield* missing(ctx.params.projectID)
          }
          return yield* project.update({ ...ctx.payload, projectID: ctx.params.projectID }).pipe(
            Effect.mapError(() => missing(ctx.params.projectID)),
          )
        }),
      )
  }),
)

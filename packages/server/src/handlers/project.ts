import { Identity } from "@opencode/core/identity"
import { Project } from "@opencode/core/project"
import { Effect } from "effect"
import { HttpServerRequest } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../api"
import { accessFor } from "../access"
import { ServerAuth } from "../auth"
import { ProjectNotFoundError } from "@opencode/protocol/errors"

const missing = (projectID: Project.ID) =>
  new ProjectNotFoundError({ projectID, message: `Project not found: ${projectID}` })

export const ProjectHandler = HttpApiBuilder.group(Api, "server.project", (handlers) =>
  Effect.gen(function* () {
    const project = yield* Project.Service
    const identity = yield* Identity.Service
    const config = yield* ServerAuth.Config
    return handlers
      .handle("project.list", (ctx) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const access = yield* accessFor(request, config, identity)
          const listed = yield* project.list(ctx.query)
          if (access.kind === "operator") return listed
          if (access.kind !== "user" || !access.organizationID) return []
          const owned = yield* identity.ownedIDs({ userID: access.userID, organizationID: access.organizationID })
          return listed.filter((item) => owned.has(item.id))
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

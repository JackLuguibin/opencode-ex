import { Credential } from "@opencode/core/credential"
import { Identity } from "@opencode/core/identity"
import { ConflictError } from "@opencode/protocol/errors"
import { Effect } from "effect"
import { HttpServerRequest } from "effect/http"
import { HttpApiBuilder, HttpApiSchema } from "effect/http-api"
import { Api } from "../api"
import { accessFor } from "../access"
import { ServerAuth } from "../auth"

export const CredentialHandler = HttpApiBuilder.group(Api, "server.credential", (handlers) =>
  Effect.gen(function* () {
    const identity = yield* Identity.Service
    const config = yield* ServerAuth.Config
    // Users manage their organization's credentials; the operator manages the ones that belong to no organization.
    const scopeOf = Effect.fnUntraced(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const access = yield* accessFor(request, config, identity)
      if (access.kind === "operator") return { organizationID: null } satisfies Credential.Scope
      if (access.kind === "user" && access.organizationID)
        return { organizationID: access.organizationID } satisfies Credential.Scope
    })
    return handlers
      .handle(
        "credential.list",
        Effect.fn(function* () {
          const credential = yield* Credential.Service
          const scope = yield* scopeOf()
          if (!scope) return { data: [] }
          return { data: entries(yield* credential.all(scope)) }
        }),
      )
      .handle(
        "credential.create",
        Effect.fn(function* (ctx) {
          const credential = yield* Credential.Service
          const scope = yield* scopeOf()
          if (!scope) return yield* new ConflictError({ resource: "organization", message: "No organization selected" })
          if (ctx.payload.id && (yield* credential.get(ctx.payload.id)))
            return yield* new ConflictError({
              resource: ctx.payload.id,
              message: `Credential already exists: ${ctx.payload.id}`,
            })
          const created = yield* credential.create({ ...ctx.payload, scope })
          const entry = entries(yield* credential.list(created.integrationID, scope)).find(
            (item) => item.id === created.id,
          )
          return { data: entry ?? { ...created, active: false } }
        }),
      )
      .handle(
        "credential.update",
        Effect.fn(function* (ctx) {
          const credential = yield* Credential.Service
          const scope = yield* scopeOf()
          if (scope) yield* credential.update(ctx.params.credentialID, { label: ctx.payload.label }, scope)
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "credential.activate",
        Effect.fn(function* (ctx) {
          const credential = yield* Credential.Service
          const scope = yield* scopeOf()
          if (scope) yield* credential.activate(ctx.params.credentialID, scope)
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "credential.remove",
        Effect.fn(function* (ctx) {
          const credential = yield* Credential.Service
          const scope = yield* scopeOf()
          if (scope) yield* credential.remove(ctx.params.credentialID, scope)
          return HttpApiSchema.NoContent.make()
        }),
      )
  }),
)

// Credential listings order each integration's selected credential last.
function entries(credentials: Credential.Info[]) {
  const selected = new Map(credentials.map((item) => [item.integrationID, item.id]))
  return credentials.map((item) => ({
    id: item.id,
    integrationID: item.integrationID,
    label: item.label,
    active: selected.get(item.integrationID) === item.id,
    value: item.value,
  }))
}

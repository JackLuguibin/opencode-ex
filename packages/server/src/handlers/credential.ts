import { Credential } from "@opencode/core/credential"
import { Identity } from "@opencode/core/identity"
import { ModelPreference } from "@opencode/core/model-preference"
import { Integration } from "@opencode/schema/integration"
import { ConflictError, ForbiddenError } from "@opencode/protocol/errors"
import { Effect } from "effect"
import { HttpServerRequest } from "effect/http"
import { HttpApiBuilder, HttpApiSchema } from "effect/http-api"
import { Api } from "../api"
import { accessFor } from "../access"
import { ServerAuth } from "../auth"
import { customProvider } from "../custom-provider"

export const CredentialHandler = HttpApiBuilder.group(Api, "server.credential", (handlers) =>
  Effect.gen(function* () {
    const identity = yield* Identity.Service
    const config = yield* ServerAuth.Config
    // Admins manage their organization's shared credentials and members their own; the operator manages the ones that belong to no organization.
    const scopeOf = Effect.fnUntraced(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const access = yield* accessFor(request, config, identity)
      if (access.kind === "operator") return { organizationID: null } satisfies Credential.Scope
      if (access.kind === "user" && access.organizationID)
        return {
          organizationID: access.organizationID,
          userID: access.userID,
          admin: access.organizationAdmin,
          // Members manage their own credentials here; the organization's shared ones, and their secrets, stay with admins.
          ownOnly: !access.organizationAdmin,
        } satisfies Credential.Scope
    })
    // Members change only their own credentials; the organization's shared ones belong to admins.
    const requireManage = Effect.fnUntraced(function* (
      credential: Credential.Interface,
      id: Credential.ID,
      scope: Credential.Scope | undefined,
    ) {
      // A credential that does not exist has nothing to protect; the write itself is a no-op.
      if (!scope || !(yield* credential.get(id))) return
      const owned = yield* credential.all({ ...scope, ownOnly: true })
      if (owned.some((item) => item.id === id)) return
      if ((scope.admin ?? true) && (yield* credential.get(id, scope))) return
      return yield* new ForbiddenError({ message: "Only an admin can change the organization's credentials" })
    })
    return handlers
      .handle(
        "credential.list",
        Effect.fn(function* () {
          const credential = yield* Credential.Service
          const scope = yield* scopeOf()
          if (!scope) return { data: [] }
          return { data: yield* present(credential, scope) }
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
          // A credential is personal unless an admin stores it for the organization.
          const shared = ctx.payload.scope === "organization"
          if (shared && scope.userID !== undefined && !(scope.admin ?? true))
            return yield* new ForbiddenError({ message: "Only an admin can store a credential for the organization" })
          const { scope: _requested, ...input } = ctx.payload
          const created = yield* credential.create({ ...input, scope: { ...scope, admin: shared } })
          const entry = (yield* present(credential, scope)).find((item) => item.id === created.id)
          return { data: entry ?? { ...created, active: false, scope: shared ? ("organization" as const) : ("personal" as const) } }
        }),
      )
      .handle(
        "credential.update",
        Effect.fn(function* (ctx) {
          const credential = yield* Credential.Service
          const scope = yield* scopeOf()
          yield* requireManage(credential, ctx.params.credentialID, scope)
          if (scope) yield* credential.update(ctx.params.credentialID, { label: ctx.payload.label }, scope)
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "credential.activate",
        Effect.fn(function* (ctx) {
          const credential = yield* Credential.Service
          const scope = yield* scopeOf()
          yield* requireManage(credential, ctx.params.credentialID, scope)
          if (scope) yield* credential.activate(ctx.params.credentialID, scope)
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "credential.remove",
        Effect.fn(function* (ctx) {
          const credential = yield* Credential.Service
          const scope = yield* scopeOf()
          yield* requireManage(credential, ctx.params.credentialID, scope)
          if (scope) yield* credential.remove(ctx.params.credentialID, scope)
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "modelPreference.get",
        Effect.fn(function* () {
          const preferences = yield* ModelPreference.Service
          const scope = yield* scopeOf()
          return { data: scope ? yield* preferences.read(scope) : { hidden: [], shown: [], favorite: [], recent: [] } }
        }),
      )
      .handle(
        "modelPreference.update",
        Effect.fn(function* (ctx) {
          const preferences = yield* ModelPreference.Service
          const scope = yield* scopeOf()
          if (!scope) return { data: { hidden: [], shown: [], favorite: [], recent: [] } }
          yield* preferences.write(ctx.payload, scope)
          return { data: yield* preferences.read(scope) }
        }),
      )
      .handle(
        "customProvider.list",
        Effect.fn(function* () {
          const credential = yield* Credential.Service
          const scope = yield* scopeOf()
          if (!scope?.userID) return { data: [] }
          return { data: (yield* credential.personalProviders(scope)).map((item) => presentProvider(scope.userID!, item)) }
        }),
      )
      .handle(
        "customProvider.save",
        Effect.fn(function* (ctx) {
          const credential = yield* Credential.Service
          const scope = yield* scopeOf()
          if (!scope?.userID || scope.organizationID === null)
            return yield* new ConflictError({ resource: "organization", message: "No organization selected" })
          const provider = yield* customProvider(ctx.params.providerID, ctx.payload)
          yield* credential.savePersonalProvider(scope.organizationID, scope.userID, provider)
          const key = ctx.payload.key?.trim()
          if (key)
            yield* credential.create({
              integrationID: Integration.ID.make(Credential.personalID(scope.userID, provider.id)),
              value: Credential.Key.make({ type: "key", key }),
              label: provider.name,
              scope: { ...scope, admin: false },
            })
          return { data: presentProvider(scope.userID, provider) }
        }),
      )
      .handle(
        "customProvider.remove",
        Effect.fn(function* (ctx) {
          const credential = yield* Credential.Service
          const scope = yield* scopeOf()
          if (scope?.userID && scope.organizationID !== null)
            yield* credential.removePersonalProvider(scope.organizationID, scope.userID, ctx.params.providerID)
          return HttpApiSchema.NoContent.make()
        }),
      )
  }),
)

// Credential listings order each integration's selected credential last. Selection is per owner, so the selected one
// is worked out for the organization's credentials and the member's own separately.
const present = Effect.fnUntraced(function* (credential: Credential.Interface, scope: Credential.Scope) {
  const all = yield* credential.all(scope)
  const own = new Set(scope.userID === undefined ? [] : (yield* credential.all({ ...scope, ownOnly: true })).map((item) => item.id))
  const selected = new Map(
    all.map((item) => [`${item.integrationID}:${own.has(item.id) ? "personal" : "organization"}`, item.id]),
  )
  return all.map((item) => {
    const kind = own.has(item.id) ? ("personal" as const) : ("organization" as const)
    return {
      id: item.id,
      integrationID: item.integrationID,
      label: item.label,
      active: selected.get(`${item.integrationID}:${kind}`) === item.id,
      value: item.value,
      scope: kind,
    }
  })
})

const presentProvider = (userID: string, provider: Credential.CustomProvider) => ({
  id: provider.id,
  providerID: Credential.personalID(userID, provider.id),
  name: provider.name,
  baseURL: provider.baseURL,
  models: provider.models,
})

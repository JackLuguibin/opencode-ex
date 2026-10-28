import { Credential } from "@opencode/core/credential"
import { GlobalPackage } from "@opencode/core/global-package"
import { SharedMcp } from "@opencode/core/shared-mcp"
import { Identity } from "@opencode/core/identity"
import { Integration } from "@opencode/core/integration"
import { ForbiddenError, InvalidRequestError, UnauthorizedError } from "@opencode/protocol/errors"
import { Effect } from "effect"
import { HttpServerRequest } from "effect/http"
import { HttpApiBuilder, HttpApiSchema } from "effect/http-api"
import { accessFor } from "../access"
import { ServerAuth } from "../auth"
import { Api } from "../api"

const unauthorized = new UnauthorizedError({ message: "Authentication required" })

function sessionError(error: Identity.Rejected) {
  if (error.reason === "credentials") return unauthorized
  return new InvalidRequestError({ message: "Check the organization", field: "organizationID" })
}

function reject(error: Identity.Rejected) {
  if (error.reason === "forbidden") return new ForbiddenError({ message: "You don't have permission to do this" })
  if (error.reason === "missing")
    return new InvalidRequestError({ message: "Register this employee ID first", field: "employeeID" })
  if (error.reason === "taken")
    return new InvalidRequestError({ message: "That employee ID is already registered", field: "employeeID" })
  if (error.reason === "credentials") return unauthorized
  if (error.reason === "self") return new InvalidRequestError({ message: "You can't do this to your own account", kind: "self" })
  return new InvalidRequestError({ message: "Check the employee ID, password, or organization name" })
}

const present = Effect.fnUntraced(function* (account: Identity.Account, identity: Identity.Interface) {
  return {
    employeeID: account.employeeID,
    admin: account.admin,
    organizationAdmin: account.organizationAdmin,
    settingsPages: account.settingsPages,
    ...(account.organizationID
      ? {
          organizationID: account.organizationID,
          organizationDirectory: yield* identity.organizationRoot(account.organizationID),
        }
      : {}),
    organizations: account.organizations,
  }
})

const user = (config: ServerAuth.Info, identity: Identity.Interface) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const access = yield* accessFor(request, config, identity)
    if (access.kind !== "user") return yield* unauthorized
    return access
  })

const mcpError = (message: string) => new InvalidRequestError({ message })

const packageError = (message: string) => new InvalidRequestError({ message, field: "archive" })

const INTEGRATION_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i

/** Validates a custom provider definition from the admin console. */
const customProvider = Effect.fnUntraced(function* (
  id: string,
  input: { readonly name: string; readonly baseURL: string; readonly models: ReadonlyArray<string> },
) {
  const providerID = id.trim()
  if (!INTEGRATION_ID.test(providerID))
    return yield* new InvalidRequestError({ message: "Check the provider ID", field: "providerID" })
  const name = input.name.trim()
  if (!name || name.length > 80) return yield* new InvalidRequestError({ message: "Enter a name", field: "name" })
  const baseURL = input.baseURL.trim().replace(/\/+$/, "")
  const url = URL.canParse(baseURL) ? new URL(baseURL) : undefined
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:"))
    return yield* new InvalidRequestError({ message: "Enter an http or https base URL", field: "baseURL" })
  const models = [...new Set(input.models.map((model) => model.trim()).filter(Boolean))]
  if (models.length === 0 || models.length > 200 || models.some((model) => model.length > 200))
    return yield* new InvalidRequestError({ message: "Enter at least one model", field: "models" })
  return { id: providerID, name, baseURL, models } satisfies Credential.CustomProvider
})

function presentCredential(item: Credential.Info, active: boolean) {
  return {
    id: item.id,
    integrationID: item.integrationID,
    label: item.label,
    active,
    type: item.value.type,
  }
}

export const AuthHandler = HttpApiBuilder.group(Api, "server.auth", (handlers) =>
  Effect.gen(function* () {
    const identity = yield* Identity.Service
    const config = yield* ServerAuth.Config
    const signedIn = user(config, identity)
    const knownOrganizations = Effect.fnUntraced(function* (sessionID: string, ids: ReadonlyArray<string>) {
      const known = new Set((yield* identity.listOrganizations(sessionID).pipe(Effect.mapError(reject))).map((item) => item.id))
      if (ids.some((id) => !known.has(id)))
        return yield* new InvalidRequestError({ message: "Check the organizations", field: "organizations" })
      return ids
    })
    const platformAdmin = Effect.gen(function* () {
      const access = yield* signedIn
      if (!access.admin) return yield* new ForbiddenError({ message: "Only a platform admin can change global packages" })
      return access
    })
    const credentials = yield* Credential.Service
    const packages = yield* GlobalPackage.Service
    const sharedMcp = yield* SharedMcp.Service
    // The model credentials an organization shares are managed by its admins and by platform admins.
    const organizationCredentials = Effect.fnUntraced(function* (organizationID: string) {
      const access = yield* signedIn
      const allowed = yield* identity.canManageOrganization(access.sessionID, organizationID).pipe(Effect.mapError(reject))
      if (!allowed) return yield* new ForbiddenError({ message: "You don't have permission to do this" })
      const organizations = yield* identity.listOrganizations(access.sessionID).pipe(Effect.mapError(reject))
      if (!organizations.some((item) => item.id === organizationID))
        return yield* new InvalidRequestError({ message: "Check the organization", field: "organizationID" })
      return { organizationID } satisfies Credential.Scope
    })
    const sharedEntries = Effect.fnUntraced(function* (scope: Credential.Scope) {
      const all = yield* credentials.all(scope)
      // Each integration's selected credential is listed last.
      const selected = new Map(all.map((item) => [item.integrationID, item.id]))
      return all.map((item) => presentCredential(item, selected.get(item.integrationID) === item.id))
    })
    return handlers
      .handle("auth.register", ({ payload }) =>
        identity.register(payload).pipe(
          Effect.mapError((error) =>
            error.reason === "taken"
              ? new InvalidRequestError({ message: "That employee ID is already registered", field: "employeeID" })
              : new InvalidRequestError({
                  message: "Check the employee ID and password. Passwords need at least 8 characters.",
                  field: "employeeID",
                }),
          ),
        ),
      )
      .handle("auth.login", ({ payload }) =>
        Effect.gen(function* () {
          const token = yield* identity.login(payload)
          if (!token) return yield* new UnauthorizedError({ message: "Invalid employee ID or password" })
          return token
        }),
      )
      .handle("auth.logout", () =>
        Effect.gen(function* () {
          const access = yield* signedIn
          yield* identity.logout(access.sessionID)
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle("auth.session", () =>
        Effect.gen(function* () {
          const access = yield* signedIn
          const account = yield* identity.account(access.sessionID)
          if (!account) return yield* unauthorized
          return yield* present(account, identity)
        }),
      )
      .handle("auth.user.list", () =>
        Effect.gen(function* () {
          const access = yield* signedIn
          return yield* identity
            .listUsers(access.sessionID)
            .pipe(
              Effect.mapError((error) =>
                error.reason === "credentials"
                  ? unauthorized
                  : new ForbiddenError({ message: "Only a platform admin can do this" }),
              ),
            )
        }),
      )
      .handle("auth.user.create", ({ payload }) =>
        Effect.gen(function* () {
          const access = yield* signedIn
          return yield* identity.createUser(access.sessionID, payload).pipe(Effect.mapError(reject))
        }),
      )
      .handle("auth.user.delete", ({ params }) =>
        Effect.gen(function* () {
          const access = yield* signedIn
          yield* identity.deleteUser(access.sessionID, params.employeeID).pipe(Effect.mapError(reject))
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle("auth.user.admin", ({ params, payload }) =>
        Effect.gen(function* () {
          const access = yield* signedIn
          return yield* identity
            .setAdmin(access.sessionID, params.employeeID, payload.admin)
            .pipe(Effect.mapError(reject))
        }),
      )
      .handle("auth.switch", ({ payload }) =>
        Effect.gen(function* () {
          const access = yield* signedIn
          const account = yield* identity
            .switchOrganization(access.sessionID, payload.organizationID)
            .pipe(Effect.mapError(sessionError))
          return yield* present(account, identity)
        }),
      )
      .handle("auth.organization.create", ({ payload }) =>
        Effect.gen(function* () {
          const access = yield* signedIn
          return yield* identity.createOrganization(access.sessionID, payload.name).pipe(Effect.mapError(reject))
        }),
      )
      .handle("auth.organization.list", () =>
        Effect.gen(function* () {
          const access = yield* signedIn
          return yield* identity.listOrganizations(access.sessionID).pipe(Effect.mapError(reject))
        }),
      )
      .handle("auth.organization.rename", ({ params, payload }) =>
        Effect.gen(function* () {
          const access = yield* signedIn
          return yield* identity
            .renameOrganization(access.sessionID, params.organizationID, payload.name)
            .pipe(Effect.mapError(reject))
        }),
      )
      .handle("auth.user.password", ({ params, payload }) =>
        Effect.gen(function* () {
          const access = yield* signedIn
          yield* identity
            .resetPassword(access.sessionID, params.employeeID, payload.password)
            .pipe(
              Effect.mapError((error) =>
                error.reason === "invalid"
                  ? new InvalidRequestError({ message: "Passwords need at least 8 characters", field: "password" })
                  : reject(error),
              ),
            )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle("auth.organization.credential.list", ({ params }) =>
        Effect.gen(function* () {
          const scope = yield* organizationCredentials(params.organizationID)
          return yield* sharedEntries(scope)
        }),
      )
      .handle("auth.organization.credential.create", ({ params, payload }) =>
        Effect.gen(function* () {
          const scope = yield* organizationCredentials(params.organizationID)
          const integrationID = payload.integrationID.trim()
          if (!INTEGRATION_ID.test(integrationID))
            return yield* new InvalidRequestError({ message: "Check the provider", field: "integrationID" })
          if (!payload.key.trim())
            return yield* new InvalidRequestError({ message: "Enter the API key", field: "key" })
          const created = yield* credentials.create({
            integrationID: Integration.ID.make(integrationID),
            value: Credential.Key.make({ type: "key", key: payload.key.trim() }),
            label: payload.label?.trim() || undefined,
            scope,
          })
          const entry = (yield* sharedEntries(scope)).find((item) => item.id === created.id)
          return entry ?? presentCredential(created, false)
        }),
      )
      .handle("auth.organization.credential.activate", ({ params }) =>
        Effect.gen(function* () {
          const scope = yield* organizationCredentials(params.organizationID)
          const id = Credential.ID.make(params.credentialID)
          if (!(yield* credentials.get(id, scope)))
            return yield* new InvalidRequestError({ message: "Credential not found", field: "credentialID" })
          yield* credentials.activate(id, scope)
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle("auth.organization.credential.remove", ({ params }) =>
        Effect.gen(function* () {
          const scope = yield* organizationCredentials(params.organizationID)
          const id = Credential.ID.make(params.credentialID)
          if (!(yield* credentials.get(id, scope)))
            return yield* new InvalidRequestError({ message: "Credential not found", field: "credentialID" })
          yield* credentials.remove(id, scope)
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle("auth.organization.provider.list", ({ params }) =>
        Effect.gen(function* () {
          return yield* credentials.customProviders(yield* organizationCredentials(params.organizationID))
        }),
      )
      .handle("auth.organization.provider.save", ({ params, payload }) =>
        Effect.gen(function* () {
          const scope = yield* organizationCredentials(params.organizationID)
          const provider = yield* customProvider(params.providerID, payload)
          yield* credentials.saveCustomProvider(params.organizationID, provider)
          const key = payload.key?.trim()
          if (key)
            yield* credentials.create({
              integrationID: Integration.ID.make(provider.id),
              value: Credential.Key.make({ type: "key", key }),
              label: provider.name,
              scope,
            })
          return provider
        }),
      )
      .handle("auth.organization.provider.remove", ({ params }) =>
        Effect.gen(function* () {
          yield* organizationCredentials(params.organizationID)
          yield* credentials.removeCustomProvider(params.organizationID, params.providerID)
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle("auth.package.list", () =>
        Effect.gen(function* () {
          const access = yield* signedIn
          const disabled = access.organizationID ? yield* packages.disabled(access.organizationID) : new Set<string>()
          // Platform admins manage the scope; everyone else only sees what is open to their organization.
          return (yield* packages.list())
            .filter((item) => access.admin || (!!access.organizationID && item.organizations.includes(access.organizationID)))
            .map((item) => ({
              ...item,
              organizations: access.admin ? item.organizations : [],
              enabled: !disabled.has(GlobalPackage.key(item.kind, item.name)),
            }))
        }),
      )
      .handle("auth.package.upload", ({ payload }) =>
        Effect.gen(function* () {
          const access = yield* platformAdmin
          const archive = yield* Effect.try({
            try: () => new Uint8Array(Buffer.from(payload.archive, "base64")),
            catch: () => packageError("Check the archive"),
          })
          const installed = yield* packages.install({
            kind: payload.kind,
            name: payload.name,
            uploadedBy: access.employeeID,
            organizations: yield* knownOrganizations(access.sessionID, payload.organizations),
            archive,
          }).pipe(
            Effect.catchTags({
              "GlobalPackage.InvalidError": (error) => Effect.fail(packageError(error.reason)),
              "GlobalPackage.ConflictError": () =>
                Effect.fail(packageError("A package that wasn't uploaded here already uses that name")),
            }),
          )
          return { ...installed, enabled: true }
        }),
      )
      .handle("auth.mcp.list", () =>
        Effect.gen(function* () {
          const access = yield* signedIn
          const disabled = access.organizationID ? yield* packages.disabled(access.organizationID) : new Set<string>()
          return (yield* sharedMcp.list())
            .filter((item) => access.admin || (!!access.organizationID && item.organizations.includes(access.organizationID)))
            .map((item) => ({
              ...item,
              target: access.admin ? item.target : "",
              organizations: access.admin ? item.organizations : [],
              enabled: !disabled.has(GlobalPackage.key("mcp", item.name)),
            }))
        }),
      )
      .handle("auth.mcp.create", ({ payload }) =>
        Effect.gen(function* () {
          const access = yield* platformAdmin
          const server =
            payload.type === "remote"
              ? { type: "remote" as const, url: payload.url ?? "", headers: payload.headers }
              : { type: "local" as const, command: payload.command ?? [], environment: payload.environment }
          const created = yield* sharedMcp
            .save({
              name: payload.name,
              server,
              createdBy: access.employeeID,
              organizations: yield* knownOrganizations(access.sessionID, payload.organizations),
            })
            .pipe(
              Effect.catchTags({
                "SharedMcp.InvalidError": (error) => Effect.fail(mcpError(error.reason)),
                "SharedMcp.ConflictError": () => Effect.fail(mcpError("A shared MCP server already uses that name")),
              }),
            )
          return { ...created, enabled: true }
        }),
      )
      .handle("auth.mcp.remove", ({ params }) =>
        Effect.gen(function* () {
          yield* platformAdmin
          yield* sharedMcp
            .remove(params.name)
            .pipe(Effect.catchTag("SharedMcp.NotFoundError", () => Effect.fail(mcpError("MCP server not found"))))
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle("auth.mcp.scope", ({ params, payload }) =>
        Effect.gen(function* () {
          const access = yield* platformAdmin
          yield* sharedMcp
            .setScope(params.name, yield* knownOrganizations(access.sessionID, payload.organizations))
            .pipe(Effect.catchTag("SharedMcp.NotFoundError", () => Effect.fail(mcpError("MCP server not found"))))
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle("auth.organization.mcp", ({ params, payload }) =>
        Effect.gen(function* () {
          yield* organizationCredentials(params.organizationID)
          yield* sharedMcp
            .setEnabled(params.organizationID, params.name, payload.enabled)
            .pipe(Effect.catchTag("SharedMcp.NotFoundError", () => Effect.fail(mcpError("MCP server not found"))))
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle("auth.package.scope", ({ params, payload }) =>
        Effect.gen(function* () {
          const access = yield* platformAdmin
          yield* packages
            .setScope(params.kind, params.name, yield* knownOrganizations(access.sessionID, payload.organizations))
            .pipe(Effect.catchTag("GlobalPackage.NotFoundError", () => Effect.fail(packageError("Package not found"))))
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle("auth.package.remove", ({ params }) =>
        Effect.gen(function* () {
          yield* platformAdmin
          yield* packages.remove(params.kind, params.name).pipe(
            Effect.catchTag("GlobalPackage.NotFoundError", () => Effect.fail(packageError("Package not found"))),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle("auth.organization.package", ({ params, payload }) =>
        Effect.gen(function* () {
          yield* organizationCredentials(params.organizationID)
          yield* packages.setEnabled(params.organizationID, params.kind, params.name, payload.enabled).pipe(
            Effect.catchTag("GlobalPackage.NotFoundError", () => Effect.fail(packageError("Package not found"))),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle("auth.organization.settings", ({ params, payload }) =>
        Effect.gen(function* () {
          const access = yield* signedIn
          return yield* identity
            .setSettingsPages(access.sessionID, params.organizationID, payload.pages)
            .pipe(Effect.mapError(reject))
        }),
      )
      .handle("auth.organization.member.add", ({ params, payload }) =>
        Effect.gen(function* () {
          const access = yield* signedIn
          return yield* identity
            .addMember(access.sessionID, params.organizationID, payload.employeeID)
            .pipe(Effect.mapError(reject))
        }),
      )
      .handle("auth.organization.member.role", ({ params, payload }) =>
        Effect.gen(function* () {
          const access = yield* signedIn
          return yield* identity
            .setMemberRole(access.sessionID, params.organizationID, params.employeeID, payload.role)
            .pipe(Effect.mapError(reject))
        }),
      )
      .handle("auth.organization.member.remove", ({ params }) =>
        Effect.gen(function* () {
          const access = yield* signedIn
          return yield* identity
            .removeMember(access.sessionID, params.organizationID, params.employeeID)
            .pipe(Effect.mapError(reject))
        }),
      )
  }),
)

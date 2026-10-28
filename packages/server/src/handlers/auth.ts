import { Identity } from "@opencode/core/identity"
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
  if (error.reason === "forbidden") return new ForbiddenError({ message: "Only a platform admin can do this" })
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

export const AuthHandler = HttpApiBuilder.group(Api, "server.auth", (handlers) =>
  Effect.gen(function* () {
    const identity = yield* Identity.Service
    const config = yield* ServerAuth.Config
    const signedIn = user(config, identity)
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

import { ServerAuth } from "./auth"
import { Credential } from "@opencode/core/credential"
import { Identity } from "@opencode/core/identity"
import { Effect, Redacted } from "effect"
import { HttpServerRequest } from "effect/http"
import { credentialFromRequest, authorizedSessionCookie } from "./middleware/authorization"

export type Access =
  | { readonly kind: "unset" }
  | { readonly kind: "operator" }
  | {
      readonly kind: "user"
      readonly sessionID: string
      readonly userID: string
      readonly employeeID: string
      readonly admin: boolean
      readonly organizationID: string | undefined
    }

/** Lets credential lookups inside `effect` include the signed-in user's own credentials. */
export function actingAs<A, E, R>(effect: Effect.Effect<A, E, R>, access: Access) {
  return access.kind === "user"
    ? Effect.provideService(effect, Credential.Actor, { userID: access.userID, admin: access.admin })
    : effect
}

export function accessFor(
  request: HttpServerRequest.HttpServerRequest,
  config: ServerAuth.Info,
  identity: Identity.Interface,
) {
  return Effect.gen(function* () {
    if (!ServerAuth.required(config)) return { kind: "operator" } as const
    const credential = yield* credentialFromRequest(request)
    if (ServerAuth.authorized(credential, config) || authorizedSessionCookie(request, config))
      return { kind: "operator" } as const
    const account = yield* identity.authenticate(Redacted.value(credential.password))
    if (!account) return { kind: "unset" } as const
    return {
      kind: "user" as const,
      sessionID: account.sessionID,
      userID: account.userID,
      employeeID: account.employeeID,
      admin: account.admin,
      organizationID: account.organizationID,
    }
  })
}

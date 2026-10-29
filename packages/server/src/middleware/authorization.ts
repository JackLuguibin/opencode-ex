import { ServerAuth } from "../auth"
import { allows, managesSession, requirement } from "../access-policy"
import { canManage } from "../visibility"
import type { Access } from "../access"
import { requireOwnedProject } from "../owned-project"
import { missingSession } from "../handlers/session-error"
import { Identity } from "@opencode/core/identity"
import { ForbiddenError, UnauthorizedError } from "@opencode/protocol/errors"
import { Session } from "@opencode/core/session"
import { AUTH_LOGIN_PATH, AUTH_REGISTER_PATH } from "@opencode/protocol/groups/auth"
import { Authorization } from "@opencode/protocol/middleware/authorization"
export { Authorization } from "@opencode/protocol/middleware/authorization"
import { PTY_CONNECT_PATH, PTY_CONNECT_TICKET_QUERY } from "@opencode/protocol/groups/pty"
import { PERSISTENT_PTY_CONNECT_PATH } from "@opencode/protocol/groups/persistent-pty"
import { MCP_CLIENT_PATH } from "@opencode/protocol/groups/mcp"
import { PAIRING_CONNECT_PATH } from "@opencode/protocol/groups/server"
import { Effect, Layer, Option, Redacted, Schema } from "effect"
import { Base64 } from "effect/encoding"
import { HttpEffect, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"

const AUTH_TOKEN_QUERY = "auth_token"
const WWW_AUTHENTICATE = 'Basic realm="Secure Area"'

function emptyCredential() {
  return { username: "", password: Redacted.make("") }
}

function decodeCredential(input: string) {
  return Effect.fromResult(Base64.decodeString(input)).pipe(
    Effect.match({
      onFailure: emptyCredential,
      onSuccess: (header) => {
        const separator = header.indexOf(":")
        if (separator === -1) return emptyCredential()
        return { username: header.slice(0, separator), password: Redacted.make(header.slice(separator + 1)) }
      },
    }),
  )
}

export function credentialFromRequest(request: HttpServerRequest.HttpServerRequest) {
  const url = new URL(request.url, "http://localhost")
  const token = url.searchParams.get(AUTH_TOKEN_QUERY)
  if (token) return decodeCredential(token)
  const match = /^Basic\s+(.+)$/i.exec(request.headers.authorization ?? "")
  if (match) return decodeCredential(match[1])
  return Effect.succeed(emptyCredential())
}

const UNAUTHORIZED_MESSAGE = "Authentication required"

// Browsers show a native credentials prompt for a Basic challenge even on fetch, which would stall the web app
// before it can show its own sign-in screen. Only non-browser clients and page navigations get the challenge.
function challengeRequest(request: HttpServerRequest.HttpServerRequest) {
  const mode = request.headers["sec-fetch-mode"]
  return mode === undefined || mode === "navigate"
}

// Matches what the Authorization middleware encodes, for requests rejected before the HttpApi runs.
export function unauthorizedResponse(request: HttpServerRequest.HttpServerRequest) {
  return HttpServerResponse.jsonUnsafe(
    { _tag: "UnauthorizedError", message: UNAUTHORIZED_MESSAGE },
    { status: 401, headers: challengeRequest(request) ? { "www-authenticate": WWW_AUTHENTICATE } : undefined },
  )
}

export function authorizedRequest(request: HttpServerRequest.HttpServerRequest, config: ServerAuth.Info) {
  return credentialFromRequest(request).pipe(
    Effect.map((credential) => ServerAuth.authorized(credential, config) || authorizedSessionCookie(request, config)),
  )
}

export function authorizedSessionCookie(request: HttpServerRequest.HttpServerRequest, config: ServerAuth.Info) {
  const token = request.cookies[ServerAuth.sessionCookieName(request.headers.host)]
  if (!token) return false
  // Same-site pages on other ports still send this cookie, so only same-origin requests may use it.
  const origin = request.headers.origin
  if (origin !== undefined && URL.parse(origin)?.host !== request.headers.host) return false
  return ServerAuth.verifySession(token, config)
}

const PUBLIC_PATHS = new Set([AUTH_REGISTER_PATH, AUTH_LOGIN_PATH])

export const authorizationLayer = Layer.effect(
  Authorization,
  Effect.gen(function* () {
    const config = yield* ServerAuth.Config
    const identity = yield* Identity.Service
    const sessions = yield* Session.Service
    if (!ServerAuth.required(config)) return Authorization.of((effect) => effect)
    return Authorization.of((effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const route = yield* HttpRouter.RouteContext
        // Ticketed PTY and client MCP connects (browsers cannot set headers on WebSocket upgrades) and pairing links
        // skip credential checks here; their handlers consume and validate the ticket or code. Use the
        // route selected by Effect so authorization and dispatch cannot disagree about the request path.
        const url = new URL(request.url, "http://localhost")
        if (
          ((route.route.path === PTY_CONNECT_PATH ||
            route.route.path === PERSISTENT_PTY_CONNECT_PATH ||
            route.route.path === MCP_CLIENT_PATH) &&
            !!url.searchParams.get(PTY_CONNECT_TICKET_QUERY)) ||
          route.route.path === PAIRING_CONNECT_PATH ||
          PUBLIC_PATHS.has(route.route.path)
        )
          return yield* effect
        const gateway = ServerAuth.gatewayAccount(request.headers, config)
        const credential = yield* credentialFromRequest(request)
        if (!gateway && (ServerAuth.authorized(credential, config) || authorizedSessionCookie(request, config)))
          return yield* effect
        const account = gateway ?? (yield* identity.authenticate(Redacted.value(credential.password)))
        if (account) {
          // An administrator can act on an organization they don't belong to, by naming it in the path.
          yield* identity.mirror({
            userID: account.userID,
            employeeID: account.employeeID,
            organizations: account.organizations,
            organizationID: Option.getOrUndefined(Schema.decodeUnknownOption(Schema.String)(route.params.organizationID)),
          })
          if (!allows(account, requirement(request.method, route.route.path)))
            return yield* new ForbiddenError({ message: "You don't have permission to do this" })
          // Every route that names a session is only for the organization that owns it. Checking here covers them all,
          // rather than relying on each handler to remember.
          const sessionID = Option.getOrUndefined(Schema.decodeUnknownOption(Session.ID)(route.params.sessionID))
          if (sessionID) {
            const access: Access = { kind: "user", ...account }
            const session = yield* sessions.get(sessionID).pipe(Effect.catchTag("Session.NotFoundError", missingSession))
            yield* requireOwnedProject(session.projectID, session.id, access, identity)
            if (managesSession(request.method, route.route.path)) {
              const owner = yield* identity.sessionAccess(session.id)
              if (!canManage(access, owner?.creatorUserID))
                return yield* new ForbiddenError({ message: "Only the session's creator or an admin can do this" })
            }
          }
          return yield* effect
        }
        if (challengeRequest(request))
          yield* HttpEffect.appendPreResponseHandler((_request, response) =>
            Effect.succeed(HttpServerResponse.setHeader(response, "www-authenticate", WWW_AUTHENTICATE)),
          )
        return yield* new UnauthorizedError({ message: UNAUTHORIZED_MESSAGE })
      }),
    )
  }),
)

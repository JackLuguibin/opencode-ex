export * as ServerAuth from "./auth"

import { Context, Layer, Option, Redacted } from "effect"
import { Gateway } from "@opencode/protocol/gateway"
import { createHmac, timingSafeEqual } from "node:crypto"
import type { ReplayGuard } from "./replay-guard"

export type DecodedCredentials = {
  readonly username: string
  readonly password: Redacted.Redacted
}

export type Info = {
  readonly password: Option.Option<string>
  readonly username: string
  /** Shared with the Auth server, which vouches for users it has already authenticated. */
  readonly gatewaySecret?: string
  /** Further keys a gateway header may be signed with, accepted while a key is being rotated. */
  readonly gatewaySecretExtra?: ReadonlyArray<string>
}

export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60

export class Config extends Context.Service<Config, Info>()("@opencode/ServerAuthConfig") {
  static configLayer(input: Pick<Info, "password" | "gatewaySecret" | "gatewaySecretExtra">) {
    return Layer.succeed(this, this.of({ ...input, username: "opencode" }))
  }

  static get layer() {
    return this.configLayer({ password: Option.none() })
  }
}

export function required(config: Info) {
  return Option.isSome(config.password) && config.password.value !== ""
}

// Requests forwarded by the Auth server arrive already authenticated; the signed actor replaces a token lookup.
export function gatewayAccount(headers: Readonly<Record<string, string | undefined>>, config: Info) {
  const header = headers[Gateway.ACTOR_HEADER]
  if (!header || !config.gatewaySecret) return undefined
  const actor = Gateway.verify(gatewaySecrets(config), header)
  return actor && { ...actor, sessionID: "gateway" }
}

function gatewaySecrets(config: Info) {
  return [config.gatewaySecret!, ...(config.gatewaySecretExtra ?? [])]
}

/**
 * Whether this header was already used on an earlier request. Check it once per request, where the request enters:
 * the same header is verified again further in, which must not count as a replay.
 */
export function gatewayReplayed(
  headers: Readonly<Record<string, string | undefined>>,
  config: Info,
  guard: ReplayGuard.Interface,
) {
  const header = headers[Gateway.ACTOR_HEADER]
  if (!header || !config.gatewaySecret) return false
  const claim = Gateway.claim(gatewaySecrets(config), header)
  return claim?.jti !== undefined && guard.seen(claim.jti, claim.exp)
}

// Session tokens issued by pairing links are accepted anywhere the password is.
export function authorized(credentials: DecodedCredentials, config: Info) {
  if (Option.isNone(config.password) || credentials.username !== config.username) return false
  const password = Redacted.value(credentials.password)
  return password === config.password.value || verifySession(password, config)
}

// Sessions are signed with a key derived from the server password, so rotating the password revokes every session.
export function issueSession(config: Info, now = Date.now()) {
  if (Option.isNone(config.password)) return
  const expires = String(Math.floor(now / 1000) + SESSION_TTL_SECONDS)
  return `${expires}.${sign(config.password.value, expires)}`
}

export function verifySession(token: string, config: Info, now = Date.now()) {
  if (Option.isNone(config.password)) return false
  const parts = token.split(".")
  if (parts.length !== 2) return false
  const expires = Number(parts[0])
  if (!Number.isSafeInteger(expires) || expires * 1000 <= now) return false
  const expected = Buffer.from(sign(config.password.value, parts[0]))
  const actual = Buffer.from(parts[1])
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

// Browsers share cookies across ports on the same host, so the name carries the port to keep local servers apart.
export function sessionCookieName(host: string | undefined) {
  const port = URL.parse(`http://${host ?? ""}`)?.port
  return port ? `opencode_session_${port}` : "opencode_session"
}

function sign(password: string, payload: string) {
  const key = createHmac("sha256", password).update("opencode-session-v1").digest()
  return createHmac("sha256", key).update(payload).digest("base64url")
}

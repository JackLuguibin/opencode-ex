export * as Gateway from "./gateway.js"

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

/** Header the Auth server sets on every request it forwards to an execution layer. */
export const ACTOR_HEADER = "x-opencode-actor"

/** Short, because the header is minted per request: a captured one is only replayable inside this window. */
export const ACTOR_TTL_SECONDS = 60

// Routes of the identity group are served from the identity store with the caller's own session token, so the gateway
// passes the token through on them instead of replacing it with an actor. They move into Auth with the identity data.
const IDENTITY =
  /^\/api\/(auth\/|organization(\/|$)|package(\/|$)|shared-mcp(\/|$)|preference(\/|$)|project-access$|session-access$|project\/[^/]+\/visibility$|session\/[^/]+\/(presence|visibility)$)/

export function isIdentityPath(pathname: string) {
  return IDENTITY.test(pathname)
}

// State that every execution layer must agree on (global packages, shared MCP servers, platform config) is written to
// all of them; reads can come from any.
const BROADCAST = /^\/api\/(package|shared-mcp)(\/|$)/
const PLATFORM_WRITES = new Set([
  "PATCH /api/experimental/config",
  "POST /api/plugin/check",
  "POST /api/plugin/update",
  "POST /api/experimental/integration/wellknown",
])

/** Writes to the state `GlobalPackage` and `SharedMcp` keep, which a layer that missed one must be able to catch up on. */
export function isPackageWrite(method: string, pathname: string) {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS" && BROADCAST.test(pathname)
}

/** Writes to platform settings, which every layer must take and a layer that missed one is replayed. */
export function isPlatformWrite(method: string, pathname: string) {
  return PLATFORM_WRITES.has(`${method} ${pathname}`)
}

export function isBroadcast(method: string, pathname: string) {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false
  return BROADCAST.test(pathname) || PLATFORM_WRITES.has(`${method} ${pathname}`)
}

/**
 * The organization a route belongs to when its path names one, whoever is asking. The organization's own route
 * (`DELETE /api/organization/:id`) counts: its projects and files are on the layer it is pinned to.
 */
export function pathOrganization(pathname: string) {
  return /^\/api\/organization\/([^/]+)(?:\/|$)/.exec(pathname)?.[1]
}

/**
 * The organization a request names through its `location[directory]` query, whose directory sits inside the
 * organization's own folder. Sockets carry no credential, so this is the only way to send a terminal's connection to
 * the execution layer that holds the terminal.
 */
export function directoryOrganization(url: URL) {
  return /(?:^|[\\/])organizations[\\/](org_[A-Za-z0-9]+)(?:[\\/]|$)/.exec(
    url.searchParams.get("location[directory]") ?? "",
  )?.[1]
}

export type Actor = {
  readonly userID: string
  readonly employeeID: string
  readonly admin: boolean
  readonly organizationID: string | undefined
  readonly organizationAdmin: boolean
  readonly settingsPages: ReadonlyArray<string>
  readonly organizations: ReadonlyArray<{ readonly id: string; readonly name: string }>
}

/** Every header carries a fresh `jti`, so a layer can refuse one it has already accepted. */
export function sign(secret: string, actor: Actor, now = Date.now()) {
  const payload = Buffer.from(
    JSON.stringify({
      ...actor,
      exp: Math.floor(now / 1000) + ACTOR_TTL_SECONDS,
      jti: randomBytes(12).toString("base64url"),
    }),
  ).toString("base64url")
  return `${payload}.${mac(secret, payload)}`
}

export type Claim = { readonly actor: Actor; readonly jti: string | undefined; readonly exp: number }

/**
 * What the header vouches for, or undefined when it is malformed, forged, or expired. `secrets` lists every key the
 * header may be signed with, so a key can be rotated without a moment when one side rejects the other. A header from
 * before `jti` existed has none and cannot be checked for replay.
 */
export function claim(secrets: string | ReadonlyArray<string>, header: string, now = Date.now()): Claim | undefined {
  const parts = header.split(".")
  if (parts.length !== 2) return undefined
  const actual = Buffer.from(parts[1])
  const trusted = (Array.isArray(secrets) ? secrets : [secrets]).some((secret) => {
    const expected = Buffer.from(mac(secret, parts[0]))
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  })
  if (!trusted) return undefined
  const { exp, jti, ...actor } = JSON.parse(Buffer.from(parts[0], "base64url").toString()) as Actor & {
    exp: number
    jti?: string
  }
  if (!Number.isSafeInteger(exp) || exp * 1000 <= now) return undefined
  return { actor, jti, exp }
}

/** The actor the header vouches for, or undefined when it is malformed, forged, or expired. */
export function verify(secrets: string | ReadonlyArray<string>, header: string, now = Date.now()): Actor | undefined {
  return claim(secrets, header, now)?.actor
}

function mac(secret: string, payload: string) {
  return createHmac("sha256", createHmac("sha256", secret).update("opencode-gateway-v1").digest())
    .update(payload)
    .digest("base64url")
}

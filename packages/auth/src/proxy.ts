export * as Proxy from "./proxy.js"

import { Gateway } from "@opencode/protocol/gateway"
import type { ServerWebSocket } from "bun"

export type Options = {
  /** The execution layer that runs an organization's work; any layer when there is no organization. */
  readonly upstream: (organizationID?: string) => Promise<string | undefined> | string | undefined
  /** Every execution layer, for writes they must all see. */
  readonly all: () => Promise<readonly string[]> | readonly string[]
  readonly secret: string
  /** Called after an organization was deleted, so its placement can be dropped. */
  readonly released?: (organizationID: string) => Promise<void> | void
  /** Answers `GET /health`; absent means the gateway is healthy whenever it is running. */
  readonly health?: () => Promise<Health> | Health
  /** Told which layers accepted a global package write, so layers that did not can be found and caught up. */
  readonly accepted?: (urls: readonly string[]) => Promise<void> | void
  /** Keeps platform writes in order so a layer that missed one can be replayed; absent means they are only broadcast. */
  readonly journal?: {
    /** Writes the request down before it is sent; undefined when it could not be, and the write is sent regardless. */
    readonly begin: (entry: {
      readonly method: string
      readonly path: string
      readonly search: string
      readonly contentType: string | undefined
      readonly body: Uint8Array
      readonly actor: Gateway.Actor
    }) => Promise<number | undefined>
    /** Told which layers took the write. */
    readonly settled: (seq: number, accepted: readonly string[]) => Promise<void>
  }
  /** Throttles password guessing: `blocked` counts the attempt and says whether the login may be forwarded, `record` is told how it ended. */
  readonly attempts?: {
    readonly blocked: (employeeID: string) => Promise<boolean>
    readonly record: (employeeID: string, ok: boolean) => Promise<void>
  }
  /** Told after an account write succeeded, so other gateways can drop the identities they cached. */
  readonly invalidated?: () => Promise<void> | void
  /** Answers every request outside `/api`, so the gateway can serve the web app itself. */
  readonly ui?: (request: Request) => Promise<Response> | Response
  /** Receives one line per failure, tagged with the request id. Silent by default. */
  readonly log?: (line: string) => void
}

export type Health = { readonly ok: boolean } & Record<string, unknown>

type Socket = { target: string; peer?: WebSocket; queued: (string | Uint8Array<ArrayBuffer>)[] }

// Accounts are shared by every execution layer, so any of them can resolve a token. An entry is refreshed in the
// background once it is this old, so a revoked token stops working quickly without a lookup on every request of a busy
// SSE client.
const ACCOUNT_TTL_MS = 5_000

// A valid actor is still answered from the cache while it is being refreshed, up to this age; opening a session sends a
// burst of requests, and each waiting for a lookup that costs several shared-database queries is what made it slow.
const ACCOUNT_STALE_MS = 60_000

// Writes that change who a token is: signing out, switching organization, and membership, role or password changes.
// Every cached actor is dropped after one succeeds. Login, registration and client-state writes do not change anyone.
const ACCOUNT_WRITE = /^\/api\/(auth\/(?!login|register|guest|uac)|organization)/

const DELETED_ORGANIZATION = /^\/api\/organization\/(org_[A-Za-z0-9]+)\/?$/

export const REQUEST_ID_HEADER = "x-request-id"

// A caller's id is kept only when it is safe to put in a log line and a header.
const REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/

const HOP_BY_HOP = ["connection", "keep-alive", "transfer-encoding", "upgrade", "host", "content-length"]

export function make(options: Options) {
  const cache = new Map<string, { actor: Gateway.Actor | undefined; fresh: number; expires: number }>()
  // Requests that arrive while a token is being looked up share that lookup instead of each making their own.
  const lookups = new Map<string, Promise<Gateway.Actor | undefined | "unavailable">>()
  let writes = 0

  // Drops every cached actor, here or because another gateway saw an account write.
  function invalidate() {
    writes++
    cache.clear()
    lookups.clear()
  }

  function lookup(token: string) {
    const pending = lookups.get(token)
    if (pending) return pending
    const started = fetchActor(token)
      .catch((): "unavailable" => "unavailable")
      .finally(() => lookups.delete(token))
    lookups.set(token, started)
    return started
  }

  async function fetchActor(token: string): Promise<Gateway.Actor | undefined | "unavailable"> {
    const generation = writes
    const upstream = await options.upstream()
    if (!upstream) return "unavailable"
    const response = await fetch(`${upstream}/api/auth/session`, {
      headers: { authorization: `Basic ${btoa(`opencode:${token}`)}` },
    }).catch(() => undefined)
    if (!response || response.status >= 500) return "unavailable"
    const actor = response.ok ? toActor((await response.json()) as Session) : undefined
    // A lookup that began before an account write may have read the old answer.
    if (generation !== writes) return actor
    const now = Date.now()
    if (cache.size >= 1_000) for (const [key, entry] of cache) if (entry.expires <= now) cache.delete(key)
    // An unknown token is never answered stale: it may have just been issued.
    cache.set(token, { actor, fresh: now + ACCOUNT_TTL_MS, expires: now + (actor ? ACCOUNT_STALE_MS : ACCOUNT_TTL_MS) })
    return actor
  }

  // `undefined` means the token is not valid; "unavailable" means no execution layer could say, which must not look
  // like a sign-out to the web app.
  async function resolve(token: string): Promise<Gateway.Actor | undefined | "unavailable"> {
    const hit = cache.get(token)
    const now = Date.now()
    if (!hit || hit.expires <= now) return lookup(token)
    if (hit.fresh <= now) void lookup(token)
    return hit.actor
  }

  async function fetchHandler(
    request: Request,
    server: { upgrade: (request: Request, init: { data: Socket }) => boolean },
    requestID: string,
  ) {
    const url = new URL(request.url)
    const token = credential(request, url)
    url.searchParams.delete("auth_token")
    const preflight = request.method === "OPTIONS"
    const resolved = token && !preflight ? await resolve(token) : undefined
    if (resolved === "unavailable") return reject(request, 503, "No execution layer available")
    const actor = resolved
    const organizationID =
      Gateway.pathOrganization(url.pathname) ?? actor?.organizationID ?? Gateway.directoryOrganization(url)
    const broadcast = Gateway.isBroadcast(request.method, url.pathname)

    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      // Ticketed sockets carry no credential; the ticket was minted through an authenticated call and the execution
      // layer validates it, so the upgrade is relayed as is, to the layer of the caller's organization when it says.
      const upstream = await options.upstream(organizationID)
      if (!upstream) return reject(request, 503, "No execution layer available")
      const target = `${upstream}${url.pathname}${url.search}`.replace(/^http/, "ws")
      return server.upgrade(request, { data: { target, queued: [] } })
        ? undefined
        : new Response("WebSocket upgrade failed", { status: 400 })
    }

    // Identity routes take the user's own token (login has none); everything else is vouched for by Auth. CORS
    // preflights carry no credentials; the execution layer answers them.
    const vouch = !Gateway.isIdentityPath(url.pathname) && !preflight
    if (vouch && !actor) return reject(request, 401, "Authentication required", "UnauthorizedError")

    const login =
      request.method === "POST" && url.pathname === "/api/auth/login" && options.attempts
        ? await loginEmployee(request)
        : undefined
    if (login && (await options.attempts!.blocked(login).catch(() => false)))
      return reject(request, 429, "Too many failed sign-in attempts. Try again in a few minutes.", "TooManyRequests")

    const targets = broadcast ? [...(await options.all())] : [await options.upstream(organizationID)]
    if (targets.length === 0 || targets.some((target) => !target))
      return reject(
        request,
        503,
        organizationID && !broadcast ? "This organization's execution layer is offline" : "No execution layer available",
      )

    const headers = new Headers(request.headers)
    for (const name of [...HOP_BY_HOP, Gateway.ACTOR_HEADER]) headers.delete(name)
    if (vouch && actor) {
      headers.delete("authorization")
      headers.set(Gateway.ACTOR_HEADER, Gateway.sign(options.secret, actor))
    } else if (token) headers.set("authorization", `Basic ${btoa(`opencode:${token}`)}`)
    // Compression is handled between the browser and Auth only.
    headers.set("accept-encoding", "identity")
    headers.set(REQUEST_ID_HEADER, requestID)

    // A body can only be read once; a write to several layers needs a copy for each.
    const hasBody = request.method !== "GET" && request.method !== "HEAD"
    const body = hasBody ? (broadcast ? await request.arrayBuffer() : request.body) : undefined
    const journaled =
      options.journal && broadcast && actor && Gateway.isPlatformWrite(request.method, url.pathname)
        ? await options.journal
            .begin({
              method: request.method,
              path: url.pathname,
              search: url.search,
              contentType: request.headers.get("content-type") ?? undefined,
              body: new Uint8Array(body as ArrayBuffer),
              actor,
            })
            .catch((error: unknown) => {
              options.log?.(`${requestID} could not record the platform write: ${error instanceof Error ? error.message : String(error)}`)
              return undefined
            })
        : undefined
    const responses = await Promise.all(
      targets.map((target) =>
        fetch(`${target}${url.pathname}${url.search}`, {
          method: request.method,
          headers,
          body,
          redirect: "manual",
          // @ts-expect-error Bun streams a request body only when told the length is not known up front.
          duplex: "half",
        }).catch((error: unknown) => {
          options.log?.(`${requestID} upstream ${target} failed: ${error instanceof Error ? error.message : String(error)}`)
          return undefined
        }),
      ),
    )
    if (broadcast && responses.some((candidate) => candidate === undefined))
      options.log?.(`${requestID} ${request.method} ${url.pathname} did not reach every execution layer`)
    if (options.accepted && Gateway.isPackageWrite(request.method, url.pathname)) {
      const ok = targets.filter((_, index) => responses[index]?.ok) as string[]
      // The write already happened; failing to note it must not turn the caller's success into an error.
      if (ok.length > 0)
        await Promise.resolve(options.accepted(ok)).catch((error: unknown) =>
          options.log?.(`${requestID} could not record the package write: ${error instanceof Error ? error.message : String(error)}`),
        )
    }
    if (journaled !== undefined)
      await options.journal!
        .settled(journaled, targets.filter((_, index) => responses[index]?.ok) as string[])
        .catch((error: unknown) =>
          options.log?.(`${requestID} could not settle the platform write: ${error instanceof Error ? error.message : String(error)}`),
        )
    // The first answer is the one the caller sees; a layer that is down must not fail the whole write.
    const response = responses.find((candidate) => candidate !== undefined)
    if (!response) return reject(request, 502, "Execution layer unavailable")

    if (login)
      await options.attempts!.record(login, response.ok).catch((error: unknown) =>
        options.log?.(`${requestID} could not record the sign-in attempt: ${error instanceof Error ? error.message : String(error)}`),
      )

    const deleted = request.method === "DELETE" && response.ok ? DELETED_ORGANIZATION.exec(url.pathname)?.[1] : undefined
    if (deleted) await options.released?.(deleted)
    if (response.ok && request.method !== "GET" && ACCOUNT_WRITE.test(url.pathname)) {
      invalidate()
      await Promise.resolve(options.invalidated?.()).catch((error: unknown) =>
        options.log?.(`${requestID} could not tell other gateways about the account write: ${error instanceof Error ? error.message : String(error)}`),
      )
    }

    const out = new Headers(response.headers)
    for (const name of [...HOP_BY_HOP, "content-encoding"]) out.delete(name)
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: out })
  }

  const websocket = {
    open(ws: ServerWebSocket<Socket>) {
      const peer = new WebSocket(ws.data.target)
      peer.binaryType = "arraybuffer"
      ws.data.peer = peer
      peer.onopen = () => ws.data.queued.splice(0).forEach((message) => peer.send(message))
      peer.onmessage = (event) => ws.send(event.data as string | ArrayBuffer)
      peer.onclose = (event) => ws.close(event.code === 1005 ? 1000 : event.code, event.reason)
      peer.onerror = () => ws.close(1011, "Execution layer unavailable")
    },
    message(ws: ServerWebSocket<Socket>, message: string | Buffer<ArrayBuffer>) {
      const peer = ws.data.peer
      if (peer?.readyState === WebSocket.OPEN) peer.send(message)
      else ws.data.queued.push(message)
    },
    close(ws: ServerWebSocket<Socket>) {
      ws.data.peer?.close()
    },
  }

  // Whatever goes wrong inside (Redis down, a malformed request) is an answer the browser can read, not a dropped
  // connection it reports as a network error.
  const guarded = async (
    request: Request,
    server: { upgrade: (request: Request, init: { data: Socket }) => boolean },
  ) => {
    const url = new URL(request.url)
    if (options.health && request.method === "GET" && url.pathname === "/health") {
      const health = await Promise.resolve(options.health()).catch(() => ({ ok: false }))
      return Response.json(health, { status: health.ok ? 200 : 503 })
    }
    if (options.ui && url.pathname !== "/api" && !url.pathname.startsWith("/api/")) return options.ui(request)
    const caller = request.headers.get(REQUEST_ID_HEADER)
    const requestID = caller && REQUEST_ID.test(caller) ? caller : crypto.randomUUID()
    const response = await fetchHandler(request, server, requestID).catch((error: unknown) => {
      options.log?.(`${requestID} gateway error: ${error instanceof Error ? error.message : String(error)}`)
      return reject(request, 503, "Gateway unavailable")
    })
    // A WebSocket upgrade has no response to tag.
    if (!response) return response
    response.headers.set(REQUEST_ID_HEADER, requestID)
    if (response.status >= 500) options.log?.(`${requestID} ${request.method} ${url.pathname} -> ${response.status}`)
    return response
  }

  return { fetch: guarded, websocket, invalidate }
}

type Session = {
  userID: string
  employeeID: string
  admin: boolean
  organizationID?: string
  organizationAdmin: boolean
  settingsPages: readonly string[]
  organizations: Gateway.Actor["organizations"]
}

function toActor(session: Session): Gateway.Actor {
  return {
    userID: session.userID,
    employeeID: session.employeeID,
    admin: session.admin,
    organizationID: session.organizationID,
    organizationAdmin: session.organizationAdmin,
    settingsPages: session.settingsPages,
    organizations: session.organizations,
  }
}

// The web app sends the session token as a Basic password; WebSocket and EventSource clients put it in the query.
function credential(request: Request, url: URL) {
  const encoded =
    url.searchParams.get("auth_token") ?? /^Basic\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]
  if (!encoded) return undefined
  // Buffer decoding is lenient where atob throws, so a malformed header is just a token that matches nothing.
  const raw = Buffer.from(encoded, "base64").toString()
  return raw.slice(raw.indexOf(":") + 1) || undefined
}

// Answers Auth gives itself never reach the execution layer's CORS handling, so a browser would report them as network
// errors instead of reading the status. They carry no data, so any origin may read them.
async function loginEmployee(request: Request) {
  const body = (await request.clone().json().catch(() => undefined)) as { employeeID?: unknown } | undefined
  return typeof body?.employeeID === "string" ? body.employeeID.trim().toLowerCase() : undefined
}

function reject(request: Request, status: number, message: string, tag = "GatewayError") {
  const origin = request.headers.get("origin")
  return Response.json(
    { _tag: tag, message },
    { status, headers: origin ? { "access-control-allow-origin": origin, vary: "origin" } : undefined },
  )
}

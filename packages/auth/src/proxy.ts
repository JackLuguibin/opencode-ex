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
}

type Socket = { target: string; peer?: WebSocket; queued: (string | Uint8Array<ArrayBuffer>)[] }

// Accounts are shared by every execution layer, so any of them can resolve a token. Entries are short-lived so a revoked
// token stops working quickly without a lookup on every request of a busy SSE client.
const ACCOUNT_TTL_MS = 5_000

const DELETED_ORGANIZATION = /^\/api\/organization\/(org_[A-Za-z0-9]+)\/?$/

const HOP_BY_HOP = ["connection", "keep-alive", "transfer-encoding", "upgrade", "host", "content-length"]

export function make(options: Options) {
  const cache = new Map<string, { actor: Gateway.Actor | undefined; expires: number }>()

  // `undefined` means the token is not valid; "unavailable" means no execution layer could say, which must not look
  // like a sign-out to the web app.
  async function resolve(token: string): Promise<Gateway.Actor | undefined | "unavailable"> {
    const hit = cache.get(token)
    if (hit && hit.expires > Date.now()) return hit.actor
    const upstream = await options.upstream()
    if (!upstream) return "unavailable"
    const response = await fetch(`${upstream}/api/auth/session`, {
      headers: { authorization: `Basic ${btoa(`opencode:${token}`)}` },
    }).catch(() => undefined)
    if (!response || response.status >= 500) return "unavailable"
    const actor = response.ok ? toActor((await response.json()) as Session) : undefined
    cache.set(token, { actor, expires: Date.now() + ACCOUNT_TTL_MS })
    return actor
  }

  async function fetchHandler(
    request: Request,
    server: { upgrade: (request: Request, init: { data: Socket }) => boolean },
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

    // A body can only be read once; a write to several layers needs a copy for each.
    const hasBody = request.method !== "GET" && request.method !== "HEAD"
    const body = hasBody ? (broadcast ? await request.arrayBuffer() : request.body) : undefined
    const responses = await Promise.all(
      targets.map((target) =>
        fetch(`${target}${url.pathname}${url.search}`, {
          method: request.method,
          headers,
          body,
          redirect: "manual",
          // @ts-expect-error Bun streams a request body only when told the length is not known up front.
          duplex: "half",
        }).catch(() => undefined),
      ),
    )
    // The first answer is the one the caller sees; a layer that is down must not fail the whole write.
    const response = responses.find((candidate) => candidate !== undefined)
    if (!response) return reject(request, 502, "Execution layer unavailable")

    const deleted = request.method === "DELETE" && response.ok ? DELETED_ORGANIZATION.exec(url.pathname)?.[1] : undefined
    if (deleted) await options.released?.(deleted)

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
  const guarded: typeof fetchHandler = (request, server) =>
    fetchHandler(request, server).catch(() => reject(request, 503, "Gateway unavailable"))

  return { fetch: guarded, websocket }
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
function reject(request: Request, status: number, message: string, tag = "GatewayError") {
  const origin = request.headers.get("origin")
  return Response.json(
    { _tag: tag, message },
    { status, headers: origin ? { "access-control-allow-origin": origin, vary: "origin" } : undefined },
  )
}

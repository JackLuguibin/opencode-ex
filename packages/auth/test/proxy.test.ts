import { afterAll, afterEach, expect, setSystemTime, test } from "bun:test"
import { Gateway } from "@opencode/protocol/gateway"
import { Proxy } from "../src/proxy.js"

const secret = "gateway-secret"
const actor: Gateway.Actor = {
  userID: "usr_1",
  employeeID: "1001",
  admin: false,
  organizationID: "org_1",
  organizationAdmin: false,
  settingsPages: ["providers"],
  organizations: [{ id: "org_1", name: "Acme" }],
}

// A stand-in execution layer: it owns the identity endpoints and echoes what it receives otherwise.
const upstream = Bun.serve({
  port: 0,
  async fetch(request, server) {
    const url = new URL(request.url)
    if (url.pathname === "/api/auth/session") {
      const ok = request.headers.get("authorization") === `Basic ${btoa("opencode:good-token")}`
      return ok ? Response.json(actor) : new Response("no", { status: 401 })
    }
    if (url.pathname === "/ws") return server.upgrade(request) ? undefined : new Response("no", { status: 400 })
    if (url.pathname === "/api/stream")
      return new Response(
        new ReadableStream({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode("data: one\n\n"))
            await Bun.sleep(30)
            controller.enqueue(new TextEncoder().encode("data: two\n\n"))
            controller.close()
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    return Response.json({
      method: request.method,
      query: url.search,
      authorization: request.headers.get("authorization"),
      requestID: request.headers.get("x-request-id"),
      actor: Gateway.verify(secret, request.headers.get(Gateway.ACTOR_HEADER) ?? ""),
      body: request.method === "POST" ? await request.text() : undefined,
    })
  },
  websocket: {
    message(ws, message) {
      ws.send(`echo:${message}`)
    },
  },
})

const proxy = Proxy.make({
  secret,
  upstream: () => `http://127.0.0.1:${upstream.port}`,
  all: () => [`http://127.0.0.1:${upstream.port}`],
})
const gateway = Bun.serve({
  port: 0,
  fetch: (request, server) => proxy.fetch(request, server),
  websocket: proxy.websocket,
})
const base = `http://127.0.0.1:${gateway.port}`
const basic = (token: string) => ({ authorization: `Basic ${btoa(`opencode:${token}`)}` })

afterAll(() => {
  gateway.stop(true)
  upstream.stop(true)
})

test("a request without a valid token never reaches the execution layer", async () => {
  expect((await fetch(`${base}/api/project`, { headers: { origin: "http://localhost:3000" } })).headers.get("access-control-allow-origin")).toBe("http://localhost:3000")
  expect((await fetch(`${base}/api/project`)).status).toBe(401)
  expect((await fetch(`${base}/api/project`, { headers: basic("bad-token") })).status).toBe(401)
})

test("a valid token is replaced by a signed actor, and the token is not forwarded", async () => {
  const response = await fetch(`${base}/api/project?x=1`, { headers: basic("good-token") })
  const body = (await response.json()) as { authorization: string | null; actor: Gateway.Actor; query: string }
  expect(body.authorization).toBeNull()
  expect(body.actor).toEqual({ ...actor })
  expect(body.query).toBe("?x=1")
})

test("a client cannot smuggle its own actor header past the gateway", async () => {
  const forged = Gateway.sign(secret, { ...actor, admin: true })
  const response = await fetch(`${base}/api/project`, { headers: { ...basic("good-token"), [Gateway.ACTOR_HEADER]: forged } })
  expect(((await response.json()) as { actor: Gateway.Actor }).actor.admin).toBe(false)
  expect((await fetch(`${base}/api/project`, { headers: { [Gateway.ACTOR_HEADER]: forged } })).status).toBe(401)
})

test("the token in the query string authenticates event streams and is stripped", async () => {
  const token = btoa("opencode:good-token")
  const response = await fetch(`${base}/api/project?auth_token=${encodeURIComponent(token)}&y=2`)
  const body = (await response.json()) as { actor: Gateway.Actor; query: string }
  expect(body.actor.userID).toBe("usr_1")
  expect(body.query).toBe("?y=2")
})

test("identity endpoints pass through with the user's own token", async () => {
  expect((await fetch(`${base}/api/auth/session`, { headers: basic("good-token") })).status).toBe(200)
  expect((await fetch(`${base}/api/auth/session`, { headers: basic("bad-token") })).status).toBe(401)
})

test("organization routes are identity-owned and keep the user's own token", async () => {
  const response = await fetch(`${base}/api/organization`, { headers: basic("good-token") })
  const body = (await response.json()) as { authorization: string | null; actor: unknown }
  expect(body.authorization).toBe(`Basic ${btoa("opencode:good-token")}`)
  expect(body.actor).toBeUndefined()
})

test("request bodies and server-sent events stream through", async () => {
  const post = await fetch(`${base}/api/project`, { method: "POST", headers: basic("good-token"), body: "hello" })
  expect(((await post.json()) as { body: string }).body).toBe("hello")
  const reader = (await fetch(`${base}/api/stream`, { headers: basic("good-token") })).body!.getReader()
  const first = new TextDecoder().decode((await reader.read()).value)
  expect(first).toBe("data: one\n\n")
})

test("websocket messages are relayed in both directions", async () => {
  const socket = new WebSocket(`ws://127.0.0.1:${gateway.port}/ws`)
  const reply = await new Promise<string>((resolve) => {
    socket.onopen = () => socket.send("ping")
    socket.onmessage = (event) => resolve(String(event.data))
  })
  expect(reply).toBe("echo:ping")
  socket.close()
})

test("an unreachable execution layer is a bad gateway, not a crash", async () => {
  const dead = Proxy.make({ secret, upstream: () => "http://127.0.0.1:1", all: () => ["http://127.0.0.1:1"] })
  const server = Bun.serve({ port: 0, fetch: (request, s) => dead.fetch(request, s), websocket: dead.websocket })
  expect((await fetch(`http://127.0.0.1:${server.port}/api/auth/login`, { method: "POST" })).status).toBe(502)
  server.stop(true)
})

test("an organization's requests go to the layer it is pinned to, and global writes reach every layer", async () => {
  const seen: string[] = []
  const layer = (name: string) =>
    Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === "/api/auth/session") return Response.json(actor)
        seen.push(`${name} ${request.method} ${url.pathname}`)
        return Response.json({ name })
      },
    })
  const a = layer("a")
  const b = layer("b")
  const pinned: Record<string, string> = { org_1: `http://127.0.0.1:${b.port}` }
  const routed = Proxy.make({
    secret,
    upstream: (organizationID) => (organizationID ? pinned[organizationID] : `http://127.0.0.1:${a.port}`),
    all: () => [`http://127.0.0.1:${a.port}`, `http://127.0.0.1:${b.port}`],
  })
  const server = Bun.serve({ port: 0, fetch: (request, s) => routed.fetch(request, s), websocket: routed.websocket })
  const url = `http://127.0.0.1:${server.port}`

  expect(await (await fetch(`${url}/api/project`, { headers: basic("good-token") })).json()).toEqual({ name: "b" })
  await fetch(`${url}/api/package/skill/x`, { method: "DELETE", headers: basic("good-token") })
  await fetch(`${url}/api/package`, { method: "POST", headers: basic("good-token"), body: "zip" })
  await fetch(`${url}/api/package`, { headers: basic("good-token") })
  expect(seen.sort()).toEqual(
    [
      "b GET /api/project",
      "a DELETE /api/package/skill/x",
      "b DELETE /api/package/skill/x",
      "a POST /api/package",
      "b POST /api/package",
      "b GET /api/package",
    ].sort(),
  )
  delete pinned.org_1
  expect((await fetch(`${url}/api/project`, { headers: basic("good-token") })).status).toBe(503)
  for (const stop of [server, a, b]) stop.stop(true)
})

test("an unreachable or missing execution layer is 503 for a signed-in user, never a 401 that signs them out", async () => {
  for (const upstreamURL of ["http://127.0.0.1:1", undefined]) {
    const down = Proxy.make({ secret, upstream: () => upstreamURL, all: () => [] })
    const server = Bun.serve({ port: 0, fetch: (request, s) => down.fetch(request, s), websocket: down.websocket })
    expect((await fetch(`http://127.0.0.1:${server.port}/api/project`, { headers: basic("good-token") })).status).toBe(503)
    server.stop(true)
  }
})

test("a failing placement lookup and a malformed credential are answered, not thrown", async () => {
  const broken = Proxy.make({
    secret,
    upstream: () => {
      throw new Error("redis down")
    },
    all: () => [],
  })
  const server = Bun.serve({ port: 0, fetch: (request, s) => broken.fetch(request, s), websocket: broken.websocket })
  const url = `http://127.0.0.1:${server.port}`
  const origin = { origin: "http://localhost:3000" }
  const failing = await fetch(`${url}/api/project`, { headers: { ...basic("good-token"), ...origin } })
  expect(failing.status).toBe(503)
  expect(failing.headers.get("access-control-allow-origin")).toBe("http://localhost:3000")
  // A malformed credential is just no credential: signed out, answered, not a crash.
  expect((await fetch(`${url}/api/project`, { headers: { authorization: "Basic ***" } })).status).toBe(401)
  expect((await fetch(`${url}/api/event?auth_token=%25%25%25`)).status).toBe(401)
  server.stop(true)
})

test("a terminal socket without a credential is sent to the layer of the organization in its directory", async () => {
  const targets: string[] = []
  const routed = Proxy.make({
    secret,
    upstream: (organizationID) => {
      targets.push(String(organizationID))
      return `http://127.0.0.1:${upstream.port}`
    },
    all: () => [],
  })
  const server = Bun.serve({ port: 0, fetch: (request, s) => routed.fetch(request, s), websocket: routed.websocket })
  const directory = encodeURIComponent("/data/opencode/organizations/org_abc123/默认目录")
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws?location[directory]=${directory}&ticket=t`)
  await new Promise((resolve) => (socket.onopen = resolve))
  socket.close()
  expect(targets).toContain("org_abc123")
  server.stop(true)
})

test("an organization's placement is released only when its deletion succeeded", async () => {
  const released: string[] = []
  let status = 500
  const layer = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/api/auth/session") return Response.json(actor)
      return new Response(null, { status })
    },
  })
  const routed = Proxy.make({
    secret,
    upstream: () => `http://127.0.0.1:${layer.port}`,
    all: () => [`http://127.0.0.1:${layer.port}`],
    released: (organizationID) => void released.push(organizationID),
  })
  const server = Bun.serve({ port: 0, fetch: (request, s) => routed.fetch(request, s), websocket: routed.websocket })
  const url = `http://127.0.0.1:${server.port}/api/organization/org_9`

  await fetch(url, { method: "DELETE", headers: basic("good-token") })
  expect(released).toEqual([])
  status = 204
  await fetch(`${url}/member/1001`, { method: "DELETE", headers: basic("good-token") })
  expect(released).toEqual([])
  await fetch(url, { method: "DELETE", headers: basic("good-token") })
  expect(released).toEqual(["org_9"])
  for (const stop of [server, layer]) stop.stop(true)
})

test("every response carries a request id, reuses a safe caller id and passes it to the execution layer", async () => {
  const generated = await fetch(`${base}/api/project`, { headers: basic("good-token") })
  const id = generated.headers.get("x-request-id")!
  expect(id).toMatch(/^[0-9a-f-]{36}$/)
  expect(((await generated.json()) as { requestID: string }).requestID).toBe(id)

  const kept = await fetch(`${base}/api/project`, { headers: { ...basic("good-token"), "x-request-id": "req_abc-1.2" } })
  expect(kept.headers.get("x-request-id")).toBe("req_abc-1.2")
  expect(((await kept.json()) as { requestID: string }).requestID).toBe("req_abc-1.2")

  // Anything that could break a log line is replaced rather than echoed.
  const unsafe = await fetch(`${base}/api/project`, { headers: { ...basic("good-token"), "x-request-id": "a b;c" } })
  expect(unsafe.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/)
  expect((await fetch(`${base}/api/project`)).headers.get("x-request-id")).toBeTruthy()
})

test("failures are logged with their request id instead of disappearing", async () => {
  const lines: string[] = []
  const down = Proxy.make({ secret, upstream: () => "http://127.0.0.1:1", all: () => [], log: (line) => lines.push(line) })
  const server = Bun.serve({ port: 0, fetch: (request, s) => down.fetch(request, s), websocket: down.websocket })
  const response = await fetch(`http://127.0.0.1:${server.port}/api/auth/login`, {
    method: "POST",
    headers: { "x-request-id": "trace-1" },
  })
  expect(response.status).toBe(502)
  expect(lines.some((line) => line.startsWith("trace-1 upstream http://127.0.0.1:1 failed"))).toBe(true)
  expect(lines).toContain("trace-1 POST /api/auth/login -> 502")
  server.stop(true)
})

test("/health answers without a token and reports an unhealthy dependency as 503", async () => {
  let ok = true
  const probed = Proxy.make({ secret, upstream: () => undefined, all: () => [], health: () => ({ ok, runtimes: 2 }) })
  const server = Bun.serve({ port: 0, fetch: (request, s) => probed.fetch(request, s), websocket: probed.websocket })
  const url = `http://127.0.0.1:${server.port}/health`
  const healthy = await fetch(url)
  expect(healthy.status).toBe(200)
  expect(await healthy.json()).toEqual({ ok: true, runtimes: 2 })
  ok = false
  expect((await fetch(url)).status).toBe(503)
  server.stop(true)
})

test("the layers that accepted a global package write are reported, and only for such writes", async () => {
  const layer = (status: number) =>
    Bun.serve({
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === "/api/auth/session") return Response.json(actor)
        return new Response(null, { status })
      },
    })
  const good = layer(204)
  const broken = layer(500)
  const urls = [`http://127.0.0.1:${good.port}`, `http://127.0.0.1:${broken.port}`]
  const reported: string[][] = []
  const lines: string[] = []
  const routed = Proxy.make({
    secret,
    upstream: () => urls[0],
    all: () => urls,
    accepted: (accepted) => void reported.push([...accepted]),
    log: (line) => lines.push(line),
  })
  const server = Bun.serve({ port: 0, fetch: (request, s) => routed.fetch(request, s), websocket: routed.websocket })
  const url = `http://127.0.0.1:${server.port}`

  await fetch(`${url}/api/package`, { method: "POST", headers: basic("good-token"), body: "zip" })
  await fetch(`${url}/api/package`, { headers: basic("good-token") })
  await fetch(`${url}/api/experimental/config`, { method: "PATCH", headers: basic("good-token"), body: "{}" })
  expect(reported).toEqual([[urls[0]]])

  // A write nobody accepted is not a change anyone can be behind on.
  broken.stop(true)
  good.stop(true)
  const failing = layer(500)
  const none = Proxy.make({
    secret,
    upstream: () => `http://127.0.0.1:${failing.port}`,
    all: () => [`http://127.0.0.1:${failing.port}`],
    accepted: (accepted) => void reported.push([...accepted]),
  })
  const noneServer = Bun.serve({ port: 0, fetch: (request, s) => none.fetch(request, s), websocket: none.websocket })
  await fetch(`http://127.0.0.1:${noneServer.port}/api/package`, { method: "POST", headers: basic("good-token"), body: "zip" })
  expect(reported).toHaveLength(1)
  for (const stop of [server, noneServer, failing]) stop.stop(true)
})

test("failing to note a package write does not fail the write", async () => {
  const layer = Bun.serve({
    port: 0,
    fetch: (request) => (new URL(request.url).pathname === "/api/auth/session" ? Response.json(actor) : new Response(null, { status: 204 })),
  })
  const lines: string[] = []
  const routed = Proxy.make({
    secret,
    upstream: () => `http://127.0.0.1:${layer.port}`,
    all: () => [`http://127.0.0.1:${layer.port}`],
    accepted: () => Promise.reject(new Error("redis down")),
    log: (line) => lines.push(line),
  })
  const server = Bun.serve({ port: 0, fetch: (request, s) => routed.fetch(request, s), websocket: routed.websocket })
  const response = await fetch(`http://127.0.0.1:${server.port}/api/package`, { method: "POST", headers: basic("good-token"), body: "zip" })
  expect(response.status).toBe(204)
  expect(lines.some((line) => line.includes("redis down"))).toBe(true)
  for (const stop of [server, layer]) stop.stop(true)
})

test("deleting an organization goes to the layer it is pinned to, not to whichever layer comes first", async () => {
  const seen: string[] = []
  const layer = (name: string) =>
    Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === "/api/auth/session") return Response.json(actor)
        seen.push(`${name} ${request.method} ${url.pathname}`)
        return new Response(null, { status: 204 })
      },
    })
  const first = layer("first")
  const pinned = layer("pinned")
  const routed = Proxy.make({
    secret,
    upstream: (organizationID) => `http://127.0.0.1:${organizationID === "org_7" ? pinned.port : first.port}`,
    all: () => [],
  })
  const server = Bun.serve({ port: 0, fetch: (request, s) => routed.fetch(request, s), websocket: routed.websocket })
  await fetch(`http://127.0.0.1:${server.port}/api/organization/org_7`, { method: "DELETE", headers: basic("good-token") })
  expect(seen).toEqual(["pinned DELETE /api/organization/org_7"])
  for (const stop of [server, first, pinned]) stop.stop(true)
})

// Opening a session sends a burst of requests; each checking the token against the shared store is what made it slow.
function countingGateway(answer: () => Response | Promise<Response> = () => Response.json(actor)) {
  const lookups: string[] = []
  const layer = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/api/auth/session" && request.method === "GET") {
        lookups.push(request.headers.get("authorization") ?? "")
        return answer()
      }
      return new Response(null, { status: 204 })
    },
  })
  const routed = Proxy.make({
    secret,
    upstream: () => `http://127.0.0.1:${layer.port}`,
    all: () => [`http://127.0.0.1:${layer.port}`],
  })
  const server = Bun.serve({ port: 0, fetch: (request, s) => routed.fetch(request, s), websocket: routed.websocket })
  return { lookups, url: `http://127.0.0.1:${server.port}`, stop: () => [server, layer].forEach((item) => item.stop(true)) }
}

afterEach(() => setSystemTime())

test("requests that arrive together share one token lookup", async () => {
  const gateway = countingGateway(async () => {
    await Bun.sleep(30)
    return Response.json(actor)
  })
  const statuses = await Promise.all(
    Array.from({ length: 20 }, async () => (await fetch(`${gateway.url}/api/project`, { headers: basic("good-token") })).status),
  )
  expect(statuses.every((status) => status === 204)).toBe(true)
  expect(gateway.lookups).toHaveLength(1)
  gateway.stop()
})

test("an actor past its refresh age is answered from the cache while one lookup renews it", async () => {
  const gateway = countingGateway()
  const call = async () => (await fetch(`${gateway.url}/api/project`, { headers: basic("good-token") })).status
  const start = Date.now()
  await call()
  expect(gateway.lookups).toHaveLength(1)
  setSystemTime(start + 10_000)
  await Promise.all([call(), call(), call()])
  await Bun.sleep(20)
  expect(gateway.lookups).toHaveLength(2)
  setSystemTime(start + 10_000 + 61_000)
  await call()
  expect(gateway.lookups).toHaveLength(3)
  gateway.stop()
})

test("signing out or switching organization drops every cached actor", async () => {
  const gateway = countingGateway()
  const call = (path: string, method = "GET") => fetch(`${gateway.url}${path}`, { method, headers: basic("good-token") })
  await call("/api/project")
  await call("/api/project")
  expect(gateway.lookups).toHaveLength(1)
  await call("/api/auth/organization", "POST")
  await call("/api/project")
  expect(gateway.lookups).toHaveLength(2)
  await call("/api/preference/user/x", "PUT")
  await call("/api/project")
  expect(gateway.lookups).toHaveLength(2)
  gateway.stop()
})

test("an account write through one gateway drops the identities another gateway cached", async () => {
  const lookups: string[] = []
  const layer = Bun.serve({
    port: 0,
    fetch: (request) => {
      if (new URL(request.url).pathname !== "/api/auth/session") return new Response(null, { status: 204 })
      lookups.push(request.headers.get("authorization") ?? "")
      return Response.json(actor)
    },
  })
  const options = { secret, upstream: () => `http://127.0.0.1:${layer.port}`, all: () => [`http://127.0.0.1:${layer.port}`] }
  const b = Proxy.make(options)
  const a = Proxy.make({ ...options, invalidated: () => b.invalidate() })
  const servers = [a, b].map((item) => Bun.serve({ port: 0, fetch: (request, s) => item.fetch(request, s), websocket: item.websocket }))
  const call = (server: (typeof servers)[number], path: string, method = "GET") =>
    fetch(`http://127.0.0.1:${server.port}${path}`, { method, headers: basic("good-token") })
  try {
    await call(servers[1]!, "/api/project")
    await call(servers[1]!, "/api/project")
    expect(lookups).toHaveLength(1)
    // The switch happens on gateway a; b must not keep answering with the organization it cached.
    await call(servers[0]!, "/api/auth/organization", "POST")
    await call(servers[1]!, "/api/project")
    expect(lookups).toHaveLength(3)
    // A write that changes nobody tells nobody: both gateways keep what they cached.
    await call(servers[0]!, "/api/project")
    expect(lookups).toHaveLength(4)
    await call(servers[0]!, "/api/preference/user/x", "PUT")
    await call(servers[1]!, "/api/project")
    expect(lookups).toHaveLength(4)
  } finally {
    servers.forEach((item) => item.stop(true))
    layer.stop(true)
  }
})

test("a platform write is written down before it is sent, and settled with the layers that took it", async () => {
  let status = 200
  const layer = Bun.serve({ port: 0, fetch: (request) => (new URL(request.url).pathname === "/api/auth/session" ? Response.json(actor) : new Response("{}", { status })) })
  const url = `http://127.0.0.1:${layer.port}`
  const events: unknown[] = []
  const journaled = Proxy.make({
    secret,
    upstream: () => url,
    all: () => [url],
    journal: {
      begin: async (entry) => {
        events.push(["begin", entry.method, entry.path, new TextDecoder().decode(entry.body), entry.actor.userID])
        return 7
      },
      settled: async (seq, accepted) => void events.push(["settled", seq, accepted]),
    },
  })
  const server = Bun.serve({ port: 0, fetch: (request, s) => journaled.fetch(request, s), websocket: journaled.websocket })
  const patch = () =>
    fetch(`http://127.0.0.1:${server.port}/api/plugin/update`, { method: "POST", headers: basic("good-token"), body: '{"a":1}' })
  try {
    await patch()
    // A write the layer refuses is settled with nobody, so it can be dropped.
    status = 400
    await patch()
    // Other writes are not journaled, and a config write belongs to the organization's layer, so it is not a broadcast.
    await fetch(`http://127.0.0.1:${server.port}/api/package/x`, { method: "POST", headers: basic("good-token"), body: "{}" })
    await fetch(`http://127.0.0.1:${server.port}/api/experimental/config`, { method: "PATCH", headers: basic("good-token"), body: '{"shell":"x"}' })
    expect(Gateway.isBroadcast("PATCH", "/api/experimental/config")).toBe(false)
    expect(Gateway.isBroadcast("POST", "/api/plugin/check")).toBe(false)
    expect(events).toEqual([
      ["begin", "POST", "/api/plugin/update", '{"a":1}', "usr_1"],
      ["settled", 7, [url]],
      ["begin", "POST", "/api/plugin/update", '{"a":1}', "usr_1"],
      ["settled", 7, []],
    ])
  } finally {
    server.stop(true)
    layer.stop(true)
  }
})

test("repeated failed sign-ins for one employee ID are refused until a correct one clears them", async () => {
  let correct = false
  const layer = Bun.serve({ port: 0, fetch: () => (correct ? Response.json({ token: "t" }) : new Response("no", { status: 401 })) })
  const failures = new Map<string, number>()
  const limited = Proxy.make({
    secret,
    upstream: () => `http://127.0.0.1:${layer.port}`,
    all: () => [],
    attempts: {
      blocked: async (id) => (failures.get(id) ?? 0) >= 3,
      record: async (id, ok) => void (ok ? failures.delete(id) : failures.set(id, (failures.get(id) ?? 0) + 1)),
    },
  })
  const front = Bun.serve({ port: 0, fetch: (request, server) => limited.fetch(request, server), websocket: limited.websocket })
  const login = (employeeID: string) =>
    fetch(`http://127.0.0.1:${front.port}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ employeeID, password: "x" }),
    })
  try {
    for (const _ of [1, 2, 3]) expect((await login("8900")).status).toBe(401)
    expect((await login("8900")).status).toBe(429)
    // Another employee ID is not affected, and the count is case-insensitive.
    expect((await login("8901")).status).toBe(401)
    correct = true
    failures.delete("8900")
    expect((await login("8900")).status).toBe(200)
    expect(failures.has("8900")).toBe(false)
  } finally {
    front.stop(true)
    layer.stop(true)
  }
})

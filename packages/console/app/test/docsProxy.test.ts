import { afterAll, expect, test } from "bun:test"
import { proxyDocs } from "../src/lib/docs-proxy"

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/v2/redirect") return Response.redirect(new URL("/v2/docs/", request.url), 301)
    return Response.json(
      {
        path: url.pathname,
        query: url.search,
        accept: request.headers.get("accept"),
        language: request.headers.get("accept-language"),
        authorization: request.headers.get("authorization"),
        cookie: request.headers.get("cookie"),
      },
      { headers: { "x-docs-source": "ex" } },
    )
  },
})
afterAll(() => server.stop(true))

test("serves the configured ex documentation path and query without forwarding login credentials", async () => {
  const request = new Request("https://gateway.example/v2/docs/?q=agent", {
    headers: {
      accept: "text/markdown",
      "accept-language": "zh-CN",
      authorization: "Bearer test-only",
      cookie: "login=test-only",
    },
  })
  const response = await proxyDocs(request, "/v2/docs/", server.url.origin)
  expect(response.status).toBe(200)
  expect(response.headers.get("x-docs-source")).toBe("ex")
  expect(await response.json()).toEqual({
    path: "/v2/docs/",
    query: "?q=agent",
    accept: "text/markdown",
    language: "zh-CN",
    authorization: null,
    cookie: null,
  })
})

test("keeps documentation redirects on the gateway and supports HEAD", async () => {
  const request = new Request("https://gateway.example/v2/redirect")
  const redirect = await proxyDocs(request, "/v2/redirect", server.url.origin)
  expect(redirect.status).toBe(301)
  expect(redirect.headers.get("location")).toBe("/v2/docs/")
  const head = await proxyDocs(new Request(request.url, { method: "HEAD" }), "/v2/docs/", server.url.origin)
  expect(head.status).toBe(200)
  expect(await head.text()).toBe("")
})

test("reports an unconfigured documentation service and refuses writes", async () => {
  expect((await proxyDocs(new Request("https://gateway.example/docs"), "/docs", undefined)).status).toBe(503)
  const response = await proxyDocs(
    new Request("https://gateway.example/docs", { method: "POST" }),
    "/docs",
    server.url.origin,
  )
  expect(response.status).toBe(405)
  expect(response.headers.get("allow")).toBe("GET, HEAD")
})

import { expect } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { it } from "../../core/test/lib/effect"

process.env.OPENCODE_ADMIN_EMPLOYEE_ID = "8400"
process.env.OPENCODE_ADMIN_PASSWORD = "password-1"

const { ServerFetch } = await import("../src/fetch")

it.live("a deleted session reads as not found to every other member, and only its creator or an admin can delete it", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make({
      app: { version: "test-version" },
      database: { path: ":memory:" },
      config: { project: false },
      models: { fetch: false },
      fs: { filewatcher: false },
      password: "server-secret",
    })
    const call = (path: string, init: { method?: string; token?: string; body?: unknown; directory?: string } = {}) =>
      Effect.promise(async () => {
        const response = await handler(
          new Request(`http://opencode.local${path}`, {
            method: init.method ?? (init.body === undefined ? "GET" : "POST"),
            headers: {
              ...(init.body === undefined ? {} : { "content-type": "application/json" }),
              ...(init.token ? { authorization: `Basic ${btoa(`opencode:${init.token}`)}` } : {}),
              ...(init.directory ? { "x-opencode-directory": encodeURIComponent(init.directory) } : {}),
            },
            body: init.body === undefined ? undefined : JSON.stringify(init.body),
          }),
        )
        const text = await response.text()
        return { status: response.status, body: text ? JSON.parse(text) : undefined }
      })
    const login = (employeeID: string, password: string) =>
      call("/api/auth/login", { body: { employeeID, password } }).pipe(Effect.map((result) => result.body.token as string))

    const platform = yield* login("8400", "password-1")
    const acme = (yield* call("/api/organization", { token: platform, body: { name: "Acme" } })).body
    for (const employeeID of ["8401", "8402"])
      yield* call("/api/auth/users", { token: platform, body: { employeeID, password: "password-x", organizationID: acme.id } })
    const alice = yield* login("8401", "password-x")
    const bob = yield* login("8402", "password-x")

    const session = (yield* call("/api/auth/session", { token: alice })).body
    const target = path.join(session.organizationDirectory, "alice")
    yield* call(`/api/experimental/fs/mkdir?path=${encodeURIComponent(target)}`, { token: alice, method: "POST" })
    expect((yield* call("/api/location", { token: alice, directory: target })).status).toBe(200)
    const created = yield* call("/api/session", { token: alice, body: { location: { directory: target } }, directory: target })
    expect(created.status).toBe(200)
    const id = (created.body.data ?? created.body).id as string
    const read = (token: string) => call(`/api/session/${id}`, { token, directory: target })

    expect((yield* read(alice)).status).toBe(200)
    // Bob can open it while it exists, but cannot delete someone else's session.
    expect((yield* read(bob)).status).toBe(200)
    expect((yield* call(`/api/session/${id}`, { token: bob, method: "DELETE", directory: target })).status).toBe(403)

    // Bob's stream opened after the session existed; it must still hear that Alice deleted it.
    const stream = yield* Effect.promise(async () => {
      const response = await handler(
        new Request("http://opencode.local/api/event", {
          headers: { authorization: `Basic ${btoa(`opencode:${bob}`)}`, "x-opencode-directory": encodeURIComponent(target) },
        }),
      )
      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      let text = ""
      const done = (async () => {
        while (!text.includes("session.deleted")) {
          const chunk = await reader.read()
          if (chunk.done) return
          text += decoder.decode(chunk.value)
        }
      })()
      return { text: () => text, done, cancel: () => reader.cancel() }
    })
    yield* Effect.sleep("200 millis")

    const removed = yield* call(`/api/session/${id}`, { token: alice, method: "DELETE", directory: target })
    expect(removed.status).toBe(204)
    yield* Effect.promise(() => Promise.race([stream.done, new Promise((resolve) => setTimeout(resolve, 3000))]))
    expect(stream.text()).toContain(id)
    expect(stream.text()).toContain("session.deleted")
    yield* Effect.promise(() => stream.cancel())
    for (const token of [alice, bob, platform]) {
      const after = yield* read(token)
      expect(after).toMatchObject({ status: 404, body: { _tag: "SessionNotFoundError", sessionID: id } })
    }
    expect((yield* call(`/api/session/${id}`, { token: bob, method: "DELETE", directory: target })).status).toBe(404)
  }),
)

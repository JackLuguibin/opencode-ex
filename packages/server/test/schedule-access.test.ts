import { expect } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { it } from "../../core/test/lib/effect"

process.env.OPENCODE_ADMIN_EMPLOYEE_ID = "8000"
process.env.OPENCODE_ADMIN_PASSWORD = "password-1"

const { ServerFetch } = await import("../src/fetch")

it.live("schedule routes follow the same session ownership as the session routes", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make({
      app: { version: "test-version" },
      database: { path: ":memory:" },
      config: { project: false },
      models: { fetch: false },
      fs: { filewatcher: false },
      password: "server-secret",
    })
    const call = (route: string, init: { method?: string; token: string; body?: unknown; directory?: string }) =>
      Effect.promise(async () => {
        const response = await handler(
          new Request(`http://opencode.local${route}`, {
            method: init.method ?? (init.body === undefined ? "GET" : "POST"),
            headers: {
              ...(init.body === undefined ? {} : { "content-type": "application/json" }),
              authorization: `Basic ${btoa(`opencode:${init.token}`)}`,
              ...(init.directory ? { "x-opencode-directory": encodeURIComponent(init.directory) } : {}),
            },
            body: init.body === undefined ? undefined : JSON.stringify(init.body),
          }),
        )
        const text = await response.text()
        return { status: response.status, body: text ? JSON.parse(text) : undefined }
      })
    const anonymous = (route: string, body: unknown) =>
      Effect.promise(async () => {
        const response = await handler(
          new Request(`http://opencode.local${route}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
        )
        return (await response.json()) as { token: string }
      })
    const login = (employeeID: string, password: string) =>
      anonymous("/api/auth/login", { employeeID, password }).pipe(Effect.map((result) => result.token))

    const admin = yield* login("8000", "password-1")
    const orgA = (yield* call("/api/organization", { token: admin, body: { name: "Alpha" } })).body
    const orgB = (yield* call("/api/organization", { token: admin, body: { name: "Beta" } })).body
    yield* call("/api/auth/users", { token: admin, body: { employeeID: "8002", password: "password-2", organizationID: orgA.id } })
    yield* call("/api/auth/users", { token: admin, body: { employeeID: "8003", password: "password-3", organizationID: orgB.id } })
    yield* call("/api/auth/users", { token: admin, body: { employeeID: "8004", password: "password-4" } })
    const alice = yield* login("8002", "password-2")
    const bob = yield* login("8003", "password-3")
    const carol = yield* login("8004", "password-4")

    const switched = (yield* call("/api/auth/organization", { token: alice, body: { organizationID: orgA.id } })).body
    const folder = path.join(switched.organizationDirectory, "work")
    yield* call(`/api/experimental/fs/mkdir?path=${encodeURIComponent(folder)}`, { token: alice, method: "POST" })
    yield* call("/api/location", { token: alice, directory: folder })
    const session = (yield* call("/api/session", { token: alice, body: { location: { directory: folder } } })).body.data
    const body = { sessionID: session.id, name: "poll", when: { every: "1 hour" }, prompt: "check" }

    const created = yield* call("/api/experimental/schedule", { token: alice, body })
    expect(created.status).toBe(200)
    const id = created.body.data.id as string
    const route = `/api/experimental/schedule/${id}`

    for (const stranger of [bob, carol]) {
      expect((yield* call(`/api/session/${session.id}`, { token: stranger })).status).toBe(404)
      expect((yield* call(`/api/experimental/schedule?sessionID=${session.id}`, { token: stranger })).status).toBe(404)
      expect((yield* call(route, { token: stranger })).status).toBe(404)
      // The overview of every session's schedules leaves out the ones the caller cannot see.
      expect((yield* call("/api/experimental/schedule", { token: stranger })).body.data).toEqual([])
      expect((yield* call("/api/experimental/schedule", { token: stranger, body })).status).toBe(404)
      expect((yield* call(`${route}/pause`, { token: stranger, method: "POST" })).status).toBe(404)
      expect((yield* call(`${route}/resume`, { token: stranger, method: "POST" })).status).toBe(404)
      expect((yield* call(route, { token: stranger, method: "DELETE" })).status).toBe(404)
    }

    // Nothing the strangers tried changed it, and the owner still manages it.
    expect((yield* call(route, { token: alice })).body.data).toMatchObject({ status: "active", runCount: 0 })
    expect((yield* call(`/api/experimental/schedule?sessionID=${session.id}`, { token: alice })).body.data).toHaveLength(1)
    expect((yield* call("/api/experimental/schedule", { token: alice })).body.data).toHaveLength(1)
    expect((yield* call(`${route}/pause`, { token: alice, method: "POST" })).body.data.status).toBe("paused")
    expect((yield* call(`${route}/resume`, { token: alice, method: "POST" })).body.data.status).toBe("active")
    expect((yield* call(route, { token: alice, method: "DELETE" })).status).toBe(204)
  }),
)

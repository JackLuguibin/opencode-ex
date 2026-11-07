import { expect } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { it } from "../../core/test/lib/effect"

process.env.OPENCODE_ADMIN_EMPLOYEE_ID = "8000"
process.env.OPENCODE_ADMIN_PASSWORD = "password-1"

const { ServerFetch } = await import("../src/fetch")

it.live("queues belong to their creator, their organization's admins and platform admins", () =>
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

    const platform = yield* login("8000", "password-1")
    const acme = (yield* call("/api/organization", { token: platform, body: { name: "Acme" } })).body
    const globex = (yield* call("/api/organization", { token: platform, body: { name: "Globex" } })).body
    for (const [employeeID, organizationID] of [
      ["8101", acme.id],
      ["8102", acme.id],
      ["8103", acme.id],
      ["8201", globex.id],
    ])
      yield* call("/api/auth/users", { token: platform, body: { employeeID, password: "password-x", organizationID } })
    expect(
      (yield* call(`/api/organization/${acme.id}/member/8103/role`, { token: platform, method: "PUT", body: { role: "admin" } }))
        .status,
    ).toBe(200)
    const alice = yield* login("8101", "password-x")
    const bob = yield* login("8102", "password-x")
    const orgAdmin = yield* login("8103", "password-x")
    const outsider = yield* login("8201", "password-x")

    // Each member works in a folder of their own organization; opening it registers it as a project.
    const folder = (token: string, name: string) =>
      Effect.gen(function* () {
        const session = (yield* call("/api/auth/session", { token })).body
        const target = path.join(session.organizationDirectory, name)
        yield* call(`/api/experimental/fs/mkdir?path=${encodeURIComponent(target)}`, { token, method: "POST" })
        expect((yield* call("/api/location", { token, directory: target })).status).toBe(200)
        return { target, shared: path.join(session.organizationDirectory, "公共空间") }
      })
    const aliceSpace = yield* folder(alice, "alice")
    const bobSpace = yield* folder(bob, "bob")
    const outsiderSpace = yield* folder(outsider, "carol")

    const spawn = (token: string, name: string, directory: string) =>
      call("/api/experimental/queue", { token, body: { name, mode: "spawn", directory, capacity: 3, concurrency: 1 } })
    const mine = yield* spawn(alice, "alice queue", aliceSpace.target)
    const theirs = yield* spawn(bob, "bob queue", bobSpace.target)
    const foreign = yield* spawn(outsider, "carol queue", outsiderSpace.target)
    expect([mine.status, theirs.status, foreign.status]).toEqual([200, 200, 200])
    expect(mine.body.data).toMatchObject({ organizationID: acme.id })
    const names = (token: string) =>
      call("/api/experimental/queue", { token }).pipe(
        Effect.map((result) => (result.body.data as Array<{ name: string }>).map((item) => item.name).toSorted()),
      )

    // Members see only their own queues, even inside one organization.
    expect(yield* names(alice)).toEqual(["alice queue"])
    expect(yield* names(bob)).toEqual(["bob queue"])
    expect(yield* names(outsider)).toEqual(["carol queue"])
    // The organization's admin sees its members' queues but nothing of the other organization; a platform admin sees all.
    expect(yield* names(orgAdmin)).toEqual(["alice queue", "bob queue"])
    expect(yield* names(platform)).toEqual(["alice queue", "bob queue", "carol queue"])

    // Others cannot read or change a queue, and cannot tell it exists.
    const queue = `/api/experimental/queue/${mine.body.data.id}`
    for (const token of [bob, outsider]) {
      expect((yield* call(queue, { token })).status).toBe(404)
      expect((yield* call(`${queue}/items`, { token })).status).toBe(404)
      expect((yield* call(`${queue}/items`, { token, body: { prompt: "hi" } })).status).toBe(404)
      expect((yield* call(`${queue}/pause`, { token, method: "POST" })).status).toBe(404)
      expect((yield* call(queue, { token, method: "PATCH", body: { name: "mine now" } })).status).toBe(404)
      expect((yield* call(queue, { token, method: "DELETE" })).status).toBe(404)
    }
    expect((yield* call(`/api/experimental/queue/${foreign.body.data.id}`, { token: orgAdmin })).status).toBe(404)
    expect((yield* call(queue, { token: orgAdmin })).status).toBe(200)
    expect((yield* call(`${queue}/pause`, { token: platform, method: "POST" })).status).toBe(200)

    // A queue cannot point into another organization, into the shared space, or at another member's private session.
    expect((yield* spawn(outsider, "stolen", aliceSpace.target)).status).toBe(404)
    expect((yield* spawn(alice, "shared", aliceSpace.shared)).status).toBe(403)
    const session = (yield* call("/api/session", { token: alice, body: { location: { directory: aliceSpace.target } } })).body.data
    const onSession = (token: string) =>
      call("/api/experimental/queue", { token, body: { name: "feed", mode: "session", sessionID: session.id } })
    expect((yield* onSession(bob)).status).toBe(403)
    expect((yield* onSession(outsider)).status).toBe(404)
    expect((yield* onSession(alice)).status).toBe(200)

    // Deleting removes it for everyone.
    expect((yield* call(queue, { token: alice, method: "DELETE" })).status).toBe(204)
    expect(yield* names(platform)).not.toContain("alice queue")
  }),
)

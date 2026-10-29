import { expect } from "bun:test"
import { Effect } from "effect"
import { it } from "../../core/test/lib/effect"
import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { zip } from "../../core/test/lib/zip"

process.env.OPENCODE_ADMIN_EMPLOYEE_ID = "8000"
process.env.OPENCODE_ADMIN_PASSWORD = "password-1"

const { ServerFetch } = await import("../src/fetch")

const options = {
  app: { version: "test-version" },
  database: { path: ":memory:" },
  config: { project: false },
  models: { fetch: false },
  fs: { filewatcher: false },
  password: "server-secret",
} as const

it.live("an admin manages the model credentials an organization shares", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make(options)
    const call = (path: string, init: { method?: string; token?: string; body?: unknown } = {}) =>
      Effect.promise(async () => {
        const response = await handler(
          new Request(`http://opencode.local${path}`, {
            method: init.method ?? (init.body === undefined ? "GET" : "POST"),
            headers: {
              ...(init.body === undefined ? {} : { "content-type": "application/json" }),
              ...(init.token ? { authorization: `Basic ${btoa(`opencode:${init.token}`)}` } : {}),
            },
            body: init.body === undefined ? undefined : JSON.stringify(init.body),
          }),
        )
        const text = await response.text()
        return { status: response.status, body: text ? JSON.parse(text) : undefined }
      })

    const login = yield* call("/api/auth/login", { body: { employeeID: "8000", password: "password-1" } })
    expect(login.status).toBe(200)
    const token = login.body.token as string
    const organization = yield* call("/api/organization", { token, body: { name: "Acme" } })
    expect(organization.status).toBe(200)
    const base = `/api/organization/${organization.body.id}/credential`

    expect(yield* call(base, { token })).toEqual({ status: 200, body: [] })
    const created = yield* call(base, { token, body: { integrationID: "openai", key: "sk-test", label: "Team" } })
    expect(created.status).toBe(200)
    expect(created.body).toMatchObject({ integrationID: "openai", label: "Team", active: true, type: "key" })
    expect(JSON.stringify(created.body)).not.toContain("sk-test")

    const second = yield* call(base, { token, body: { integrationID: "openai", key: "sk-two" } })
    expect(second.body.active).toBe(true)
    expect((yield* call(base, { token })).body.map((item: { id: string }) => item.id)).toEqual([
      created.body.id,
      second.body.id,
    ])

    expect((yield* call(`${base}/${created.body.id}/activate`, { token, method: "POST" })).status).toBe(204)
    const listed = (yield* call(base, { token })).body as Array<{ id: string; active: boolean }>
    expect(listed.find((item) => item.active)?.id).toBe(created.body.id)

    expect((yield* call(`${base}/${created.body.id}`, { token, method: "DELETE" })).status).toBe(204)
    expect((yield* call(base, { token })).body).toHaveLength(1)
    expect((yield* call(`${base}/cred_missing`, { token, method: "DELETE" })).status).toBe(400)
    expect((yield* call(base, { token, body: { integrationID: "bad id", key: "x" } })).status).toBe(400)
    expect((yield* call("/api/organization/org_missing/credential", { token })).status).toBe(400)
  }),
)

it.live("an organization's custom provider and its models reach its members", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make(options)
    const call = (path: string, init: { method?: string; token?: string; body?: unknown } = {}) =>
      Effect.promise(async () => {
        const response = await handler(
          new Request(`http://opencode.local${path}`, {
            method: init.method ?? (init.body === undefined ? "GET" : "POST"),
            headers: {
              ...(init.body === undefined ? {} : { "content-type": "application/json" }),
              ...(init.token ? { authorization: `Basic ${btoa(`opencode:${init.token}`)}` } : {}),
            },
            body: init.body === undefined ? undefined : JSON.stringify(init.body),
          }),
        )
        const text = await response.text()
        return { status: response.status, text, body: text ? JSON.parse(text) : undefined }
      })

    const token = (yield* call("/api/auth/login", { body: { employeeID: "8000", password: "password-1" } })).body.token
    const organization = (yield* call("/api/organization", { token, body: { name: "Custom" } })).body
    yield* call(`/api/organization/${organization.id}/member`, { token, body: { employeeID: "8000" } })
    expect((yield* call("/api/auth/organization", { token, body: { organizationID: organization.id } })).status).toBe(200)

    const base = `/api/organization/${organization.id}/provider`
    const invalid = yield* call(`${base}/acme`, {
      token,
      method: "PUT",
      body: { name: "Acme", baseURL: "ftp://nope", models: ["m"] },
    })
    expect(invalid.status).toBe(400)
    const saved = yield* call(`${base}/acme`, {
      token,
      method: "PUT",
      body: { name: "Acme AI", baseURL: "https://llm.acme.test/v1/", models: ["acme-large", " acme-large ", "acme-small"], key: "sk-acme" },
    })
    expect(saved.status).toBe(200)
    expect(saved.body).toEqual({
      id: "acme",
      name: "Acme AI",
      baseURL: "https://llm.acme.test/v1",
      models: ["acme-large", "acme-small"],
    })
    expect((yield* call(base, { token })).body).toEqual([saved.body])
    const shared = (yield* call(`/api/organization/${organization.id}/credential`, { token })).body
    expect(shared).toMatchObject([{ integrationID: "acme", label: "Acme AI", active: true }])

    // Members see it in their Location's catalog through the shared key.
    const providers = yield* call("/api/provider", { token })
    expect(providers.status).toBe(200)
    expect(providers.text).toContain('"acme"')
    const models = yield* call("/api/model", { token })
    expect(models.text).toContain("acme-large")
    expect(models.text).not.toContain("sk-acme")

    expect((yield* call(`${base}/acme`, { token, method: "DELETE" })).status).toBe(204)
    expect((yield* call(base, { token })).body).toEqual([])
    expect((yield* call(`/api/organization/${organization.id}/credential`, { token })).body).toEqual([])
    expect((yield* call("/api/model", { token })).text).not.toContain("acme-large")
  }),
)

it.live("deleting a project removes its sessions and its folder inside the organization", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make(options)
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

    const token = (yield* call("/api/auth/login", { body: { employeeID: "8000", password: "password-1" } })).body.token
    const organization = (yield* call("/api/organization", { token, body: { name: "Projects" } })).body
    yield* call(`/api/organization/${organization.id}/member`, { token, body: { employeeID: "8000" } })
    const switched = (yield* call("/api/auth/organization", { token, body: { organizationID: organization.id } })).body
    const folder = path.join(switched.organizationDirectory, "doomed")
    expect((yield* call(`/api/experimental/fs/mkdir?path=${encodeURIComponent(folder)}`, { token, method: "POST" })).status).toBe(200)

    // Opening the folder registers it as a project of the organization, as the project picker does.
    expect((yield* call("/api/location", { token, directory: folder })).status).toBe(200)
    const session = (yield* call("/api/session", { token, body: { location: { directory: folder } } })).body.data
    // Opening the default location registers the organization's default directory as a project.
    expect((yield* call("/api/location", { token })).status).toBe(200)
    const projects = (yield* call("/api/project", { token })).body as Array<{ id: string; canonical: string }>
    // Temporary directories can resolve through a symlink, so match on the folder names.
    const doomed = projects.find((item) => item.canonical.endsWith(`${path.sep}doomed`))
    const fallback = projects.find((item) => item.canonical.endsWith("默认目录"))
    if (!doomed || !fallback) throw new Error("projects missing")
    expect(existsSync(folder)).toBe(true)

    // The default directory stays; it is where sessions without a project go.
    expect((yield* call(`/api/project/${fallback.id}`, { token, method: "DELETE" })).status).toBe(400)

    expect(yield* call(`/api/project/${doomed.id}`, { token, method: "DELETE" })).toEqual({ status: 200, body: { files: true } })
    expect(existsSync(folder)).toBe(false)
    expect(((yield* call("/api/project", { token })).body as Array<{ id: string }>).map((item) => item.id)).not.toContain(doomed.id)
    expect((yield* call(`/api/session/${session.id}`, { token })).status).toBe(404)
    expect((yield* call(`/api/project/${doomed.id}`, { token, method: "DELETE" })).status).toBe(404)
  }),
)

it.live("only an admin deletes a project; deleting it from the list keeps its folder and sessions", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make(options)
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

    const admin = yield* login("8000", "password-1")
    const organization = (yield* call("/api/organization", { token: admin, body: { name: "Archive" } })).body
    yield* call(`/api/organization/${organization.id}/member`, { token: admin, body: { employeeID: "8000" } })
    yield* call("/api/auth/users", {
      token: admin,
      body: { employeeID: "8002", password: "password-3", organizationID: organization.id },
    })
    const member = yield* login("8002", "password-3")
    const switched = (yield* call("/api/auth/organization", { token: admin, body: { organizationID: organization.id } })).body
    const folder = path.join(switched.organizationDirectory, "kept")
    yield* call(`/api/experimental/fs/mkdir?path=${encodeURIComponent(folder)}`, { token: admin, method: "POST" })
    yield* call("/api/location", { token: admin, directory: folder })
    const session = (yield* call("/api/session", { token: admin, body: { location: { directory: folder } } })).body.data
    const find = Effect.gen(function* () {
      const listed = (yield* call("/api/project", { token: admin })).body as Array<{ id: string; canonical: string }>
      return listed.find((item) => item.canonical.endsWith(`${path.sep}kept`))
    })
    const project = yield* find
    if (!project) throw new Error("project missing")

    // A member can neither hide a project nor delete it for good.
    expect((yield* call(`/api/project/${project.id}`, { token: member, method: "PATCH", body: { archived: true } })).status).toBe(403)
    expect((yield* call(`/api/project/${project.id}`, { token: member, method: "DELETE" })).status).toBe(403)
    expect(yield* find).toBeDefined()

    // An admin takes it off the list; its sessions and folder stay.
    expect((yield* call(`/api/project/${project.id}`, { token: admin, method: "PATCH", body: { archived: true } })).status).toBe(200)
    expect(yield* find).toBeUndefined()
    expect(existsSync(folder)).toBe(true)
    expect((yield* call(`/api/session/${session.id}`, { token: admin })).status).toBe(200)

    // Opening the folder again brings it back.
    yield* call("/api/location", { token: admin, directory: folder })
    expect(yield* find).toBeDefined()
  }),
)

it.live("members write only to their own folder of the organization's shared space", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make(options)
    const call = (
      path: string,
      init: { method?: string; token?: string; body?: unknown; directory?: string } = {},
    ) =>
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

    const admin = yield* login("8000", "password-1")
    const organization = (yield* call("/api/organization", { token: admin, body: { name: "Shared" } })).body
    expect(
      (yield* call("/api/auth/users", {
        token: admin,
        body: { employeeID: "8001", password: "password-2", organizationID: organization.id },
      })).status,
    ).toBe(200)
    const token = yield* login("8001", "password-2")
    const session = (yield* call("/api/auth/session", { token })).body
    const shared = path.join(session.organizationDirectory, "公共空间")
    const write = (target: string, method = "POST", endpoint = "write") =>
      call(`/api/experimental/fs/${endpoint}?path=${encodeURIComponent(target)}`, { token, method }).pipe(
        Effect.map((result) => result.status),
      )

    // Members can write in their own folder, not in the shared root or in a colleague's folder.
    expect(yield* write(path.join(shared, "8001", "notes"), "POST", "mkdir")).toBe(200)
    expect(yield* write(path.join(shared, "notes"), "POST", "mkdir")).toBe(400)
    expect(yield* write(path.join(shared, "8002", "notes"), "POST", "mkdir")).toBe(400)
    expect(yield* write(path.join(shared, "8002"), "DELETE", "delete")).toBe(400)
    expect(yield* write(path.join(shared, "8001", "notes"), "DELETE", "delete")).toBe(200)

    // Any member can open the shared space as a project, and it is listed for the whole organization.
    expect((yield* call("/api/location", { token, directory: shared })).status).toBe(200)
    const browse = yield* call(`/api/fs/list?location[directory]=${encodeURIComponent(shared)}`, { token })
    expect(browse.status).toBe(200)
    const listed = (yield* call("/api/project", { token })).body as Array<{ id: string; canonical: string }>
    const space = listed.find((item) => item.canonical.endsWith("公共空间"))
    if (!space) throw new Error("shared space project missing")
    // Deleting a project is for admins, so a member is turned away before the shared space's own protection applies.
    expect((yield* call(`/api/project/${space.id}`, { token, method: "DELETE" })).status).toBe(403)

    // An admin who belongs to the organization can clear a colleague's folder.
    yield* call(`/api/organization/${organization.id}/member`, { token: admin, body: { employeeID: "8000" } })
    yield* call("/api/auth/organization", { token: admin, body: { organizationID: organization.id } })
    expect(
      (yield* call(`/api/experimental/fs/delete?path=${encodeURIComponent(path.join(shared, "8001"))}`, {
        token: admin,
        method: "DELETE",
      })).status,
    ).toBe(200)
  }),
)

it.live("an organization admin manages their own organization and no other", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make(options)
    const call = (path: string, init: { method?: string; token?: string; body?: unknown } = {}) =>
      Effect.promise(async () => {
        const response = await handler(
          new Request(`http://opencode.local${path}`, {
            method: init.method ?? (init.body === undefined ? "GET" : "POST"),
            headers: {
              ...(init.body === undefined ? {} : { "content-type": "application/json" }),
              ...(init.token ? { authorization: `Basic ${btoa(`opencode:${init.token}`)}` } : {}),
            },
            body: init.body === undefined ? undefined : JSON.stringify(init.body),
          }),
        )
        const text = await response.text()
        return { status: response.status, body: text ? JSON.parse(text) : undefined }
      })

    const platform = (yield* call("/api/auth/login", { body: { employeeID: "8000", password: "password-1" } })).body.token
    const own = (yield* call("/api/organization", { token: platform, body: { name: "Lead's" } })).body
    const other = (yield* call("/api/organization", { token: platform, body: { name: "Not theirs" } })).body
    yield* call("/api/auth/users", {
      token: platform,
      body: { employeeID: "8100", password: "password-2", organizationID: own.id },
    })
    yield* call("/api/auth/users", { token: platform, body: { employeeID: "8101", password: "password-2" } })
    const lead = (yield* call("/api/auth/login", { body: { employeeID: "8100", password: "password-2" } })).body.token

    // Members can't manage anything until a platform admin promotes them.
    expect((yield* call(`/api/organization/${own.id}/credential`, { token: lead })).status).toBe(403)
    const promoted = yield* call(`/api/organization/${own.id}/member/8100/role`, {
      token: platform,
      method: "PUT",
      body: { role: "admin" },
    })
    expect(promoted.body.admins).toEqual(["8100"])
    expect((yield* call("/api/auth/session", { token: lead })).body).toMatchObject({
      admin: false,
      organizationAdmin: true,
    })

    const created = yield* call(`/api/organization/${own.id}/credential`, {
      token: lead,
      body: { integrationID: "openai", key: "sk-lead" },
    })
    expect(created.status).toBe(200)
    expect((yield* call(`/api/organization/${own.id}/member`, { token: lead, body: { employeeID: "8101" } })).body.members).toContain(
      "8101",
    )
    expect((yield* call("/api/organization", { token: lead })).body.map((item: { id: string }) => item.id)).toEqual([own.id])

    expect((yield* call(`/api/organization/${other.id}/credential`, { token: lead })).status).toBe(403)
    expect((yield* call(`/api/organization/${other.id}/member`, { token: lead, body: { employeeID: "8101" } })).status).toBe(403)
    expect((yield* call("/api/organization", { token: lead, body: { name: "Nope" } })).status).toBe(403)
    expect(
      (yield* call(`/api/organization/${own.id}/member/8101/role`, { token: lead, method: "PUT", body: { role: "admin" } })).status,
    ).toBe(403)
    expect((yield* call("/api/auth/users", { token: lead })).status).toBe(403)
  }),
)

it.live("members only change what their organization's settings pages allow, and never shared state", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make(options)
    const call = (path: string, init: { method?: string; token?: string; body?: unknown } = {}) =>
      Effect.promise(async () => {
        const response = await handler(
          new Request(`http://opencode.local${path}`, {
            method: init.method ?? (init.body === undefined ? "GET" : "POST"),
            headers: {
              ...(init.body === undefined ? {} : { "content-type": "application/json" }),
              ...(init.token ? { authorization: `Basic ${btoa(`opencode:${init.token}`)}` } : {}),
            },
            body: init.body === undefined ? undefined : JSON.stringify(init.body),
          }),
        )
        const text = await response.text()
        return { status: response.status, body: text ? JSON.parse(text) : undefined }
      })

    const platform = (yield* call("/api/auth/login", { body: { employeeID: "8000", password: "password-1" } })).body.token
    const org = (yield* call("/api/organization", { token: platform, body: { name: "Pages" } })).body
    yield* call("/api/auth/users", {
      token: platform,
      body: { employeeID: "8300", password: "password-2", organizationID: org.id },
    })
    const member = (yield* call("/api/auth/login", { body: { employeeID: "8300", password: "password-2" } })).body.token

    const mcp = { method: "PUT", token: member, body: { config: { type: "remote", url: "http://localhost:1" } } }
    const wellknown = { token: member, body: { url: "http://localhost:1" } }

    // Defaults are providers, models and servers: no extensions page.
    expect((yield* call("/api/experimental/mcp/demo", mcp)).status).toBe(403)
    expect((yield* call("/api/mcp", { token: member })).status).not.toBe(403)
    expect((yield* call("/api/plugin/update", { token: member, body: { targets: [] } })).status).toBe(403)
    expect((yield* call("/api/experimental/config", { method: "PATCH", token: member, body: {} })).status).toBe(403)
    expect((yield* call("/api/experimental/integration/wellknown", wellknown)).status).toBe(403)

    // Granting the page opens that page's routes only; shared state stays with the platform admin.
    yield* call(`/api/organization/${org.id}/settings`, {
      token: platform,
      method: "PUT",
      body: { pages: ["providers", "models", "servers", "extensions"] },
    })
    expect((yield* call("/api/experimental/mcp/demo", mcp)).status).not.toBe(403)
    expect((yield* call("/api/plugin/update", { token: member, body: { targets: [] } })).status).toBe(403)
    expect((yield* call("/api/experimental/config", { method: "PATCH", token: member, body: {} })).status).toBe(403)
    expect((yield* call("/api/plugin/update", { token: platform, body: { targets: [] } })).status).not.toBe(403)
  }),
)

it.live("members don't see the secrets in the server's global config", () =>
  Effect.gen(function* () {
    const dir = path.join(os.tmpdir(), `opencode-global-config-${process.pid}`)
    yield* Effect.promise(async () => {
      await mkdir(dir, { recursive: true })
      await writeFile(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          provider: { demo: { npm: "@ai-sdk/openai-compatible", options: { apiKey: "sk-global-secret" } } },
        }),
      )
    })
    const handler = yield* ServerFetch.make({ ...options, config: { project: false, directory: dir } })
    const call = (path: string, init: { token?: string; body?: unknown } = {}) =>
      Effect.promise(async () => {
        const response = await handler(
          new Request(`http://opencode.local${path}`, {
            method: init.body === undefined ? "GET" : "POST",
            headers: {
              ...(init.body === undefined ? {} : { "content-type": "application/json" }),
              ...(init.token ? { authorization: `Basic ${btoa(`opencode:${init.token}`)}` } : {}),
            },
            body: init.body === undefined ? undefined : JSON.stringify(init.body),
          }),
        )
        const text = await response.text()
        return { status: response.status, text }
      })
    const login = (employeeID: string, password: string) =>
      call("/api/auth/login", { body: { employeeID, password } }).pipe(Effect.map((result) => JSON.parse(result.text).token))

    const platform = yield* login("8000", "password-1")
    const org = JSON.parse((yield* call("/api/organization", { token: platform, body: { name: "Secrets" } })).text)
    yield* call("/api/auth/users", {
      token: platform,
      body: { employeeID: "8400", password: "password-2", organizationID: org.id },
    })
    const member = yield* login("8400", "password-2")

    const viaOperator = yield* call("/api/config", { token: "server-secret" })
    expect(viaOperator.text).toContain("sk-global-secret")
    const viaMember = yield* call("/api/config", { token: member })
    expect(viaMember.status).toBe(200)
    expect(viaMember.text).not.toContain("sk-global-secret")
  }).pipe(Effect.scoped),
)

it.live("members can't reach directories outside their organization's directory", () =>
  Effect.gen(function* () {
    const outside = path.join(os.tmpdir(), `opencode-outside-${process.pid}`)
    yield* Effect.promise(async () => {
      await mkdir(outside, { recursive: true })
      await writeFile(path.join(outside, "secret.txt"), "outside-secret")
    })
    const handler = yield* ServerFetch.make(options)
    const call = (path: string, init: { token?: string; body?: unknown } = {}) =>
      Effect.promise(async () => {
        const response = await handler(
          new Request(`http://opencode.local${path}`, {
            method: init.body === undefined ? "GET" : "POST",
            headers: {
              ...(init.body === undefined ? {} : { "content-type": "application/json" }),
              ...(init.token ? { authorization: `Basic ${btoa(`opencode:${init.token}`)}` } : {}),
            },
            body: init.body === undefined ? undefined : JSON.stringify(init.body),
          }),
        )
        const text = await response.text()
        return { status: response.status, text }
      })
    const login = (employeeID: string, password: string) =>
      call("/api/auth/login", { body: { employeeID, password } }).pipe(Effect.map((result) => JSON.parse(result.text).token))

    const platform = yield* login("8000", "password-1")
    const org = JSON.parse((yield* call("/api/organization", { token: platform, body: { name: "Outside" } })).text)
    yield* call("/api/auth/users", {
      token: platform,
      body: { employeeID: "8500", password: "password-2", organizationID: org.id },
    })
    const member = yield* login("8500", "password-2")
    const at = (route: string) => `${route}${route.includes("?") ? "&" : "?"}location[directory]=${encodeURIComponent(outside)}`

    for (const route of ["/api/fs/read/secret.txt", "/api/fs/list", "/api/fs/find?query=secret", "/api/fs/archive"]) {
      const result = yield* call(at(route), { token: member })
      expect(result.text).not.toContain("secret")
      expect(result.status).toBeGreaterThanOrEqual(400)
    }
    // A session carries its own location in the body.
    const created = yield* call("/api/session", { token: member, body: { location: { directory: outside } } })
    expect(created.status).toBeGreaterThanOrEqual(400)

    // Their own organization's directory is fine, but its shared space only holds files.
    const root = JSON.parse((yield* call("/api/auth/session", { token: member })).text).organizationDirectory as string
    const own = yield* call("/api/session", { token: member, body: { location: { directory: root } } })
    expect(own.status).toBe(404)
    const project = path.join(root, "project")
    yield* Effect.promise(() => mkdir(project, { recursive: true }))
    const inside = yield* call("/api/session", { token: member, body: { location: { directory: project } } })
    expect(inside.status).toBe(200)
    const shared = path.join(root, "公共空间")
    yield* Effect.promise(() => mkdir(shared, { recursive: true }))
    expect((yield* call("/api/session", { token: member, body: { location: { directory: shared } } })).status).toBe(404)
    // Terminals and shell commands take their working directory from the body.
    const here = `?location[directory]=${encodeURIComponent(project)}`
    expect((yield* call(`/api/pty${here}`, { token: member, body: { cwd: outside } })).status).toBe(403)
    expect((yield* call(`/api/shell${here}`, { token: member, body: { command: "ls", cwd: outside } })).status).toBe(403)
    const sessionID = JSON.parse(inside.text).data.id as string
    expect(
      (yield* call(`/api/experimental/session/${sessionID}/terminal`, { token: member, body: { cwd: outside, args: [], title: "t", env: {} } })).status,
    ).toBe(403)
    expect((yield* call(`/api/session/${sessionID}/move`, { token: member, body: { directory: outside } })).status).toBe(404)
  }).pipe(Effect.scoped),
)

it.live("the event stream only carries the signed-in user's organization", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make(options)
    yield* Effect.promise(async () => {
      const request = (path: string, init: { token?: string; body?: unknown; signal?: AbortSignal } = {}) =>
        handler(
          new Request(`http://opencode.local${path}`, {
            method: init.body === undefined ? "GET" : "POST",
            headers: {
              ...(init.body === undefined ? {} : { "content-type": "application/json" }),
              ...(init.token ? { authorization: `Basic ${btoa(`opencode:${init.token}`)}` } : {}),
            },
            body: init.body === undefined ? undefined : JSON.stringify(init.body),
            signal: init.signal,
          }),
        )
      const json = async (path: string, init: { token?: string; body?: unknown } = {}) => (await request(path, init)).json()

      const platform = (await json("/api/auth/login", { body: { employeeID: "8000", password: "password-1" } })).token
      const orgs = [
        await json("/api/organization", { token: platform, body: { name: "Events A" } }),
        await json("/api/organization", { token: platform, body: { name: "Events B" } }),
      ]
      const tokens = [] as string[]
      for (const [index, org] of orgs.entries()) {
        const employeeID = `82${index}0`
        await json("/api/auth/users", { token: platform, body: { employeeID, password: "password-2", organizationID: org.id } })
        tokens.push((await json("/api/auth/login", { body: { employeeID, password: "password-2" } })).token)
      }

      const abort = new AbortController()
      const streams = await Promise.all(tokens.map((token) => request("/api/event", { token, signal: abort.signal })))
      expect(streams.map((stream) => stream.status)).toEqual([200, 200])
      const readers = streams.map((stream) => stream.body!.getReader())
      const sessions = await Promise.all(tokens.map((token) => json("/api/session", { token, body: {} })))
      const ids = sessions.map((session) => session.data.id as string)

      // Reads until the user's own session shows up, which means everything queued before it has arrived too.
      const drain = async (index: number) => {
        const decoder = new TextDecoder()
        let text = ""
        while (!text.includes(ids[index])) {
          const chunk = await Promise.race([
            readers[index].read(),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`no event for ${ids[index]}:\n${text}`)), 5_000),
            ),
          ])
          if (chunk.done) break
          text += decoder.decode(chunk.value)
        }
        return text
      }
      const seen = await Promise.all([drain(0), drain(1)])
      abort.abort()

      expect(seen[0]).toContain(ids[0])
      expect(seen[0]).not.toContain(ids[1])
      expect(seen[1]).toContain(ids[1])
      expect(seen[1]).not.toContain(ids[0])
    })
  }).pipe(Effect.scoped),
)

it.live("members can't read another organization's session or its log", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make(options)
    const call = (path: string, init: { token?: string; method?: string; body?: unknown } = {}) =>
      Effect.promise(async () => {
        const response = await handler(
          new Request(`http://opencode.local${path}`, {
            method: init.method ?? (init.body === undefined ? "GET" : "POST"),
            headers: {
              ...(init.body === undefined ? {} : { "content-type": "application/json" }),
              ...(init.token ? { authorization: `Basic ${btoa(`opencode:${init.token}`)}` } : {}),
            },
            body: init.body === undefined ? undefined : JSON.stringify(init.body),
          }),
        )
        return { status: response.status, text: await response.text() }
      })
    const login = (employeeID: string, password: string) =>
      call("/api/auth/login", { body: { employeeID, password } }).pipe(Effect.map((result) => JSON.parse(result.text).token))

    const platform = yield* login("8000", "password-1")
    const tokens = [] as string[]
    for (const index of [0, 1]) {
      const org = JSON.parse((yield* call("/api/organization", { token: platform, body: { name: `Logs ${index}` } })).text)
      const employeeID = `86${index}0`
      yield* call("/api/auth/users", { token: platform, body: { employeeID, password: "password-2", organizationID: org.id } })
      tokens.push(yield* login(employeeID, "password-2"))
    }
    const own = JSON.parse((yield* call("/api/session", { token: tokens[0], body: {} })).text).data.id as string

    const read = ["", "/message", "/context", "/diff", "/inbox"].map((suffix) => ["GET", `/api/session/${own}${suffix}`] as const)
    const routes = [
      ...read,
      ["GET", `/api/experimental/session/${own}/export`],
      ["GET", `/api/experimental/session/${own}/log`],
      ["POST", `/api/session/${own}/interrupt`],
      ["POST", `/api/session/${own}/background`],
      ["POST", `/api/session/${own}/view`, { idle: 1 }],
      ["PUT", `/api/session/${own}/environment`, { variables: {} }],
      ["PATCH", `/api/session/${own}`, { title: "taken" }],
    ] as const
    for (const [method, route, body] of routes) {
      const label = `${method} ${route.replace(own, ":id")}`
      const mine = yield* call(route, { token: tokens[0], method, body: body ?? (method === "GET" ? undefined : {}) })
      const other = yield* call(route, { token: tokens[1], method, body: body ?? (method === "GET" ? undefined : {}) })
      expect([label, mine.status < 300]).toEqual([label, true])
      expect([label, other.status]).toEqual([label, 404])
    }
  }).pipe(Effect.scoped),
)

it.live("only platform admins upload global packages, and organization admins switch them for their own organization", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make(options)
    const call = (route: string, init: { token?: string; method?: string; body?: unknown } = {}) =>
      Effect.promise(async () => {
        const response = await handler(
          new Request(`http://opencode.local${route}`, {
            method: init.method ?? (init.body === undefined ? "GET" : "POST"),
            headers: {
              ...(init.body === undefined ? {} : { "content-type": "application/json" }),
              ...(init.token ? { authorization: `Basic ${btoa(`opencode:${init.token}`)}` } : {}),
            },
            body: init.body === undefined ? undefined : JSON.stringify(init.body),
          }),
        )
        return { status: response.status, text: await response.text() }
      })
    const login = (employeeID: string, password: string) =>
      call("/api/auth/login", { body: { employeeID, password } }).pipe(Effect.map((result) => JSON.parse(result.text).token))

    const platform = yield* login("8000", "password-1")
    const org = JSON.parse((yield* call("/api/organization", { token: platform, body: { name: "Packages" } })).text)
    const other = JSON.parse((yield* call("/api/organization", { token: platform, body: { name: "Packages Other" } })).text)
    yield* call("/api/auth/users", { token: platform, body: { employeeID: "8700", password: "password-2", organizationID: org.id } })
    yield* call("/api/auth/users", { token: platform, body: { employeeID: "8701", password: "password-3", organizationID: org.id } })
    yield* call(`/api/organization/${org.id}/member/8700/role`, { token: platform, method: "PUT", body: { role: "admin" } })
    const lead = yield* login("8700", "password-2")
    const member = yield* login("8701", "password-3")
    const archive = Buffer.from(zip([{ name: "SKILL.md", data: "---\nname: shared\ndescription: Shared skill\n---\nbody" }])).toString("base64")
    yield* call("/api/auth/users", { token: platform, body: { employeeID: "8702", password: "password-4", organizationID: other.id } })
    const outsider = yield* login("8702", "password-4")
    const upload = { kind: "skill", name: "shared-skill", archive, organizations: [org.id] }

    // Only platform admins change what everyone shares.
    expect((yield* call("/api/package", { token: member, body: upload })).status).toBe(403)
    expect((yield* call("/api/package", { token: lead, body: upload })).status).toBe(403)
    expect((yield* call("/api/package", { token: platform, body: { ...upload, archive: "bm90IGEgemlw" } })).status).toBe(400)
    expect((yield* call("/api/package", { token: platform, body: { ...upload, organizations: ["org_missing"] } })).status).toBe(400)
    const installed = yield* call("/api/package", { token: platform, body: upload })
    expect(installed.status).toBe(200)
    expect(JSON.parse(installed.text)).toMatchObject({ name: "shared-skill", description: "Shared skill", uploadedBy: "8000" })

    const listed = async (token: string) => JSON.parse((await Effect.runPromise(call("/api/package", { token }))).text)
    expect((yield* Effect.promise(() => listed(member)))[0]).toMatchObject({ name: "shared-skill", enabled: true, organizations: [] })
    expect((yield* Effect.promise(() => listed(platform)))[0].organizations).toEqual([org.id])

    // Only organizations the package is open to see it, and only they can switch it.
    expect(yield* Effect.promise(() => listed(outsider))).toEqual([])

    // Organization admins decide for their own organization only.
    const path = (id: string) => `/api/organization/${id}/package/skill/shared-skill`
    expect((yield* call(path(org.id), { token: member, method: "PUT", body: { enabled: false } })).status).toBe(403)
    expect((yield* call(path(other.id), { token: lead, method: "PUT", body: { enabled: false } })).status).toBe(403)
    expect((yield* call(path(org.id), { token: lead, method: "PUT", body: { enabled: false } })).status).toBe(204)
    expect((yield* Effect.promise(() => listed(member)))[0].enabled).toBe(false)
    expect((yield* Effect.promise(() => listed(platform)))[0].enabled).toBe(true)

    // Opening it to another organization instead closes it for this one.
    const scope = "/api/package/skill/shared-skill/organizations"
    expect((yield* call(scope, { token: lead, method: "PUT", body: { organizations: [org.id, other.id] } })).status).toBe(403)
    expect((yield* call(scope, { token: platform, method: "PUT", body: { organizations: ["org_missing"] } })).status).toBe(400)
    expect((yield* call(scope, { token: platform, method: "PUT", body: { organizations: [other.id] } })).status).toBe(204)
    expect(yield* Effect.promise(() => listed(member))).toEqual([])
    expect((yield* Effect.promise(() => listed(outsider)))[0]).toMatchObject({ name: "shared-skill", enabled: true })
    expect((yield* call(path(org.id), { token: lead, method: "PUT", body: { enabled: true } })).status).toBe(400)

    expect((yield* call("/api/package/skill/shared-skill", { token: lead, method: "DELETE" })).status).toBe(403)
    expect((yield* call("/api/package/skill/shared-skill", { token: platform, method: "DELETE" })).status).toBe(204)
    expect(yield* Effect.promise(() => listed(platform))).toEqual([])
  }).pipe(Effect.scoped),
)

it.live("shared MCP servers keep their secrets, and only open organizations see them", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make(options)
    const call = (route: string, init: { token?: string; method?: string; body?: unknown } = {}) =>
      Effect.promise(async () => {
        const response = await handler(
          new Request(`http://opencode.local${route}`, {
            method: init.method ?? (init.body === undefined ? "GET" : "POST"),
            headers: {
              ...(init.body === undefined ? {} : { "content-type": "application/json" }),
              ...(init.token ? { authorization: `Basic ${btoa(`opencode:${init.token}`)}` } : {}),
            },
            body: init.body === undefined ? undefined : JSON.stringify(init.body),
          }),
        )
        return { status: response.status, text: await response.text() }
      })
    const login = (employeeID: string, password: string) =>
      call("/api/auth/login", { body: { employeeID, password } }).pipe(Effect.map((result) => JSON.parse(result.text).token))

    const platform = yield* login("8000", "password-1")
    const org = JSON.parse((yield* call("/api/organization", { token: platform, body: { name: "Mcp" } })).text)
    const other = JSON.parse((yield* call("/api/organization", { token: platform, body: { name: "Mcp Other" } })).text)
    yield* call("/api/auth/users", { token: platform, body: { employeeID: "8800", password: "password-2", organizationID: org.id } })
    yield* call("/api/auth/users", { token: platform, body: { employeeID: "8801", password: "password-3", organizationID: org.id } })
    yield* call("/api/auth/users", { token: platform, body: { employeeID: "8802", password: "password-4", organizationID: other.id } })
    yield* call(`/api/organization/${org.id}/member/8800/role`, { token: platform, method: "PUT", body: { role: "admin" } })
    const lead = yield* login("8800", "password-2")
    const member = yield* login("8801", "password-3")
    const outsider = yield* login("8802", "password-4")
    const remote = {
      name: "search",
      type: "remote",
      url: "https://mcp.example.com/sse",
      headers: { authorization: "Bearer very-secret" },
      organizations: [org.id],
    }

    expect((yield* call("/api/shared-mcp", { token: lead, body: remote })).status).toBe(403)
    expect((yield* call("/api/shared-mcp", { token: platform, body: { ...remote, url: "file:///etc/passwd" } })).status).toBe(400)
    expect((yield* call("/api/shared-mcp", { token: platform, body: { name: "bad", type: "local", command: [], organizations: [] } })).status).toBe(400)
    expect((yield* call("/api/shared-mcp", { token: platform, body: remote })).status).toBe(200)
    expect((yield* call("/api/shared-mcp", { token: platform, body: remote })).status).toBe(400)

    const listed = async (token: string) => JSON.parse((await Effect.runPromise(call("/api/shared-mcp", { token }))).text)
    const asMember = yield* call("/api/shared-mcp", { token: member })
    expect(asMember.text).not.toContain("very-secret")
    expect(asMember.text).not.toContain("mcp.example.com")
    expect(JSON.parse(asMember.text)[0]).toMatchObject({ name: "search", type: "remote", enabled: true, organizations: [] })
    expect((yield* Effect.promise(() => listed(platform)))[0]).toMatchObject({ target: "https://mcp.example.com/sse", organizations: [org.id] })
    expect(yield* Effect.promise(() => listed(outsider))).toEqual([])

    const path = (id: string) => `/api/organization/${id}/shared-mcp/search`
    expect((yield* call(path(org.id), { token: member, method: "PUT", body: { enabled: false } })).status).toBe(403)
    expect((yield* call(path(other.id), { token: lead, method: "PUT", body: { enabled: false } })).status).toBe(403)
    expect((yield* call(path(org.id), { token: lead, method: "PUT", body: { enabled: false } })).status).toBe(204)
    expect((yield* Effect.promise(() => listed(member)))[0].enabled).toBe(false)

    expect((yield* call("/api/shared-mcp/search/organizations", { token: lead, method: "PUT", body: { organizations: [] } })).status).toBe(403)
    expect((yield* call("/api/shared-mcp/search/organizations", { token: platform, method: "PUT", body: { organizations: [other.id] } })).status).toBe(204)
    expect(yield* Effect.promise(() => listed(member))).toEqual([])
    expect((yield* call("/api/shared-mcp/search", { token: lead, method: "DELETE" })).status).toBe(403)
    expect((yield* call("/api/shared-mcp/search", { token: platform, method: "DELETE" })).status).toBe(204)
    expect(yield* Effect.promise(() => listed(platform))).toEqual([])
  }).pipe(Effect.scoped),
)

it.live("private sessions and projects are only for their creator and the admins, and only they may change or delete", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make(options)
    const call = (route: string, init: { token?: string; method?: string; body?: unknown } = {}) =>
      Effect.promise(async () => {
        const response = await handler(
          new Request(`http://opencode.local${route}`, {
            method: init.method ?? (init.body === undefined ? "GET" : "POST"),
            headers: {
              ...(init.body === undefined ? {} : { "content-type": "application/json" }),
              ...(init.token ? { authorization: `Basic ${btoa(`opencode:${init.token}`)}` } : {}),
            },
            body: init.body === undefined ? undefined : JSON.stringify(init.body),
          }),
        )
        return { status: response.status, text: await response.text() }
      })
    const login = (employeeID: string, password: string) =>
      call("/api/auth/login", { body: { employeeID, password } }).pipe(Effect.map((result) => JSON.parse(result.text).token))

    const platform = yield* login("8000", "password-1")
    const org = JSON.parse((yield* call("/api/organization", { token: platform, body: { name: "Visibility" } })).text)
    for (const [id, password] of [["8900", "password-a"], ["8901", "password-b"], ["8902", "password-c"]])
      yield* call("/api/auth/users", { token: platform, body: { employeeID: id, password, organizationID: org.id } })
    yield* call(`/api/organization/${org.id}/member/8902/role`, { token: platform, method: "PUT", body: { role: "admin" } })
    const alice = yield* login("8900", "password-a")
    const bob = yield* login("8901", "password-b")
    const admin = yield* login("8902", "password-c")
    const root = JSON.parse((yield* call("/api/auth/session", { token: alice })).text).organizationDirectory as string
    const project = path.join(root, "shared-project")
    yield* Effect.promise(() => mkdir(project, { recursive: true }))
    const where = { location: { directory: project } }

    const made = JSON.parse((yield* call("/api/session", { token: alice, body: where })).text).data.id as string
    const own = (id: string) => `/api/session/${id}`
    const listed = async (token: string) =>
      (JSON.parse((await Effect.runPromise(call("/api/session", { token }))).text).data as { id: string }[]).map((item) => item.id)

    // Visible to the organization by default: Bob can use it but not delete, move or re-scope it.
    expect((yield* call(own(made), { token: bob })).status).toBe(200)
    expect(yield* Effect.promise(() => listed(bob))).toContain(made)
    expect((yield* call(own(made), { token: bob, method: "DELETE" })).status).toBe(403)
    expect((yield* call(`${own(made)}/visibility`, { token: bob, method: "PUT", body: { visibility: "private" } })).status).toBe(403)

    // Private: gone for Bob, still there for Alice and the organization's admin.
    expect((yield* call(`${own(made)}/visibility`, { token: alice, method: "PUT", body: { visibility: "private" } })).status).toBe(204)
    expect((yield* call(own(made), { token: bob })).status).toBe(404)
    expect((yield* call(`${own(made)}/message`, { token: bob })).status).toBe(404)
    expect(yield* Effect.promise(() => listed(bob))).not.toContain(made)
    expect(yield* Effect.promise(() => listed(alice))).toContain(made)
    expect(yield* Effect.promise(() => listed(admin))).toContain(made)
    expect((yield* call(own(made), { token: admin })).status).toBe(200)

    // Owners are told, and only for what the caller can see.
    const access = JSON.parse((yield* call("/api/session-access", { token: alice, body: { sessionIDs: [made] } })).text)
    expect(access[made]).toMatchObject({ owner: "8900", visibility: "private", canManage: true })
    expect(JSON.parse((yield* call("/api/session-access", { token: bob, body: { sessionIDs: [made] } })).text)).toEqual({})

    // Presence: heartbeats show who has it open, never to someone who can't see the session.
    expect((yield* call(`${own(made)}/presence`, { token: alice, method: "PUT" })).status).toBe(204)
    expect((yield* call(`${own(made)}/presence`, { token: admin, method: "PUT" })).status).toBe(204)
    expect(JSON.parse((yield* call(`${own(made)}/presence`, { token: alice })).text)).toEqual(["8900", "8902"])
    expect((yield* call(`${own(made)}/presence`, { token: bob })).status).toBe(404)

    // A private project hides everything in it from other members.
    const projects = JSON.parse((yield* call("/api/project", { token: alice })).text) as { id: string; canonical: string }[]
    const mine = projects.find((item) => item.canonical.endsWith("shared-project"))!
    expect((yield* call(`/api/project/${mine.id}/visibility`, { token: bob, method: "PUT", body: { visibility: "private" } })).status).toBe(403)
    expect((yield* call(`/api/project/${mine.id}/visibility`, { token: alice, method: "PUT", body: { visibility: "private" } })).status).toBe(204)
    const seenBy = async (token: string) =>
      (JSON.parse((await Effect.runPromise(call("/api/project", { token }))).text) as { id: string }[]).map((item) => item.id)
    expect(yield* Effect.promise(() => seenBy(bob))).not.toContain(mine.id)
    expect(yield* Effect.promise(() => seenBy(admin))).toContain(mine.id)
    expect((yield* call("/api/session", { token: bob, body: where })).status).toBe(404)
    // Deleting a project is for admins, so a member is refused whether or not they can see it.
    expect((yield* call(`/api/project/${mine.id}`, { token: bob, method: "DELETE" })).status).toBe(403)

    // The creator can delete their own session; so can an admin.
    expect((yield* call(`/api/project/${mine.id}/visibility`, { token: alice, method: "PUT", body: { visibility: "organization" } })).status).toBe(204)
    expect((yield* call(own(made), { token: alice, method: "DELETE" })).status).toBe(204)
  }).pipe(Effect.scoped),
)

it.live("the event stream leaves out private sessions", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make(options)
    yield* Effect.promise(async () => {
      const request = (path: string, init: { token?: string; body?: unknown; method?: string; signal?: AbortSignal } = {}) =>
        handler(
          new Request(`http://opencode.local${path}`, {
            method: init.method ?? (init.body === undefined ? "GET" : "POST"),
            headers: {
              ...(init.body === undefined ? {} : { "content-type": "application/json" }),
              ...(init.token ? { authorization: `Basic ${btoa(`opencode:${init.token}`)}` } : {}),
            },
            body: init.body === undefined ? undefined : JSON.stringify(init.body),
            signal: init.signal,
          }),
        )
      const json = async (path: string, init: Parameters<typeof request>[1] = {}) => (await request(path, init)).json()

      const platform = (await json("/api/auth/login", { body: { employeeID: "8000", password: "password-1" } })).token
      const org = await json("/api/organization", { token: platform, body: { name: "Private events" } })
      const tokens = [] as string[]
      for (const employeeID of ["8950", "8951"]) {
        await json("/api/auth/users", { token: platform, body: { employeeID, password: "password-2", organizationID: org.id } })
        tokens.push((await json("/api/auth/login", { body: { employeeID, password: "password-2" } })).token)
      }
      const [alice, bob] = tokens

      const abort = new AbortController()
      const stream = await request("/api/event", { token: bob, signal: abort.signal })
      const reader = stream.body!.getReader()

      const secret = (await json("/api/session", { token: alice, body: {} })).data.id as string
      await request(`/api/session/${secret}/visibility`, { token: alice, method: "PUT", body: { visibility: "private" } })
      await request(`/api/session/${secret}`, { token: alice, method: "PATCH", body: { title: "top-secret-title" } })
      const mine = (await json("/api/session", { token: bob, body: {} })).data.id as string

      // Everything Alice did before Bob's own session was created has been delivered once his shows up.
      const decoder = new TextDecoder()
      let text = ""
      while (!text.includes(mine)) {
        const chunk = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no event for ${mine}:\n${text}`)), 5_000)),
        ])
        if (chunk.done) break
        text += decoder.decode(chunk.value)
      }
      abort.abort()

      expect(text).toContain(mine)
      expect(text).not.toContain("top-secret-title")
    })
  }).pipe(Effect.scoped),
)

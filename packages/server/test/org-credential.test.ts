import { expect } from "bun:test"
import { Effect } from "effect"
import { it } from "../../core/test/lib/effect"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"

// Organizations get a directory under the data home, so keep this run's out of the real one.
process.env.XDG_DATA_HOME = path.join(os.tmpdir(), `opencode-org-credential-${process.pid}`)
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

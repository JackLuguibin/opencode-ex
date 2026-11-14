import { describe, expect, test } from "bun:test"
import { Context } from "../src/context.js"
import { Knowledge } from "../src/knowledge.js"
import { Server } from "../src/server.js"

const secret = "test-secret"
const handle = Server.make({ service: Knowledge.open(":memory:"), secrets: [secret] })
const base = "http://knowledge.test/"

const call = (path: string, init: { method?: string; body?: unknown; context?: Knowledge.Context | null } = {}) =>
  handle(new Request(`${base}v1${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: {
      "content-type": "application/json",
      ...(init.context === null ? {} : { [Context.HEADER]: Context.sign(secret, init.context ?? { userID: "u", admin: true, organizationID: undefined }) }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  }))

describe("knowledge server", () => {
  test("health needs no context but everything else does", async () => {
    expect((await handle(new Request(`${base}v1/health`))).status).toBe(200)
    expect((await call("/bases", { context: null })).status).toBe(401)
  })

  test("a context signed with another secret is refused", async () => {
    const forged = Context.sign("other", { userID: "u", admin: true, organizationID: undefined })
    expect((await handle(new Request(`${base}v1/bases`, { headers: { [Context.HEADER]: forged } }))).status).toBe(401)
  })

  test("an expired context is refused", () => {
    const old = Context.sign(secret, { userID: "u", admin: true, organizationID: undefined }, Date.now() - 120_000)
    expect(Context.verify(secret, old)).toBeUndefined()
  })

  test("create, grant, import, search and permissions over HTTP", async () => {
    const created = (await (await call("/bases", { body: { name: "re", description: "reverse engineering" } })).json()) as { id: string }
    expect((await call(`/bases/${created.id}/grants`, { method: "PUT", body: { organizations: ["org_a"] } })).status).toBe(200)
    const added = await call(`/bases/${created.id}/entries`, { body: { entries: [{ title: "LC_MAIN", content: "entry point of the program" }] } })
    expect(added.status).toBe(200)
    const member = { userID: "m", admin: false, organizationID: "org_a" }
    const found = (await (await call("/search", { body: { query: "entry point" }, context: member })).json()) as { hits: { title: string }[] }
    expect(found.hits.map((hit) => hit.title)).toEqual(["LC_MAIN"])
    expect((await call("/bases", { body: { name: "x" }, context: member })).status).toBe(403)
    expect((await call(`/bases/${created.id}`, { context: { ...member, organizationID: "org_b" } })).status).toBe(404)
    expect((await call("/search", { body: { query: 1 }, context: member })).status).toBe(400)
  })

  test("an import job is created, advanced and read back", async () => {
    const created = (await (await call("/bases", { body: { name: "jobs" } })).json()) as { id: string }
    const job = (await (await call(`/bases/${created.id}/jobs`, { body: { total: 3 } })).json()) as { id: string }
    expect((await call(`/jobs/${job.id}`, { method: "PATCH", body: { done: 2 } })).status).toBe(200)
    expect(await (await call(`/jobs/${job.id}`)).json()).toMatchObject({ status: "running", total: 3, done: 2 })
    await call(`/jobs/${job.id}`, { method: "PATCH", body: { status: "done" } })
    expect(await (await call(`/jobs/${job.id}`)).json()).toMatchObject({ status: "done" })
  })

  test("invalid settings answer 400 with the reason", async () => {
    const response = await call("/settings", { method: "PATCH", body: { search: { topK: 999 } } })
    expect(response.status).toBe(400)
    expect(((await response.json()) as { message: string }).message).toContain("search.topK")
  })

  test("base settings redact overrides for admins and granted members while preserving the saved secret", async () => {
    const created = (await (await call("/bases", { body: { name: "secret-base" } })).json()) as { id: string }
    const path = `/bases/${created.id}/settings`
    const saved = await call(path, { method: "PATCH", body: { vector: { store: { secret: "base-secret" } } } })
    expect(saved.status).toBe(200)
    expect(await saved.text()).not.toContain("base-secret")
    await call(`/bases/${created.id}/grants`, { method: "PUT", body: { organizations: ["org_secret"] } })
    const member = { userID: "m", admin: false, organizationID: "org_secret" }
    const read = await call(path, { context: member })
    expect(read.status).toBe(200)
    const body = await read.text()
    expect(body).not.toContain("base-secret")
    expect(JSON.parse(body)).toMatchObject({ override: { vector: { store: { hasSecret: true } } } })
    const updated = await call(path, { method: "PATCH", body: { vector: { queryPrefix: "query: " } } })
    expect(await updated.json()).toMatchObject({ effective: { vector: { store: { hasSecret: true } } } })
  })
  test("a malformed escape in the path answers 400 instead of failing", async () => {
    const response = await call("/bases/%E0%A4")
    expect(response.status).toBe(400)
    expect(((await response.json()) as { message: string }).message).toBe("the path is not valid")
  })

  test("a body that is not a JSON object answers 400", async () => {
    const response = await handle(new Request(`${base}v1/bases`, {
      method: "POST",
      headers: { [Context.HEADER]: Context.sign(secret, { userID: "u", admin: true, organizationID: undefined }) },
      body: "[1]",
    }))
    expect(response.status).toBe(400)
  })
  test("a second import while one runs answers 409", async () => {
    const created = (await (await call("/bases", { body: { name: "jobs-409" } })).json()) as { id: string }
    expect((await call(`/bases/${created.id}/jobs`, { body: { total: 1 } })).status).toBe(200)
    expect((await call(`/bases/${created.id}/jobs`, { body: { total: 1 } })).status).toBe(409)
  })
})

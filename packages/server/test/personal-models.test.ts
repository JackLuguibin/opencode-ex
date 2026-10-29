import { expect } from "bun:test"
import { Effect } from "effect"
import { it } from "../../core/test/lib/effect"

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

it.live("members add their own providers, keys and model preferences next to the organization's", () =>
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
    const login = (employeeID: string, password: string) =>
      call("/api/auth/login", { body: { employeeID, password } }).pipe(Effect.map((result) => result.body.token as string))

    const admin = yield* login("8000", "password-1")
    const organization = (yield* call("/api/organization", { token: admin, body: { name: "Personal" } })).body
    for (const employeeID of ["alice", "bob"])
      expect(
        (yield* call("/api/auth/users", {
          token: admin,
          body: { employeeID, password: "member-password", organizationID: organization.id },
        })).status,
      ).toBe(200)
    const alice = yield* login("alice", "member-password")
    const bob = yield* login("bob", "member-password")

    // The organization's own provider, with a key every member shares.
    const base = `/api/organization/${organization.id}/provider`
    expect(
      (yield* call(`${base}/acme`, {
        token: admin,
        method: "PUT",
        body: { name: "Acme AI", baseURL: "https://llm.acme.test/v1", models: ["acme-large"], key: "sk-acme" },
      })).status,
    ).toBe(200)

    // A member's own provider is theirs alone, under an ID that cannot clash with anyone else's.
    const saved = yield* call("/api/custom-provider/mine", {
      token: alice,
      method: "PUT",
      body: { name: "Alice LLM", baseURL: "https://llm.alice.test/v1/", models: ["alice-model", "alice-model"], key: "sk-alice" },
    })
    expect(saved.status).toBe(200)
    expect(saved.body.data).toMatchObject({ id: "mine", name: "Alice LLM", baseURL: "https://llm.alice.test/v1", models: ["alice-model"] })
    const providerID = saved.body.data.providerID as string
    expect(providerID).toMatch(/^personal\..+\.mine$/)
    expect(JSON.stringify(saved.body)).not.toContain("sk-alice")
    expect((yield* call("/api/custom-provider/personal.x", { token: alice, method: "PUT", body: saved.body.data })).status).toBe(400)

    expect((yield* call("/api/custom-provider", { token: alice })).body.data).toHaveLength(1)
    expect((yield* call("/api/custom-provider", { token: bob })).body.data).toEqual([])

    const aliceModels = yield* call("/api/model", { token: alice })
    expect(aliceModels.text).toContain("alice-model")
    expect(aliceModels.text).toContain("acme-large")
    const bobModels = yield* call("/api/model", { token: bob })
    expect(bobModels.text).not.toContain("alice-model")
    expect(bobModels.text).toContain("acme-large")
    expect((yield* call("/api/provider", { token: bob })).text).not.toContain(providerID)
    expect((yield* call("/api/integration", { token: bob })).text).not.toContain(providerID)
    expect((yield* call("/api/provider", { token: alice })).text).toContain(providerID)

    // A provider can be edited in place, with its own headers and display names for models.
    const edited = yield* call("/api/custom-provider/mine", {
      token: alice,
      method: "PUT",
      body: {
        name: "Alice LLM",
        baseURL: "https://llm.alice.test/v1",
        models: ["alice-model", "alice-fast"],
        headers: { "X-Team": "alice " },
        names: { "alice-fast": "Fast one", "not-listed": "Ignored", "alice-model": " " },
      },
    })
    expect(edited.body.data).toMatchObject({
      models: ["alice-model", "alice-fast"],
      headers: { "X-Team": "alice" },
      names: { "alice-fast": "Fast one" },
    })
    expect((yield* call("/api/custom-provider", { token: alice })).body.data).toHaveLength(1)
    const renamed = (yield* call("/api/model", { token: alice })).text
    expect(renamed).toContain("Fast one")
    expect(renamed).toContain("alice-model")
    expect(
      (yield* call("/api/custom-provider/mine", {
        token: alice,
        method: "PUT",
        body: { name: "Alice LLM", baseURL: "https://llm.alice.test/v1", models: ["m"], headers: { "bad name": "x" } },
      })).status,
    ).toBe(400)
    // Saving without a key keeps the key the member already stored.
    expect(
      ((yield* call("/api/credential", { token: alice })).body.data as Array<{ integrationID: string }>).some(
        (item) => item.integrationID === providerID,
      ),
    ).toBe(true)

    // Credentials say whose they are, and only an admin can store one for the whole organization.
    const own = (yield* call("/api/credential", { token: alice })).body.data as Array<{ integrationID: string; scope: string }>
    expect(own).toEqual([expect.objectContaining({ integrationID: providerID, scope: "personal" })])
    const shared = yield* call("/api/credential", {
      token: alice,
      body: { integrationID: "openai", value: { type: "key", key: "sk-x" }, scope: "organization" },
    })
    expect(shared.status).toBe(403)
    const mine = yield* call("/api/credential", {
      token: alice,
      body: { integrationID: "openai", value: { type: "key", key: "sk-y" } },
    })
    expect(mine.body.data.scope).toBe("personal")

    // Preferences follow the member, not the organization or the browser.
    const preference = {
      hidden: [{ providerID: "acme", modelID: "acme-large" }],
      shown: [{ providerID, modelID: "alice-model" }],
      favorite: [{ providerID, modelID: "alice-model" }],
      recent: [{ providerID, modelID: "alice-model", variant: "fast" }],
      default: { providerID, modelID: "alice-model" },
    }
    expect((yield* call("/api/model/preference", { token: alice, method: "PUT", body: preference })).body.data).toEqual(preference)
    expect((yield* call("/api/model/preference", { token: alice })).body.data).toEqual(preference)
    expect((yield* call("/api/model/preference", { token: bob })).body.data).toEqual({ hidden: [], shown: [], favorite: [], recent: [] })
    expect(
      (yield* call("/api/model/preference", { token: alice, method: "PUT", body: { default: null, hidden: [] } })).body.data,
    ).toEqual({ ...preference, hidden: [], default: undefined })

    // Removing the provider takes its models and her key with it.
    expect((yield* call("/api/custom-provider/mine", { token: alice, method: "DELETE" })).status).toBe(204)
    expect((yield* call("/api/model", { token: alice })).text).not.toContain("alice-model")
    expect(
      ((yield* call("/api/credential", { token: alice })).body.data as Array<{ integrationID: string }>).some(
        (item) => item.integrationID === providerID,
      ),
    ).toBe(false)
  }),
)

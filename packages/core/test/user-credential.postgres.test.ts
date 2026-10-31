import path from "node:path"
import os from "node:os"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Bus } from "@opencode/core/bus"
import { Credential } from "@opencode/core/credential"
import { Database } from "@opencode/core/database/database"
import { Identity } from "@opencode/core/identity"
import { make, migrations } from "@opencode/core/identity/postgres"
import { IdentitySecret } from "@opencode/core/identity/secret"
import { IdentityOrganizationTable, IdentityUserTable } from "@opencode/core/identity/sql"
import { Integration } from "@opencode/core/integration"
import { Effect, Layer } from "effect"
import { Global } from "@opencode/util/global"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Postgres } from "@opencode/util/postgres"
import { afterAll, describe, expect } from "bun:test"
import { testEffect } from "./lib/effect"

const url = process.env.OPENCODE_TEST_POSTGRES_URL

delete process.env.OPENCODE_ADMIN_EMPLOYEE_ID
delete process.env.OPENCODE_ADMIN_PASSWORD
const secretKey = Buffer.alloc(32, 7)
process.env.OPENCODE_SECRET_KEY = secretKey.toString("base64")
const tables =
  "session_sync_project, session_sync_session, session_sync_message, identity_audit, identity_join_request, identity_preference, identity_user_credential, identity_session, identity_membership, identity_organization, identity_user, auth_migration"
async function reset() {
  const sql = Postgres.connect(url!)
  await sql.unsafe(`DROP TABLE IF EXISTS ${tables}`)
  await sql.close()
}
if (url) {
  process.env.OPENCODE_IDENTITY_POSTGRES_URL = url
  await reset()
}
afterAll(async () => {
  if (url) await reset()
})

const data = path.join(os.tmpdir(), "opencode-ex-user-credential-postgres")
const database = Database.layerFromClient.pipe(
  Layer.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })),
  Layer.provide(Global.layerWith({ data })),
)
const it = testEffect(Identity.layer.pipe(Layer.provideMerge(database), Layer.provideMerge(Global.layerWith({ data }))))
// The credential service reads the same shared store through its own copy of the identity service.
const credentialIt = testEffect(
  LayerNode.compile(LayerNode.group([Credential.node, Identity.node, Bus.node, Database.node])),
)

const password = "password-1"
const signIn = (identity: Identity.Interface, employeeID: string) =>
  Effect.gen(function* () {
    const login = yield* identity.login({ employeeID, password })
    return (yield* identity.authenticate(login!.token))!
  })

// The first admin of the shared store is created once; every test signs in as it and adds its own member.
const member = (identity: Identity.Interface, employeeID: string) =>
  Effect.gen(function* () {
    yield* identity.ensureAdmin({ employeeID: "9400", password })
    const admin = yield* signIn(identity, "9400")
    const organization = yield* identity.createOrganization(admin.sessionID, `Keys ${employeeID}`)
    yield* identity.createUser(admin.sessionID, { employeeID, password, organizationID: organization.id })
    return yield* signIn(identity, employeeID)
  })

describe.skipIf(!url)("user credentials", () => {
  it.effect("keeps a user's key sealed, shows only its end, and forgets it on removal", () =>
    Effect.gen(function* () {
      const sql = Postgres.connect(url!)
      const identity = yield* Identity.Service
      yield* identity.ensureAdmin({ employeeID: "9400", password })
      const admin = yield* signIn(identity, "9400")
      const organization = yield* identity.createOrganization(admin.sessionID, "Keys Co")
      yield* identity.createUser(admin.sessionID, { employeeID: "9401", password, organizationID: organization.id })
      yield* identity.createUser(admin.sessionID, { employeeID: "9402", password, organizationID: organization.id })
      const a = yield* signIn(identity, "9401")
      const b = yield* signIn(identity, "9402")

      expect(yield* identity.userCredentials(a.sessionID)).toEqual({ enabled: true, items: [] })
      yield* identity.setUserCredential(a.sessionID, "openai", "sk-aaaa-bbbb-cccc-1234")
      expect(yield* identity.userCredentials(a.sessionID)).toEqual({
        enabled: true,
        items: [{ integrationID: "openai", hint: "1234" }],
      })
      expect(yield* identity.userKeys(a.userID)).toEqual([{ integrationID: "openai", key: "sk-aaaa-bbbb-cccc-1234" }])

      // Stored sealed, never in the clear, and nobody else sees it, admins included.
      const rows = await_(yield* Effect.promise(() => sql`SELECT * FROM identity_user_credential`))
      expect(rows).toHaveLength(1)
      expect(JSON.stringify(rows)).not.toContain("sk-aaaa")
      expect(rows[0]!.key_id).toBe(IdentitySecret.id(secretKey))
      expect((yield* identity.userCredentials(b.sessionID)).items).toEqual([])
      expect(yield* identity.userKeys(b.userID)).toEqual([])
      expect((yield* identity.userCredentials(admin.sessionID)).items).toEqual([])

      // Saving again replaces the key, and the cached copy does not outlive it.
      yield* identity.setUserCredential(a.sessionID, "openai", "sk-new-key-0000-9999")
      expect(yield* identity.userKeys(a.userID)).toEqual([{ integrationID: "openai", key: "sk-new-key-0000-9999" }])
      yield* identity.removeUserCredential(a.sessionID, "openai")
      expect(yield* identity.userKeys(a.userID)).toEqual([])
      expect((yield* identity.userCredentials(a.sessionID)).items).toEqual([])

      // Not a usable key or integration: nothing is stored.
      expect(yield* identity.setUserCredential(a.sessionID, "openai", "   ").pipe(Effect.flip)).toMatchObject({ reason: "invalid" })
      expect(yield* identity.setUserCredential(a.sessionID, "personal.u.x", "sk-aaaa-bbbb-cccc-1234").pipe(Effect.flip)).toMatchObject({ reason: "invalid" })
      expect(yield* identity.setUserCredential(a.sessionID, "a/b", "sk-aaaa-bbbb-cccc-1234").pipe(Effect.flip)).toMatchObject({ reason: "invalid" })

      // Deleting the user deletes their keys.
      yield* identity.setUserCredential(b.sessionID, "anthropic", "sk-ant-0000-1111-2222")
      yield* identity.deleteUser(admin.sessionID, "9402")
      expect(await_(yield* Effect.promise(() => sql`SELECT * FROM identity_user_credential WHERE user_id = ${b.userID}`))).toHaveLength(0)
      yield* Effect.promise(() => sql.close())
    }),
  )

  it.effect("is off without a secret key, and values no known key opens are skipped", () =>
    Effect.gen(function* () {
      const sql = Postgres.connect(url!)
      yield* Effect.promise(() => Postgres.migrate(sql, migrations))
      const identity = yield* Identity.Service
      const admin = yield* member(identity, "9410")
      yield* identity.setUserCredential(admin.sessionID, "openai", "sk-aaaa-bbbb-cccc-1234")

      const off = make(sql, null)
      expect(yield* off.userCredentials(admin.sessionID)).toEqual({ enabled: false, items: [] })
      expect(yield* off.setUserCredential(admin.sessionID, "xai", "sk-aaaa-bbbb-cccc-1234").pipe(Effect.flip)).toMatchObject({ reason: "invalid" })
      expect(yield* off.userKeys(admin.userID)).toEqual([])
      expect(await_(yield* Effect.promise(() => sql`SELECT * FROM identity_user_credential WHERE integration_id = 'xai'`))).toHaveLength(0)

      // Rotation: the old key stays readable while it is listed as previous, and is skipped once it is dropped.
      const next = Buffer.alloc(32, 9)
      const rotated = make(sql, { current: next, previous: [secretKey] })
      expect(yield* rotated.userKeys(admin.userID)).toEqual([{ integrationID: "openai", key: "sk-aaaa-bbbb-cccc-1234" }])
      const dropped = make(sql, { current: next, previous: [] })
      expect(yield* dropped.userKeys(admin.userID)).toEqual([])
      yield* Effect.promise(() => sql.close())
    }),
  )

  credentialIt.effect("ranks a user's own key between the organization's and their key for the organization", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const identity = yield* Identity.Service
      const db = (yield* Database.Service).db
      const admin = yield* member(identity, "9420")
      yield* identity.setUserCredential(admin.sessionID, "anthropic", "sk-ant-global-0001")
      yield* db.insert(IdentityOrganizationTable).values({ id: "org_g", name: "G" }).run()
      yield* db
        .insert(IdentityUserTable)
        .values([
          { id: "usr_boss", employee_id: "g-boss", password_hash: "x", admin: true },
          { id: admin.userID, employee_id: "9420", password_hash: "x", admin: false },
        ])
        .run()
      const integrationID = Integration.ID.make("anthropic")
      const boss = { organizationID: "org_g", userID: "usr_boss", admin: true }
      const mine = { organizationID: "org_g", userID: admin.userID, admin: false }
      const key = (value: string) => Credential.Key.make({ type: "key", key: value })

      const shared = yield* credentials.create({ integrationID, label: "Shared", value: key("shared"), scope: boss })
      const labels = (scope: Credential.Scope) => credentials.list(integrationID, scope).pipe(Effect.map((items) => items.map((item) => item.label)))
      expect(yield* labels(mine)).toEqual(["Shared", "All organizations"])
      // Others, and screens that list only a user's own personal credentials, do not get it.
      expect(yield* labels(boss)).toEqual(["Shared"])
      expect(yield* labels({ ...mine, ownOnly: true })).toEqual([])
      expect(yield* labels({ organizationID: null, userID: admin.userID, admin: false })).toEqual([])

      // A key for this organization wins over the one for all of them; a global one is read by its ID like any other.
      yield* credentials.create({ integrationID, label: "Mine", value: key("mine"), scope: mine })
      expect(yield* labels(mine)).toEqual(["Shared", "All organizations", "Mine"])
      const global = (yield* credentials.list(integrationID, mine)).find((item) => item.label === "All organizations")!
      expect((yield* credentials.get(global.id, mine))?.value).toEqual(key("sk-ant-global-0001"))
      expect(yield* credentials.get(global.id, boss)).toBeUndefined()
      expect((yield* credentials.all(mine)).map((item) => item.label)).toEqual(["Shared", "All organizations", "Mine"])
      // The global key counts as the user's own, not as one the server provides.
      expect((yield* credentials.scopes(mine)).personal).toContain("anthropic")
      expect((yield* credentials.scopes(boss)).personal).not.toContain("anthropic")
      expect(shared.label).toBe("Shared")
    }),
  )
})

const await_ = <A>(rows: A) => rows as unknown as Array<Record<string, unknown>>

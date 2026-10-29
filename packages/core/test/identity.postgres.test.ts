import path from "node:path"
import os from "node:os"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Database } from "@opencode/core/database/database"
import { Identity } from "@opencode/core/identity"
import { IdentityUserTable } from "@opencode/core/identity/sql"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Global } from "@opencode/util/global"
import { Postgres } from "@opencode/util/postgres"
import { afterAll, describe, expect } from "bun:test"
import { testEffect } from "./lib/effect"

const url = process.env.OPENCODE_TEST_POSTGRES_URL

delete process.env.OPENCODE_ADMIN_EMPLOYEE_ID
delete process.env.OPENCODE_ADMIN_PASSWORD
// Start from nothing, and leave nothing: the identity layer migrates when it is built, which happens before any test
// body, and a leftover admin would stop a real admin from being created in the same database later.
async function reset() {
  const sql = Postgres.connect(url!)
  await sql`DROP TABLE IF EXISTS identity_session, identity_membership, identity_organization, identity_user, auth_migration`
  await sql.close()
}
if (url) {
  process.env.OPENCODE_IDENTITY_POSTGRES_URL = url
  await reset()
}
afterAll(async () => {
  if (url) await reset()
})

const data = path.join(os.tmpdir(), "opencode-ex-identity-postgres")
const database = Database.layerFromClient.pipe(
  Layer.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })),
  Layer.provide(Global.layerWith({ data })),
)
const it = testEffect(Identity.layer.pipe(Layer.provideMerge(database), Layer.provideMerge(Global.layerWith({ data }))))

const password = "password-1"

describe.skipIf(!url)("identity on a shared postgres", () => {
  it.effect("accounts, organizations and roles work end to end", () =>
    Effect.gen(function* () {
      const identity = yield* Identity.Service
      yield* identity.ensureAdmin({ employeeID: "9200", password })
      const admin = (yield* identity.authenticate((yield* identity.login({ employeeID: "9200", password }))!.token))!
      expect(admin.admin).toBe(true)
      expect(yield* identity.login({ employeeID: "9200", password: "wrong-password" })).toBeUndefined()

      const member = yield* identity.register({ employeeID: "9201", password })
      expect((yield* identity.register({ employeeID: "9201", password }).pipe(Effect.flip)).reason).toBe("taken")
      expect((yield* identity.authenticate(member.token))?.organizations).toEqual([])

      const organization = yield* identity.createOrganization(admin.sessionID, "Acme")
      const added = yield* identity.addMember(admin.sessionID, organization.id, "9201")
      expect(added.members).toEqual(["9201"])
      const account = (yield* identity.authenticate(member.token))!
      expect(account.organizationID).toBe(organization.id)
      expect(account.organizationAdmin).toBe(false)
      expect(account.settingsPages).toEqual(Identity.DEFAULT_SETTINGS_PAGES)
      expect(yield* identity.listOrganizations(account.sessionID)).toEqual([])

      yield* identity.setMemberRole(admin.sessionID, organization.id, "9201", "admin")
      expect((yield* identity.authenticate(member.token))?.organizationAdmin).toBe(true)
      expect((yield* identity.listOrganizations(account.sessionID)).map((item) => item.name)).toEqual(["Acme"])
      const pages = yield* identity.setSettingsPages(account.sessionID, organization.id, ["about", "providers"])
      expect(pages.settingsPages).toEqual(["providers", "about"])
      expect((yield* identity.renameOrganization(admin.sessionID, organization.id, "Acme 2")).name).toBe("Acme 2")

      const created = yield* identity.createUser(admin.sessionID, { employeeID: "9202", password, organizationID: organization.id })
      expect(created).toEqual({ employeeID: "9202", admin: false })
      expect((yield* identity.listUsers(admin.sessionID)).map((user) => user.employeeID)).toEqual(["9200", "9201", "9202"])
      const ids = yield* identity.employeeIDs([admin.userID, account.userID])
      expect([...ids.values()].sort()).toEqual(["9200", "9201"])

      const other = yield* identity.createOrganization(admin.sessionID, "Other")
      yield* identity.addMember(admin.sessionID, other.id, "9201")
      expect((yield* identity.switchOrganization(account.sessionID, other.id)).organizationID).toBe(other.id)
      yield* identity.removeMember(admin.sessionID, other.id, "9201")
      expect((yield* identity.authenticate(member.token))?.organizationID).toBe(organization.id)

      yield* identity.resetPassword(admin.sessionID, "9201", "password-2")
      expect(yield* identity.authenticate(member.token)).toBeUndefined()
      expect(yield* identity.login({ employeeID: "9201", password: "password-2" })).toBeDefined()
      yield* identity.deleteUser(admin.sessionID, "9202")
      expect((yield* identity.listUsers(admin.sessionID)).map((user) => user.employeeID)).toEqual(["9200", "9201"])
      yield* identity.logout(admin.sessionID)
      expect(yield* identity.account(admin.sessionID)).toBeUndefined()
    }),
  )

  it.effect("a user deleted elsewhere leaves no mirrored row behind, and the project they made stays", () =>
    Effect.gen(function* () {
      const identity = yield* Identity.Service
      const db = (yield* Database.Service).db
      yield* identity.mirror({ userID: "usr_ghost", employeeID: "9299", organizations: [] })
      const rows = () => db.select({ id: IdentityUserTable.id }).from(IdentityUserTable).where(eq(IdentityUserTable.id, "usr_ghost")).all()
      expect((yield* rows()).length).toBe(1)
      yield* identity.prune((ids) => Effect.succeed(new Set(ids.filter((id) => id !== "usr_ghost"))))
      expect((yield* rows()).length).toBe(0)
      // Mirroring again after it was pruned must put it back, not be skipped by the cache.
      yield* identity.mirror({ userID: "usr_ghost", employeeID: "9299", organizations: [] })
      expect((yield* rows()).length).toBe(1)
    }),
  )
})

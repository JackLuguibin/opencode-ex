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
  await sql`DROP TABLE IF EXISTS session_sync_project, session_sync_session, session_sync_message, identity_audit, identity_join_request, identity_preference, identity_session, identity_membership, identity_organization, identity_user, auth_migration`
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

  it.effect("deleting an organization keeps its members and drops them from it", () =>
    Effect.gen(function* () {
      const identity = yield* Identity.Service
      const admin = (yield* identity.authenticate((yield* identity.login({ employeeID: "9200", password }))!.token))!
      const doomed = yield* identity.createOrganization(admin.sessionID, "Doomed")
      yield* identity.addMember(admin.sessionID, doomed.id, "9201")
      const member = (yield* identity.authenticate((yield* identity.login({ employeeID: "9201", password: "password-2" }))!.token))!
      yield* identity.switchOrganization(member.sessionID, doomed.id)
      yield* identity.deleteOrganization(admin.sessionID, doomed.id)
      expect((yield* identity.listOrganizations(admin.sessionID)).some((item) => item.id === doomed.id)).toBe(false)
      const after = (yield* identity.account(member.sessionID))!
      expect(after.organizationID).not.toBe(doomed.id)
      expect(after.organizations.some((item) => item.id === doomed.id)).toBe(false)
      expect(yield* identity.deleteOrganization(admin.sessionID, doomed.id).pipe(Effect.flip)).toMatchObject({ reason: "missing" })
      expect(yield* identity.deleteOrganization(member.sessionID, doomed.id).pipe(Effect.flip)).toMatchObject({ reason: "forbidden" })
    }),
  )

  it.effect("keeps an account's client state per user and per organization, whichever session reads it", () =>
    Effect.gen(function* () {
      const identity = yield* Identity.Service
      const admin = (yield* identity.authenticate((yield* identity.login({ employeeID: "9200", password }))!.token))!
      const member = yield* identity.register({ employeeID: "9251", password })
      const first = (yield* identity.authenticate(member.token))!
      const organization = yield* identity.createOrganization(admin.sessionID, "Prefs")
      yield* identity.addMember(admin.sessionID, organization.id, "9251")
      const second = (yield* identity.authenticate((yield* identity.login({ employeeID: "9251", password }))!.token))!

      yield* identity.setPreference(first.sessionID, "user", "language", '"zh"')
      yield* identity.setPreference(first.sessionID, "organization", "server", '{"used":["a"]}')
      yield* identity.setPreference(first.sessionID, "user", "language", '"en"')

      // A second login, as on another browser, sees what the first wrote.
      const seen = yield* identity.preferences(second.sessionID)
      expect(seen.user).toEqual({ language: '"en"' })
      expect(seen.organization).toEqual({ server: '{"used":["a"]}' })
      // Organization state is the member's own view of that organization; other members don't see it.
      const other = yield* identity.preferences(admin.sessionID)
      expect(other.user).toEqual({})
      expect(other.organization).toEqual({})

      yield* identity.removePreference(second.sessionID, "organization", "server")
      expect((yield* identity.preferences(first.sessionID)).organization).toEqual({})

      expect((yield* identity.setPreference(first.sessionID, "user", "bad key!", "1").pipe(Effect.flip)).reason).toBe("invalid")
      expect(
        (yield* identity.setPreference(first.sessionID, "user", "big", "x".repeat(600 * 1024)).pipe(Effect.flip)).reason,
      ).toBe("invalid")
      expect((yield* identity.preferences("ses_unknown").pipe(Effect.flip)).reason).toBe("credentials")
    }),
  )

  it.effect("names, join requests and the audit log work on the shared store", () =>
    Effect.gen(function* () {
      const identity = yield* Identity.Service
      yield* identity.ensureAdmin({ employeeID: "9200", password })
      const admin = (yield* identity.authenticate((yield* identity.login({ employeeID: "9200", password }))!.token))!
      const org = yield* identity.createOrganization(admin.sessionID, "Joinable")
      yield* identity.createUser(admin.sessionID, { employeeID: "9211", password, name: "Lin" })
      const member = (yield* identity.authenticate((yield* identity.login({ employeeID: "9211", password }))!.token))!
      expect((yield* identity.setName(admin.sessionID, "9211", "Lin Wei")).name).toBe("Lin Wei")

      const request = yield* identity.requestJoin(member.sessionID, org.id, "please")
      expect(request).toMatchObject({ employeeID: "9211", name: "Lin Wei", status: "pending" })
      expect((yield* identity.pendingJoinRequests(admin.sessionID)).map((item) => item.id)).toEqual([request.id])
      yield* identity.decideJoinRequest(admin.sessionID, request.id, true)
      expect((yield* identity.pendingJoinRequests(admin.sessionID))).toHaveLength(0)

      yield* identity.audit({ actor: "9200", action: "join.approve", target: request.id })
      expect((yield* identity.auditLog(admin.sessionID, 5)).map((entry) => entry.action)).toEqual(["join.approve"])
      expect((yield* identity.auditLog(member.sessionID, 5).pipe(Effect.flip)).reason).toBe("forbidden")
    }),
  )

  it.effect("an organization admin switches session copying, and deleting the organization removes its copies", () =>
    Effect.gen(function* () {
      const identity = yield* Identity.Service
      yield* identity.ensureAdmin({ employeeID: "9200", password })
      const admin = (yield* identity.authenticate((yield* identity.login({ employeeID: "9200", password }))!.token))!
      yield* identity.createUser(admin.sessionID, { employeeID: "9220", password })
      const member = (yield* identity.authenticate((yield* identity.login({ employeeID: "9220", password }))!.token))!
      const org = yield* identity.createOrganization(admin.sessionID, "Copied")
      expect(org.sessionSync).toBe(true)
      expect((yield* identity.setSessionSync(admin.sessionID, org.id, false)).sessionSync).toBe(false)
      expect((yield* identity.setSessionSync(admin.sessionID, org.id, false)).sessionSync).toBe(false)
      expect((yield* identity.setSessionSync(member.sessionID, org.id, true).pipe(Effect.flip)).reason).toBe("forbidden")

      const sql = Postgres.connect(url!)
      yield* Effect.promise(async () => {
        await sql`INSERT INTO session_sync_session (session_id, organization_id, runtime_id, project_id, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created, time_updated, time_synced)
          VALUES ('ses_copy', ${org.id}, 'a', 'prj', 0, 0, 0, 0, 0, 0, 1, 1, 1)`
        await sql`INSERT INTO session_sync_project (runtime_id, project_id, organization_id, worktree, time_created, time_updated, time_synced)
          VALUES ('a', 'prj', ${org.id}, '/w', 1, 1, 1)`
        await sql`INSERT INTO session_sync_message (session_id, seq, id, organization_id, runtime_id, type, data, time_created, time_updated, time_synced)
          VALUES ('ses_copy', 1, 'msg', ${org.id}, 'a', 'user', '{}'::jsonb, 1, 1, 1)`
      })
      yield* identity.deleteOrganization(admin.sessionID, org.id)
      const left = yield* Effect.promise(async () => {
        const rows = await sql`SELECT (SELECT count(*)::int FROM session_sync_session) AS sessions, (SELECT count(*)::int FROM session_sync_message) AS messages, (SELECT count(*)::int FROM session_sync_project) AS projects`
        await sql.close()
        return rows[0]
      })
      expect(left).toEqual({ sessions: 0, messages: 0, projects: 0 })
    }),
  )
})

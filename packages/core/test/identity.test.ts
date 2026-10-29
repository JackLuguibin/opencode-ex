import path from "node:path"
import os from "node:os"
import { stat } from "node:fs/promises"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Database } from "@opencode/core/database/database"
import { Identity } from "@opencode/core/identity"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Project } from "@opencode/schema/project"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Global } from "@opencode/util/global"
import { describe, expect } from "bun:test"
import { testEffect } from "./lib/effect"

delete process.env.OPENCODE_ADMIN_EMPLOYEE_ID
delete process.env.OPENCODE_ADMIN_PASSWORD

const database = Database.layerFromClient.pipe(
  Layer.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })),
  Layer.provide(Global.layerWith({ data: path.join(os.tmpdir(), "opencode-ex-identity") })),
)

const global = Global.layerWith({ data: path.join(os.tmpdir(), "opencode-ex-identity") })

const it = testEffect(Identity.layer.pipe(Layer.provideMerge(database), Layer.provideMerge(global)))

const password = "password-1"

describe("identity", () => {

  it.effect("keeps an account's client state per user and per organization, whichever session reads it", () =>
    Effect.gen(function* () {
      const identity = yield* Identity.Service
      yield* identity.ensureAdmin({ employeeID: "9150", password })
      const admin = (yield* identity.authenticate((yield* identity.login({ employeeID: "9150", password }))!.token))!
      const member = yield* identity.register({ employeeID: "9151", password })
      const first = (yield* identity.authenticate(member.token))!
      const organization = yield* identity.createOrganization(admin.sessionID, "Prefs")
      yield* identity.addMember(admin.sessionID, organization.id, "9151")
      const second = (yield* identity.authenticate((yield* identity.login({ employeeID: "9151", password }))!.token))!

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
  it.effect("lets an admin choose the settings pages ordinary members see", () =>
    Effect.gen(function* () {
      const identity = yield* Identity.Service
      yield* identity.ensureAdmin({ employeeID: "9100", password })
      const admin = yield* identity.login({ employeeID: "9100", password })
      const adminAccount = yield* identity.authenticate(admin!.token)
      const member = yield* identity.register({ employeeID: "9101", password })
      const organization = yield* identity.createOrganization(adminAccount!.sessionID, "Pages")
      yield* identity.addMember(adminAccount!.sessionID, organization.id, "9101")
      const memberAccount = () => identity.authenticate(member.token)

      expect(organization.settingsPages).toEqual(Identity.DEFAULT_SETTINGS_PAGES)
      expect((yield* memberAccount())?.settingsPages).toEqual(Identity.DEFAULT_SETTINGS_PAGES)

      const updated = yield* identity.setSettingsPages(adminAccount!.sessionID, organization.id, ["about", "providers"])
      expect(updated.settingsPages).toEqual(["providers", "about"])
      expect((yield* memberAccount())?.settingsPages).toEqual(["providers", "about"])
      expect((yield* identity.authenticate(admin!.token))?.settingsPages).toEqual(Identity.SETTINGS_PAGES)

      expect(
        (yield* identity.setSettingsPages(adminAccount!.sessionID, organization.id, []).pipe(Effect.flip)).reason,
      ).toBe("invalid")
      expect(
        (yield* identity.setSettingsPages(adminAccount!.sessionID, organization.id, ["nope"]).pipe(Effect.flip)).reason,
      ).toBe("invalid")
      const forbidden = yield* identity
        .setSettingsPages((yield* memberAccount())!.sessionID, organization.id, ["about"])
        .pipe(Effect.flip)
      expect(forbidden.reason).toBe("forbidden")
    }),
  )

  it.effect("lets an admin rename organizations and reset passwords", () =>
    Effect.gen(function* () {
      const identity = yield* Identity.Service
      yield* identity.ensureAdmin({ employeeID: "9200", password })
      const admin = yield* identity.login({ employeeID: "9200", password })
      const adminAccount = (yield* identity.authenticate(admin!.token))!
      const member = yield* identity.register({ employeeID: "9201", password })
      const organization = yield* identity.createOrganization(adminAccount.sessionID, "Before")

      expect((yield* identity.renameOrganization(adminAccount.sessionID, organization.id, "  After ")).name).toBe("After")
      expect(
        (yield* identity.renameOrganization(adminAccount.sessionID, organization.id, "  ").pipe(Effect.flip)).reason,
      ).toBe("invalid")
      const memberSession = (yield* identity.authenticate(member.token))!.sessionID
      expect((yield* identity.renameOrganization(memberSession, organization.id, "Nope").pipe(Effect.flip)).reason).toBe(
        "forbidden",
      )

      yield* identity.resetPassword(adminAccount.sessionID, "9201", "new-password-1")
      expect(yield* identity.authenticate(member.token)).toBeUndefined()
      expect(yield* identity.login({ employeeID: "9201", password })).toBeUndefined()
      expect((yield* identity.login({ employeeID: "9201", password: "new-password-1" }))?.token).toBeDefined()
      expect((yield* identity.resetPassword(adminAccount.sessionID, "9201", "short").pipe(Effect.flip)).reason).toBe(
        "invalid",
      )
      expect((yield* identity.resetPassword(adminAccount.sessionID, "0000", password).pipe(Effect.flip)).reason).toBe(
        "missing",
      )
    }),
  )

  it.effect("keeps a display name beside the employee ID", () =>
    Effect.gen(function* () {
      const identity = yield* Identity.Service
      yield* identity.ensureAdmin({ employeeID: "9400", password })
      const admin = (yield* identity.authenticate((yield* identity.login({ employeeID: "9400", password }))!.token))!
      expect(admin.name).toBeUndefined()

      const created = yield* identity.createUser(admin.sessionID, { employeeID: "9401", password, name: "  Li Lei " })
      expect(created.name).toBe("Li Lei")
      const member = (yield* identity.authenticate((yield* identity.login({ employeeID: "9401", password }))!.token))!
      expect(member.name).toBe("Li Lei")
      expect((yield* identity.listUsers(admin.sessionID)).find((user) => user.employeeID === "9401")?.name).toBe("Li Lei")

      // Only admins name members; a long name is refused.
      expect((yield* identity.setName(member.sessionID, "9401", "Lei").pipe(Effect.flip)).reason).toBe("forbidden")
      expect((yield* identity.setName(admin.sessionID, "9401", "x".repeat(65)).pipe(Effect.flip)).reason).toBe("invalid")
      expect((yield* identity.setName(admin.sessionID, "9401", "Lei Li")).name).toBe("Lei Li")
      expect((yield* identity.setName(admin.sessionID, "9401", " ")).name).toBeUndefined()
      expect((yield* identity.account(member.sessionID))?.name).toBeUndefined()
    }),
  )

  it.effect("lets members ask to join an organization and its admins decide", () =>
    Effect.gen(function* () {
      const identity = yield* Identity.Service
      yield* identity.ensureAdmin({ employeeID: "9500", password })
      const platform = (yield* identity.authenticate((yield* identity.login({ employeeID: "9500", password }))!.token))!
      const alpha = yield* identity.createOrganization(platform.sessionID, "Alpha")
      const beta = yield* identity.createOrganization(platform.sessionID, "Beta")
      yield* identity.createUser(platform.sessionID, { employeeID: "9501", password, organizationID: alpha.id })
      yield* identity.setMemberRole(platform.sessionID, alpha.id, "9501", "admin")
      const alphaAdmin = (yield* identity.authenticate((yield* identity.login({ employeeID: "9501", password }))!.token))!
      yield* identity.createUser(platform.sessionID, { employeeID: "9502", password, name: "Han" })
      yield* identity.createUser(platform.sessionID, { employeeID: "9503", password, organizationID: beta.id })
      const applicant = (yield* identity.authenticate((yield* identity.login({ employeeID: "9502", password }))!.token))!
      const outsider = (yield* identity.authenticate((yield* identity.login({ employeeID: "9503", password }))!.token))!

      expect((yield* identity.joinableOrganizations(applicant.sessionID)).map((item) => item.name)).toEqual(["Alpha", "Beta"])
      const request = yield* identity.requestJoin(applicant.sessionID, alpha.id, " let me in ")
      expect(request).toMatchObject({ employeeID: "9502", name: "Han", organizationName: "Alpha", note: "let me in", status: "pending" })
      expect((yield* identity.requestJoin(applicant.sessionID, alpha.id).pipe(Effect.flip)).reason).toBe("taken")
      expect((yield* identity.requestJoin(applicant.sessionID, "org_missing").pipe(Effect.flip)).reason).toBe("invalid")

      // Only that organization's admins and platform admins see and decide it.
      expect((yield* identity.pendingJoinRequests(alphaAdmin.sessionID)).map((item) => item.id)).toEqual([request.id])
      expect(yield* identity.pendingJoinRequests(outsider.sessionID)).toEqual([])
      expect((yield* identity.pendingJoinRequests(platform.sessionID)).length).toBe(1)
      expect((yield* identity.decideJoinRequest(outsider.sessionID, request.id, true).pipe(Effect.flip)).reason).toBe("forbidden")

      expect((yield* identity.decideJoinRequest(alphaAdmin.sessionID, request.id, true)).status).toBe("approved")
      expect((yield* identity.account(applicant.sessionID))?.organizationID).toBe(alpha.id)
      expect((yield* identity.decideJoinRequest(alphaAdmin.sessionID, request.id, false).pipe(Effect.flip)).reason).toBe("missing")
      expect((yield* identity.myJoinRequests(applicant.sessionID))[0]?.status).toBe("approved")
      expect(yield* identity.pendingJoinRequests(alphaAdmin.sessionID)).toEqual([])
      expect((yield* identity.requestJoin(applicant.sessionID, alpha.id).pipe(Effect.flip)).reason).toBe("invalid")

      const second = yield* identity.requestJoin(applicant.sessionID, beta.id)
      expect((yield* identity.decideJoinRequest(platform.sessionID, second.id, false)).status).toBe("rejected")
      expect((yield* identity.account(applicant.sessionID))?.organizations.map((item) => item.name)).toEqual(["Alpha"])
    }),
  )

  it.effect("lets an admin create, promote and delete users", () =>
    Effect.gen(function* () {
      const identity = yield* Identity.Service
      yield* identity.ensureAdmin({ employeeID: "9300", password })
      const admin = (yield* identity.authenticate((yield* identity.login({ employeeID: "9300", password }))!.token))!
      const organization = yield* identity.createOrganization(admin.sessionID, "Staff")

      const created = yield* identity.createUser(admin.sessionID, {
        employeeID: " 9301 ",
        password,
        organizationID: organization.id,
      })
      expect(created).toEqual({ employeeID: "9301", admin: false })
      const login = yield* identity.login({ employeeID: "9301", password })
      expect((yield* identity.authenticate(login!.token))?.organizationID).toBe(organization.id)
      expect((yield* identity.createUser(admin.sessionID, { employeeID: "9301", password }).pipe(Effect.flip)).reason).toBe(
        "taken",
      )
      expect((yield* identity.createUser(admin.sessionID, { employeeID: "9302", password: "short" }).pipe(Effect.flip)).reason).toBe(
        "invalid",
      )
      expect(
        (yield* identity.createUser(admin.sessionID, { employeeID: "9302", password, organizationID: "org_missing" }).pipe(Effect.flip))
          .reason,
      ).toBe("invalid")
      expect((yield* identity.listUsers(admin.sessionID)).map((user) => user.employeeID)).not.toContain("9302")

      expect(yield* identity.setAdmin(admin.sessionID, "9301", true)).toEqual({ employeeID: "9301", admin: true })
      expect((yield* identity.setAdmin(admin.sessionID, "9300", false).pipe(Effect.flip)).reason).toBe("self")
      expect((yield* identity.deleteUser(admin.sessionID, "9300").pipe(Effect.flip)).reason).toBe("self")
      expect((yield* identity.deleteUser(admin.sessionID, "0000").pipe(Effect.flip)).reason).toBe("missing")

      yield* identity.deleteUser(admin.sessionID, "9301")
      expect(yield* identity.authenticate(login!.token)).toBeUndefined()
      expect(yield* identity.login({ employeeID: "9301", password })).toBeUndefined()
      expect((yield* identity.listOrganizations(admin.sessionID)).find((item) => item.id === organization.id)?.members).toEqual([])
    }),
  )

  it.effect("registers and logs in with an employee ID", () =>
    Effect.gen(function* () {
      const identity = yield* Identity.Service
      const registered = yield* identity.register({ employeeID: " 1001 ", password })
      const logged = yield* identity.login({ employeeID: "1001", password })
      const account = yield* identity.authenticate(registered.token)
      expect(logged?.token).not.toBe(registered.token)
      expect(account?.employeeID).toBe("1001")
      expect(account?.admin).toBe(false)
      expect(account?.organizationID).toBeUndefined()
      expect(yield* identity.login({ employeeID: "1001", password: "wrong-password" })).toBeUndefined()
    }),
  )

  it.effect("rejects a duplicate employee ID and a short password", () =>
    Effect.gen(function* () {
      const identity = yield* Identity.Service
      yield* identity.register({ employeeID: "1002", password })
      const taken = yield* identity.register({ employeeID: "1002", password }).pipe(Effect.flip)
      const invalid = yield* identity.register({ employeeID: "1003", password: "short" }).pipe(Effect.flip)
      expect(taken.reason).toBe("taken")
      expect(invalid.reason).toBe("invalid")
    }),
  )

  it.effect("lists registered employee IDs only for admins, including users without an organization", () =>
    Effect.gen(function* () {
      const identity = yield* Identity.Service
      yield* identity.ensureAdmin({ employeeID: "9000", password })
      const adminToken = yield* identity.login({ employeeID: "9000", password })
      const admin = yield* identity.authenticate(adminToken?.token ?? "")
      if (!admin) throw new Error("admin session missing")
      const token = yield* identity.register({ employeeID: "1001", password })
      yield* identity.register({ employeeID: "1000", password })
      const member = yield* identity.authenticate(token.token)
      if (!member) throw new Error("member session missing")
      expect(yield* identity.listUsers(admin.sessionID)).toEqual([
        { employeeID: "1000", admin: false },
        { employeeID: "1001", admin: false },
        { employeeID: "9000", admin: true },
      ])
      expect((yield* identity.listUsers(member.sessionID).pipe(Effect.flip)).reason).toBe("forbidden")
      expect((yield* identity.listUsers("missing-session").pipe(Effect.flip)).reason).toBe("credentials")
    }),
  )

  it.effect("lets only an admin create organizations and scopes projects to the current organization", () =>
    Effect.gen(function* () {
      const identity = yield* Identity.Service
      const db = (yield* Database.Service).db
      yield* identity.ensureAdmin({ employeeID: "9000", password })
      const adminToken = yield* identity.login({ employeeID: "9000", password })
      const admin = yield* identity.authenticate(adminToken?.token ?? "")
      if (!admin) throw new Error("admin session missing")
      const memberToken = yield* identity.register({ employeeID: "1004", password })
      const member = yield* identity.authenticate(memberToken.token)
      if (!member) throw new Error("member session missing")
      const denied = yield* identity.createOrganization(member.sessionID, "Denied").pipe(Effect.flip)
      expect(denied.reason).toBe("forbidden")

      const projectID = Project.ID.make("prj_identity_owned")
      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: AbsolutePath.make("/tmp/opencode-ex-identity-owned"), sandboxes: [] })
        .run()
      const first = yield* identity.createOrganization(admin.sessionID, "Acme")
      const claimed = yield* db
        .select({
          organization_id: ProjectTable.organization_id,
          created_by_user_id: ProjectTable.created_by_user_id,
        })
        .from(ProjectTable)
        .where(eq(ProjectTable.id, projectID))
        .get()
      expect(claimed?.organization_id).toBe(first.id)
      expect(claimed?.created_by_user_id).toBe(admin.userID)

      const secondProject = Project.ID.make("prj_identity_open")
      yield* db
        .insert(ProjectTable)
        .values({
          id: secondProject,
          worktree: AbsolutePath.make("/tmp/opencode-ex-identity-open"),
          sandboxes: [],
        })
        .run()
      const other = yield* identity.createOrganization(admin.sessionID, "Other")
      const unclaimed = yield* db
        .select({ organization_id: ProjectTable.organization_id })
        .from(ProjectTable)
        .where(eq(ProjectTable.id, secondProject))
        .get()
      expect(unclaimed?.organization_id).toBeNull()

      const missing = yield* identity.addMember(admin.sessionID, first.id, "4040").pipe(Effect.flip)
      expect(missing.reason).toBe("missing")
      yield* identity.addMember(admin.sessionID, first.id, "1004")
      yield* identity.addMember(admin.sessionID, first.id, "9000")
      const claimedByMember = yield* identity.claimOrAllow(secondProject, {
        userID: member.userID,
        organizationID: first.id,
      })
      const sharedWithAdmin = yield* identity.claimOrAllow(secondProject, {
        userID: admin.userID,
        organizationID: first.id,
      })
      const otherOrganization = yield* identity.claimOrAllow(secondProject, {
        userID: member.userID,
        organizationID: other.id,
      })
      expect(claimedByMember).toBe(true)
      expect(sharedWithAdmin).toBe(true)
      expect(otherOrganization).toBe(false)
      const visible = yield* identity.projectIDs(first.id)
      expect(visible.has(secondProject)).toBe(true)
      expect(visible.has(projectID)).toBe(true)
      expect((yield* identity.projectIDs(other.id)).size).toBe(0)

      const directory = yield* identity.organizationDirectory(first.id)
      expect(directory).toBe(
        AbsolutePath.make(path.join(os.tmpdir(), "opencode-ex-identity", "organizations", first.id, "默认目录")),
      )
      expect((yield* Effect.promise(() => stat(directory))).isDirectory()).toBe(true)
    }),
  )

  it.effect("lets an organization admin manage only their own organization", () =>
    Effect.gen(function* () {
      const identity = yield* Identity.Service
      yield* identity.ensureAdmin({ employeeID: "9400", password })
      const platform = yield* identity.login({ employeeID: "9400", password })
      const platformAccount = (yield* identity.authenticate(platform!.token))!
      const lead = yield* identity.register({ employeeID: "9401", password })
      yield* identity.register({ employeeID: "9402", password })
      yield* identity.register({ employeeID: "9403", password })
      const own = yield* identity.createOrganization(platformAccount.sessionID, "Own")
      const other = yield* identity.createOrganization(platformAccount.sessionID, "Other")
      yield* identity.addMember(platformAccount.sessionID, own.id, "9401")
      yield* identity.addMember(platformAccount.sessionID, other.id, "9401")
      yield* identity.addMember(platformAccount.sessionID, own.id, "9403")

      const promoted = yield* identity.setMemberRole(platformAccount.sessionID, own.id, "9401", "admin")
      expect(promoted.admins).toEqual(["9401"])
      const leadAccount = (yield* identity.authenticate(lead.token))!
      expect(leadAccount.admin).toBe(false)
      expect(leadAccount.organizationID).toBe(own.id)
      expect(leadAccount.organizationAdmin).toBe(true)
      expect(leadAccount.settingsPages).toEqual(Identity.SETTINGS_PAGES)

      // The admin of one organization is an ordinary member of the other.
      expect(yield* identity.canManageOrganization(leadAccount.sessionID, own.id)).toBe(true)
      expect(yield* identity.canManageOrganization(leadAccount.sessionID, other.id)).toBe(false)
      expect((yield* identity.listOrganizations(leadAccount.sessionID)).map((item) => item.id)).toEqual([own.id])

      expect((yield* identity.addMember(leadAccount.sessionID, own.id, "9402")).members).toContain("9402")
      expect((yield* identity.setSettingsPages(leadAccount.sessionID, own.id, ["about"])).settingsPages).toEqual(["about"])
      expect((yield* identity.addMember(leadAccount.sessionID, other.id, "9402").pipe(Effect.flip)).reason).toBe("forbidden")
      expect((yield* identity.setSettingsPages(leadAccount.sessionID, other.id, ["about"]).pipe(Effect.flip)).reason).toBe(
        "forbidden",
      )
      expect((yield* identity.removeMember(leadAccount.sessionID, own.id, "9403")).members).not.toContain("9403")

      // Platform-level actions and role changes stay with platform admins.
      expect((yield* identity.createOrganization(leadAccount.sessionID, "Nope").pipe(Effect.flip)).reason).toBe("forbidden")
      expect((yield* identity.setMemberRole(leadAccount.sessionID, own.id, "9402", "admin").pipe(Effect.flip)).reason).toBe(
        "forbidden",
      )
      expect((yield* identity.removeMember(leadAccount.sessionID, own.id, "9401").pipe(Effect.flip)).reason).toBe("forbidden")

      const demoted = yield* identity.setMemberRole(platformAccount.sessionID, own.id, "9401", "member")
      expect(demoted.admins).toEqual([])
      expect((yield* identity.authenticate(lead.token))?.organizationAdmin).toBe(false)
    }),
  )
})

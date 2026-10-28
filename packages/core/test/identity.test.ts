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
})

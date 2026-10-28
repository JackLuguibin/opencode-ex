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
      expect(yield* identity.listUsers(admin.sessionID)).toEqual(["1000", "1001", "9000"])
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

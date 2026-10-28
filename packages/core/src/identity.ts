export * as Identity from "./identity.js"

import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { and, asc, eq, isNull } from "drizzle-orm"
import { Context, Data, Effect, Layer } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Global } from "@opencode/util/global"
import { Database } from "./database/database.js"
import {
  IdentityMembershipTable,
  IdentityOrganizationTable,
  IdentitySessionTable,
  IdentityUserTable,
} from "./identity/sql.js"
import { ProjectTable } from "./project/sql.js"
import type { ProjectSchema } from "./project/schema.js"
import { AbsolutePath } from "./schema.js"

/** Folder inside an organization's directory that holds its default project; the parent itself is never a project. */
const DEFAULT_DIRECTORY = "默认目录"
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>

export class Rejected extends Data.TaggedError("Identity.Rejected")<{
  readonly reason: "invalid" | "taken" | "forbidden" | "missing" | "credentials"
}> {}

export type Account = {
  readonly sessionID: string
  readonly userID: string
  readonly employeeID: string
  readonly admin: boolean
  readonly organizationID: string | undefined
  readonly organizations: ReadonlyArray<{ readonly id: string; readonly name: string }>
}

export type OrganizationRecord = {
  readonly id: string
  readonly name: string
  readonly members: ReadonlyArray<string>
}

export interface Interface {
  readonly ensureAdmin: (input: { readonly employeeID: string; readonly password: string }) => Effect.Effect<void>
  readonly register: (input: {
    readonly employeeID: string
    readonly password: string
  }) => Effect.Effect<{ readonly token: string }, Rejected>
  readonly login: (input: {
    readonly employeeID: string
    readonly password: string
  }) => Effect.Effect<{ readonly token: string } | undefined>
  readonly logout: (sessionID: string) => Effect.Effect<void>
  readonly authenticate: (token: string) => Effect.Effect<Account | undefined>
  readonly account: (sessionID: string) => Effect.Effect<Account | undefined>
  readonly switchOrganization: (sessionID: string, organizationID: string) => Effect.Effect<Account, Rejected>
  readonly createOrganization: (sessionID: string, name: string) => Effect.Effect<OrganizationRecord, Rejected>
  readonly listUsers: (sessionID: string) => Effect.Effect<ReadonlyArray<string>, Rejected>
  readonly listOrganizations: (sessionID: string) => Effect.Effect<ReadonlyArray<OrganizationRecord>, Rejected>
  readonly addMember: (
    sessionID: string,
    organizationID: string,
    employeeID: string,
  ) => Effect.Effect<OrganizationRecord, Rejected>
  readonly removeMember: (
    sessionID: string,
    organizationID: string,
    employeeID: string,
  ) => Effect.Effect<OrganizationRecord, Rejected>
  readonly claimOrAllow: (
    projectID: ProjectSchema.ID,
    input: { readonly userID: string; readonly organizationID: string },
  ) => Effect.Effect<boolean>
  /** Default project directory of an organization (`默认目录` inside its own directory), created on first use. */
  readonly organizationDirectory: (organizationID: string) => Effect.Effect<AbsolutePath>
  /** Directory that holds an organization's projects, the parent of its default directory. It is never a project itself. */
  readonly organizationRoot: (organizationID: string) => Effect.Effect<AbsolutePath>
  readonly projectIDs: (organizationID: string) => Effect.Effect<ReadonlySet<string>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Identity") {}

type DatabaseClient = Database.Interface["db"]

function make(db: DatabaseClient, global: Global.Interface): Interface {
  const organizationDirectory = Effect.fn("Identity.organizationDirectory")(function* (organizationID: string) {
    const directory = path.join(global.data, "organizations", organizationID, DEFAULT_DIRECTORY)
    yield* Effect.promise(() => mkdir(directory, { recursive: true })).pipe(Effect.orDie)
    return AbsolutePath.make(directory)
  })

  const organizationRoot = (organizationID: string) =>
    organizationDirectory(organizationID).pipe(Effect.map((directory) => AbsolutePath.make(path.dirname(directory))))

  const userByEmployee = (employeeID: string) =>
    db.select().from(IdentityUserTable).where(eq(IdentityUserTable.employee_id, employeeID)).get().pipe(Effect.orDie)

  const issue = (userID: string) =>
    Effect.gen(function* () {
      const token = randomBytes(32).toString("base64url")
      const now = Date.now()
      yield* db
        .insert(IdentitySessionTable)
        .values({
          id: identifier("ses"),
          token_hash: tokenHash(token),
          user_id: userID,
          expires_at: now + SESSION_TTL_MS,
          time_created: now,
          time_updated: now,
        })
        .run()
        .pipe(Effect.orDie)
      return { token }
    })

  const organizationsFor = (userID: string) =>
    db
      .select({
        id: IdentityOrganizationTable.id,
        name: IdentityOrganizationTable.name,
      })
      .from(IdentityMembershipTable)
      .innerJoin(IdentityOrganizationTable, eq(IdentityMembershipTable.organization_id, IdentityOrganizationTable.id))
      .where(eq(IdentityMembershipTable.user_id, userID))
      .orderBy(asc(IdentityMembershipTable.time_created), asc(IdentityOrganizationTable.id))
      .all()
      .pipe(Effect.orDie)

  const account = Effect.fn("Identity.account")(function* (sessionID: string) {
    const session = yield* db
      .select()
      .from(IdentitySessionTable)
      .where(eq(IdentitySessionTable.id, sessionID))
      .get()
      .pipe(Effect.orDie)
    if (!session || session.expires_at <= Date.now()) return
    const user = yield* db
      .select()
      .from(IdentityUserTable)
      .where(eq(IdentityUserTable.id, session.user_id))
      .get()
      .pipe(Effect.orDie)
    if (!user) return
    const organizations = yield* organizationsFor(user.id)
    const current = organizations.some((item) => item.id === session.organization_id)
      ? (session.organization_id ?? undefined)
      : organizations[0]?.id
    if (current !== (session.organization_id ?? undefined)) {
      yield* db
        .update(IdentitySessionTable)
        .set({ organization_id: current ?? null, time_updated: Date.now() })
        .where(eq(IdentitySessionTable.id, session.id))
        .run()
        .pipe(Effect.orDie)
    }
    return {
      sessionID: session.id,
      userID: user.id,
      employeeID: user.employee_id,
      admin: user.admin,
      organizationID: current,
      organizations,
    }
  })

  const requireAdmin = (sessionID: string) =>
    Effect.gen(function* () {
      const current = yield* account(sessionID)
      if (!current) return yield* new Rejected({ reason: "credentials" })
      if (!current.admin) return yield* new Rejected({ reason: "forbidden" })
      return current
    })

  const organization = Effect.fn("Identity.organization")(function* (organizationID: string) {
    const row = yield* db
      .select()
      .from(IdentityOrganizationTable)
      .where(eq(IdentityOrganizationTable.id, organizationID))
      .get()
      .pipe(Effect.orDie)
    if (!row) return
    const members = yield* db
      .select({ employeeID: IdentityUserTable.employee_id })
      .from(IdentityMembershipTable)
      .innerJoin(IdentityUserTable, eq(IdentityMembershipTable.user_id, IdentityUserTable.id))
      .where(eq(IdentityMembershipTable.organization_id, organizationID))
      .orderBy(asc(IdentityUserTable.employee_id))
      .all()
      .pipe(Effect.orDie)
    return { id: row.id, name: row.name, members: members.map((item) => item.employeeID) }
  })

  return {
    ensureAdmin: Effect.fn("Identity.ensureAdmin")(function* (input) {
      const existingAdmin = yield* db
        .select({ id: IdentityUserTable.id })
        .from(IdentityUserTable)
        .where(eq(IdentityUserTable.admin, true))
        .get()
        .pipe(Effect.orDie)
      if (existingAdmin) return
      const employeeID = normalizeEmployeeID(input.employeeID)
      if (!employeeID || !validPassword(input.password)) {
        yield* Effect.logWarning("platform admin bootstrap skipped because the employee ID or password is invalid")
        return
      }
      const existing = yield* userByEmployee(employeeID)
      if (existing) {
        yield* Effect.logWarning("platform admin bootstrap skipped because that employee ID is already registered")
        return
      }
      const now = Date.now()
      yield* db
        .insert(IdentityUserTable)
        .values({
          id: identifier("usr"),
          employee_id: employeeID,
          password_hash: yield* Effect.promise(() => hashPassword(input.password)),
          admin: true,
          time_created: now,
          time_updated: now,
        })
        .run()
        .pipe(Effect.orDie)
      yield* Effect.logInfo("platform admin created", { employeeID })
    }),
    register: Effect.fn("Identity.register")(function* (input) {
      const employeeID = normalizeEmployeeID(input.employeeID)
      if (!employeeID || !validPassword(input.password)) return yield* new Rejected({ reason: "invalid" })
      if (yield* userByEmployee(employeeID)) return yield* new Rejected({ reason: "taken" })
      const now = Date.now()
      const userID = identifier("usr")
      yield* db
        .insert(IdentityUserTable)
        .values({
          id: userID,
          employee_id: employeeID,
          password_hash: yield* Effect.promise(() => hashPassword(input.password)),
          admin: false,
          time_created: now,
          time_updated: now,
        })
        .run()
        .pipe(Effect.orDie)
      return yield* issue(userID)
    }),
    login: Effect.fn("Identity.login")(function* (input) {
      const employeeID = normalizeEmployeeID(input.employeeID)
      if (!employeeID || !input.password) return
      const user = yield* userByEmployee(employeeID)
      if (!user) return
      const matches = yield* Effect.promise(() => verifyPassword(input.password, user.password_hash))
      if (!matches) return
      return yield* issue(user.id)
    }),
    logout: Effect.fn("Identity.logout")(function* (sessionID: string) {
      yield* db.delete(IdentitySessionTable).where(eq(IdentitySessionTable.id, sessionID)).run().pipe(Effect.orDie)
    }),
    authenticate: Effect.fn("Identity.authenticate")(function* (token) {
      const session = yield* db
        .select({ id: IdentitySessionTable.id, expires_at: IdentitySessionTable.expires_at })
        .from(IdentitySessionTable)
        .where(eq(IdentitySessionTable.token_hash, tokenHash(token)))
        .get()
        .pipe(Effect.orDie)
      if (!session) return
      if (session.expires_at <= Date.now()) {
        yield* db.delete(IdentitySessionTable).where(eq(IdentitySessionTable.id, session.id)).run().pipe(Effect.orDie)
        return
      }
      return yield* account(session.id)
    }),
    account,
    switchOrganization: Effect.fn("Identity.switchOrganization")(function* (sessionID, organizationID) {
      const current = yield* account(sessionID)
      if (!current) return yield* new Rejected({ reason: "credentials" })
      if (!current.organizations.some((item) => item.id === organizationID))
        return yield* new Rejected({ reason: "invalid" })
      yield* db
        .update(IdentitySessionTable)
        .set({ organization_id: organizationID, time_updated: Date.now() })
        .where(eq(IdentitySessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      const next = yield* account(sessionID)
      if (!next) return yield* new Rejected({ reason: "credentials" })
      return next
    }),
    createOrganization: Effect.fn("Identity.createOrganization")(function* (sessionID, name) {
      const current = yield* requireAdmin(sessionID)
      const trimmed = name.trim()
      if (!trimmed || trimmed.length > 80) return yield* new Rejected({ reason: "invalid" })
      const organizationID = identifier("org")
      const now = Date.now()
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const existing = yield* tx
              .select({ id: IdentityOrganizationTable.id })
              .from(IdentityOrganizationTable)
              .all()
            yield* tx
              .insert(IdentityOrganizationTable)
              .values({ id: organizationID, name: trimmed, time_created: now, time_updated: now })
              .run()
            if (existing.length > 0) return
            yield* tx
              .update(ProjectTable)
              .set({
                organization_id: organizationID,
                created_by_user_id: current.userID,
                time_updated: now,
              })
              .where(isNull(ProjectTable.organization_id))
              .run()
          }),
        )
        .pipe(Effect.orDie)
      yield* organizationDirectory(organizationID)
      const created = yield* organization(organizationID)
      if (!created) return yield* new Rejected({ reason: "invalid" })
      return created
    }),
    listUsers: Effect.fn("Identity.listUsers")(function* (sessionID) {
      yield* requireAdmin(sessionID)
      const users = yield* db
        .select({ employeeID: IdentityUserTable.employee_id })
        .from(IdentityUserTable)
        .orderBy(asc(IdentityUserTable.employee_id))
        .all()
        .pipe(Effect.orDie)
      return users.map((user) => user.employeeID)
    }),
    listOrganizations: Effect.fn("Identity.listOrganizations")(function* (sessionID) {
      yield* requireAdmin(sessionID)
      const rows = yield* db
        .select()
        .from(IdentityOrganizationTable)
        .orderBy(asc(IdentityOrganizationTable.time_created), asc(IdentityOrganizationTable.id))
        .all()
        .pipe(Effect.orDie)
      const listed = yield* Effect.forEach(rows, (row) => organization(row.id))
      return listed.filter((item) => item !== undefined)
    }),
    addMember: Effect.fn("Identity.addMember")(function* (sessionID, organizationID, employeeID) {
      yield* requireAdmin(sessionID)
      const normalized = normalizeEmployeeID(employeeID)
      if (!normalized) return yield* new Rejected({ reason: "invalid" })
      const user = yield* userByEmployee(normalized)
      if (!user) return yield* new Rejected({ reason: "missing" })
      const existing = yield* organization(organizationID)
      if (!existing) return yield* new Rejected({ reason: "invalid" })
      const now = Date.now()
      yield* db
        .insert(IdentityMembershipTable)
        .values({
          organization_id: organizationID,
          user_id: user.id,
          time_created: now,
          time_updated: now,
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .update(IdentitySessionTable)
        .set({ organization_id: organizationID, time_updated: now })
        .where(and(eq(IdentitySessionTable.user_id, user.id), isNull(IdentitySessionTable.organization_id)))
        .run()
        .pipe(Effect.orDie)
      const detail = yield* organization(organizationID)
      if (!detail) return yield* new Rejected({ reason: "invalid" })
      return detail
    }),
    removeMember: Effect.fn("Identity.removeMember")(function* (sessionID, organizationID, employeeID) {
      yield* requireAdmin(sessionID)
      const normalized = normalizeEmployeeID(employeeID)
      if (!normalized) return yield* new Rejected({ reason: "invalid" })
      const existing = yield* organization(organizationID)
      if (!existing) return yield* new Rejected({ reason: "invalid" })
      const user = yield* userByEmployee(normalized)
      if (user) {
        yield* db
          .delete(IdentityMembershipTable)
          .where(
            and(
              eq(IdentityMembershipTable.organization_id, organizationID),
              eq(IdentityMembershipTable.user_id, user.id),
            ),
          )
          .run()
          .pipe(Effect.orDie)
        yield* db
          .update(IdentitySessionTable)
          .set({ organization_id: null, time_updated: Date.now() })
          .where(
            and(eq(IdentitySessionTable.user_id, user.id), eq(IdentitySessionTable.organization_id, organizationID)),
          )
          .run()
          .pipe(Effect.orDie)
      }
      const detail = yield* organization(organizationID)
      if (!detail) return yield* new Rejected({ reason: "invalid" })
      return detail
    }),
    claimOrAllow: Effect.fn("Identity.claimOrAllow")(function* (projectID, input) {
      const claimed = yield* db
        .update(ProjectTable)
        .set({
          organization_id: input.organizationID,
          created_by_user_id: input.userID,
          time_updated: Date.now(),
        })
        .where(
          and(
            eq(ProjectTable.id, projectID),
            isNull(ProjectTable.organization_id),
            isNull(ProjectTable.created_by_user_id),
          ),
        )
        .returning({ id: ProjectTable.id })
        .get()
        .pipe(Effect.orDie)
      if (claimed) return true
      const row = yield* db
        .select({ organization_id: ProjectTable.organization_id })
        .from(ProjectTable)
        .where(eq(ProjectTable.id, projectID))
        .get()
        .pipe(Effect.orDie)
      return row?.organization_id === input.organizationID
    }),
    organizationDirectory,
    organizationRoot,
    projectIDs: Effect.fn("Identity.projectIDs")(function* (organizationID) {
      const rows = yield* db
        .select({ id: ProjectTable.id })
        .from(ProjectTable)
        .where(eq(ProjectTable.organization_id, organizationID))
        .all()
        .pipe(Effect.orDie)
      return new Set(rows.map((row) => row.id))
    }),
  }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const identity = make(db, yield* Global.Service)
    const employeeID = process.env.OPENCODE_ADMIN_EMPLOYEE_ID
    const password = process.env.OPENCODE_ADMIN_PASSWORD
    if (employeeID && password) yield* identity.ensureAdmin({ employeeID, password })
    return identity
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, Global.node],
})

function normalizeEmployeeID(input: string) {
  const value = input.trim()
  if (!value || value.length > 64 || /[\s/\\?#]/.test(value)) return
  return value
}

function validPassword(input: string) {
  return input.length >= 8 && input.length <= 128
}

function identifier(prefix: string) {
  return `${prefix}_${randomBytes(16).toString("hex")}`
}

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex")
}

function hashPassword(password: string) {
  const salt = randomBytes(16)
  return scryptAsync(password, salt, 32).then(
    (key) => `scrypt$${salt.toString("base64url")}$${key.toString("base64url")}`,
  )
}

function verifyPassword(password: string, stored: string) {
  const [algorithm, salt, expected] = stored.split("$")
  if (algorithm !== "scrypt" || !salt || !expected) return Promise.resolve(false)
  const actual = Buffer.from(expected, "base64url")
  return scryptAsync(password, Buffer.from(salt, "base64url"), actual.length).then(
    (key) => key.length === actual.length && timingSafeEqual(key, actual),
  )
}

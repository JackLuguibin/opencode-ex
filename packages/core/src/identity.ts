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
import { SessionTable, SessionUserTable } from "./session/sql.js"
import type { SessionSchema } from "./session/schema.js"
import type { ProjectSchema } from "./project/schema.js"
import { AbsolutePath } from "./schema.js"

/** Folder inside an organization's directory that holds its default project; the parent itself is never a project. */
const DEFAULT_DIRECTORY = "默认目录"
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>

export class Rejected extends Data.TaggedError("Identity.Rejected")<{
  readonly reason: "invalid" | "taken" | "forbidden" | "missing" | "credentials" | "self"
}> {}

/** Every settings page an admin can open to ordinary members. */
export const SETTINGS_PAGES = [
  "providers",
  "models",
  "servers",
  "general",
  "appearance",
  "notifications",
  "shortcuts",
  "extensions",
  "projects",
  "workspaces",
  "experimental",
  "about",
] as const
/** What ordinary members of an organization see until an admin configures it. */
export const DEFAULT_SETTINGS_PAGES: ReadonlyArray<string> = ["providers", "models", "servers"]

export type Account = {
  readonly sessionID: string
  readonly userID: string
  readonly employeeID: string
  readonly admin: boolean
  readonly organizationID: string | undefined
  /** Settings pages the account sees; admins see them all. */
  readonly settingsPages: ReadonlyArray<string>
  readonly organizations: ReadonlyArray<{ readonly id: string; readonly name: string }>
}

export type UserRecord = {
  readonly employeeID: string
  readonly admin: boolean
}

export type OrganizationRecord = {
  readonly id: string
  readonly name: string
  readonly members: ReadonlyArray<string>
  readonly settingsPages: ReadonlyArray<string>
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
  readonly listUsers: (sessionID: string) => Effect.Effect<ReadonlyArray<UserRecord>, Rejected>
  /** Registers an employee ID on someone's behalf, optionally as an admin or as a member of an organization. */
  readonly createUser: (
    sessionID: string,
    input: {
      readonly employeeID: string
      readonly password: string
      readonly admin?: boolean
      readonly organizationID?: string
    },
  ) => Effect.Effect<UserRecord, Rejected>
  /** Removes an employee ID with its sessions and memberships. Admins can't remove themselves. */
  readonly deleteUser: (sessionID: string, employeeID: string) => Effect.Effect<void, Rejected>
  /** Grants or withdraws platform admin. Admins can't change their own role. */
  readonly setAdmin: (sessionID: string, employeeID: string, admin: boolean) => Effect.Effect<UserRecord, Rejected>
  readonly listOrganizations: (sessionID: string) => Effect.Effect<ReadonlyArray<OrganizationRecord>, Rejected>
  readonly renameOrganization: (
    sessionID: string,
    organizationID: string,
    name: string,
  ) => Effect.Effect<OrganizationRecord, Rejected>
  /** Replaces an employee's password and signs them out everywhere. */
  readonly resetPassword: (
    sessionID: string,
    employeeID: string,
    password: string,
  ) => Effect.Effect<void, Rejected>
  /** Sets the settings pages ordinary members of an organization can open. */
  readonly setSettingsPages: (
    sessionID: string,
    organizationID: string,
    pages: ReadonlyArray<string>,
  ) => Effect.Effect<OrganizationRecord, Rejected>
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
  /** Remembers that a user started or continued a session; the latest record wins. */
  readonly touchSessionUser: (sessionID: SessionSchema.ID, userID: string) => Effect.Effect<void>
  /** The user a session acts for, or the nearest ancestor's when it is a subagent's. */
  readonly sessionUser: (sessionID: SessionSchema.ID) => Effect.Effect<string | undefined>
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
    const configured = current
      ? yield* db
          .select({ pages: IdentityOrganizationTable.settings_pages })
          .from(IdentityOrganizationTable)
          .where(eq(IdentityOrganizationTable.id, current))
          .get()
          .pipe(Effect.orDie)
      : undefined
    return {
      sessionID: session.id,
      userID: user.id,
      employeeID: user.employee_id,
      admin: user.admin,
      organizationID: current,
      settingsPages: user.admin ? SETTINGS_PAGES : (configured?.pages ?? DEFAULT_SETTINGS_PAGES),
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
    return {
      id: row.id,
      name: row.name,
      members: members.map((item) => item.employeeID),
      settingsPages: row.settings_pages ?? DEFAULT_SETTINGS_PAGES,
    }
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
      return yield* db
        .select({ employeeID: IdentityUserTable.employee_id, admin: IdentityUserTable.admin })
        .from(IdentityUserTable)
        .orderBy(asc(IdentityUserTable.employee_id))
        .all()
        .pipe(Effect.orDie)
    }),
    createUser: Effect.fn("Identity.createUser")(function* (sessionID, input) {
      yield* requireAdmin(sessionID)
      const employeeID = normalizeEmployeeID(input.employeeID)
      if (!employeeID || !validPassword(input.password)) return yield* new Rejected({ reason: "invalid" })
      if (yield* userByEmployee(employeeID)) return yield* new Rejected({ reason: "taken" })
      if (input.organizationID && !(yield* organization(input.organizationID)))
        return yield* new Rejected({ reason: "invalid" })
      const now = Date.now()
      const userID = identifier("usr")
      const admin = input.admin === true
      const passwordHash = yield* Effect.promise(() => hashPassword(input.password))
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .insert(IdentityUserTable)
              .values({
                id: userID,
                employee_id: employeeID,
                password_hash: passwordHash,
                admin,
                time_created: now,
                time_updated: now,
              })
              .run()
            if (!input.organizationID) return
            yield* tx
              .insert(IdentityMembershipTable)
              .values({ organization_id: input.organizationID, user_id: userID, time_created: now, time_updated: now })
              .run()
          }),
        )
        .pipe(Effect.orDie)
      return { employeeID, admin }
    }),
    deleteUser: Effect.fn("Identity.deleteUser")(function* (sessionID, employeeID) {
      const current = yield* requireAdmin(sessionID)
      const normalized = normalizeEmployeeID(employeeID)
      const user = normalized ? yield* userByEmployee(normalized) : undefined
      if (!user) return yield* new Rejected({ reason: "missing" })
      if (user.id === current.userID) return yield* new Rejected({ reason: "self" })
      // Sessions and memberships go with the user through their foreign keys.
      yield* db.delete(IdentityUserTable).where(eq(IdentityUserTable.id, user.id)).run().pipe(Effect.orDie)
    }),
    setAdmin: Effect.fn("Identity.setAdmin")(function* (sessionID, employeeID, admin) {
      const current = yield* requireAdmin(sessionID)
      const normalized = normalizeEmployeeID(employeeID)
      const user = normalized ? yield* userByEmployee(normalized) : undefined
      if (!user) return yield* new Rejected({ reason: "missing" })
      if (user.id === current.userID) return yield* new Rejected({ reason: "self" })
      yield* db
        .update(IdentityUserTable)
        .set({ admin, time_updated: Date.now() })
        .where(eq(IdentityUserTable.id, user.id))
        .run()
        .pipe(Effect.orDie)
      return { employeeID: user.employee_id, admin }
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
    renameOrganization: Effect.fn("Identity.renameOrganization")(function* (sessionID, organizationID, name) {
      yield* requireAdmin(sessionID)
      const trimmed = name.trim()
      if (!trimmed || trimmed.length > 80) return yield* new Rejected({ reason: "invalid" })
      const updated = yield* db
        .update(IdentityOrganizationTable)
        .set({ name: trimmed, time_updated: Date.now() })
        .where(eq(IdentityOrganizationTable.id, organizationID))
        .returning({ id: IdentityOrganizationTable.id })
        .get()
        .pipe(Effect.orDie)
      if (!updated) return yield* new Rejected({ reason: "invalid" })
      const detail = yield* organization(organizationID)
      if (!detail) return yield* new Rejected({ reason: "invalid" })
      return detail
    }),
    resetPassword: Effect.fn("Identity.resetPassword")(function* (sessionID, employeeID, password) {
      yield* requireAdmin(sessionID)
      const normalized = normalizeEmployeeID(employeeID)
      if (!normalized || !validPassword(password)) return yield* new Rejected({ reason: "invalid" })
      const user = yield* userByEmployee(normalized)
      if (!user) return yield* new Rejected({ reason: "missing" })
      yield* db
        .update(IdentityUserTable)
        .set({ password_hash: yield* Effect.promise(() => hashPassword(password)), time_updated: Date.now() })
        .where(eq(IdentityUserTable.id, user.id))
        .run()
        .pipe(Effect.orDie)
      yield* db.delete(IdentitySessionTable).where(eq(IdentitySessionTable.user_id, user.id)).run().pipe(Effect.orDie)
    }),
    setSettingsPages: Effect.fn("Identity.setSettingsPages")(function* (sessionID, organizationID, pages) {
      yield* requireAdmin(sessionID)
      const known = new Set<string>(SETTINGS_PAGES)
      const unique = SETTINGS_PAGES.filter((page) => pages.includes(page))
      if (unique.length === 0 || pages.some((page) => !known.has(page))) return yield* new Rejected({ reason: "invalid" })
      const updated = yield* db
        .update(IdentityOrganizationTable)
        .set({ settings_pages: unique, time_updated: Date.now() })
        .where(eq(IdentityOrganizationTable.id, organizationID))
        .returning({ id: IdentityOrganizationTable.id })
        .get()
        .pipe(Effect.orDie)
      if (!updated) return yield* new Rejected({ reason: "invalid" })
      const detail = yield* organization(organizationID)
      if (!detail) return yield* new Rejected({ reason: "invalid" })
      return detail
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
    touchSessionUser: Effect.fn("Identity.touchSessionUser")(function* (sessionID, userID) {
      const now = Date.now()
      yield* db
        .insert(SessionUserTable)
        .values({ session_id: sessionID, user_id: userID, time_created: now, time_updated: now })
        .onConflictDoUpdate({ target: SessionUserTable.session_id, set: { user_id: userID, time_updated: now } })
        .run()
        .pipe(Effect.orDie)
    }),
    sessionUser: Effect.fn("Identity.sessionUser")(function* (sessionID) {
      let current: SessionSchema.ID | null = sessionID
      // Subagent sessions act for the user of the session that spawned them.
      for (let depth = 0; current && depth < 8; depth++) {
        const row = yield* db
          .select({ userID: SessionUserTable.user_id })
          .from(SessionUserTable)
          .where(eq(SessionUserTable.session_id, current))
          .get()
          .pipe(Effect.orDie)
        if (row) return row.userID
        const parent: { readonly parentID: SessionSchema.ID | null } | undefined = yield* db
          .select({ parentID: SessionTable.parent_id })
          .from(SessionTable)
          .where(eq(SessionTable.id, current))
          .get()
          .pipe(Effect.orDie)
        current = parent?.parentID ?? null
      }
      return undefined
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

export * as Identity from "./identity.js"

import { randomBytes } from "node:crypto"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { and, asc, desc, eq, inArray, isNull, type SQL } from "drizzle-orm"
import { Context, Duration, Effect, Layer, Schedule } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Global } from "@opencode/util/global"
import { GlobalPackage } from "./global-package.js"
import { Database } from "./database/database.js"
import {
  globalConfigSignature,
  organizationRoots,
  syncOrganizationConfig,
} from "./identity/config-sync.js"
import {
  IdentityMembershipTable,
  IdentityOrganizationTable,
  IdentityAuditTable,
  IdentityJoinRequestTable,
  IdentityPreferenceTable,
  IdentitySessionTable,
  IdentityUserTable,
} from "./identity/sql.js"
import { ProjectTable } from "./project/sql.js"
import { SessionTable, SessionUserTable } from "./session/sql.js"
import type { Store } from "./identity/postgres.js"
import { IdentityUsage } from "./identity/usage.js"
import type { SessionSchema } from "./session/schema.js"
import type { ProjectSchema } from "./project/schema.js"
import { AbsolutePath } from "./schema.js"
import {
  DEFAULT_SETTINGS_PAGES,
  Rejected,
  SESSION_TTL_MS,
  SETTINGS_PAGES,
  hashPassword,
  PREFERENCE_MAX_BYTES,
  identifier,
  normalizeEmployeeID,
  normalizeName,
  tokenHash,
  validPassword,
  validPreferenceKey,
  verifyPassword,
} from "./identity/shared.js"

export { DEFAULT_SETTINGS_PAGES, Rejected, SETTINGS_PAGES }

/** Folder inside an organization's directory that holds its default project; the parent itself is never a project. */
const DEFAULT_DIRECTORY = "默认目录"
/** Folder inside an organization's directory that every member can browse; each member writes only to their own subfolder. */
const SHARED_DIRECTORY = "公共空间"
/** Every settings page an admin can open to ordinary members. */
export type Account = {
  readonly sessionID: string
  readonly userID: string
  readonly employeeID: string
  /** Display name; the employee ID is shown when there is none. */
  readonly name: string | undefined
  readonly admin: boolean
  readonly organizationID: string | undefined
  /** Whether the account manages its current organization: an organization admin there, or a platform admin. */
  readonly organizationAdmin: boolean
  /** Settings pages the account sees; admins see them all. */
  readonly settingsPages: ReadonlyArray<string>
  readonly organizations: ReadonlyArray<{ readonly id: string; readonly name: string }>
}

/** A request to join an organization. */
export type JoinRequest = {
  readonly id: string
  readonly organizationID: string
  readonly organizationName: string
  readonly employeeID: string
  readonly name?: string
  readonly note?: string
  readonly status: "pending" | "approved" | "rejected"
  readonly time: number
}

export type AuditInput = {
  /** Employee ID of whoever acted. */
  readonly actor: string
  readonly action: string
  readonly target?: string
  readonly detail?: string
}

export type AuditEntry = AuditInput & { readonly id: string; readonly time: number }

export type MemberRole = "admin" | "member"
export type PreferenceScope = "user" | "organization"
/** What an account keeps for itself (`user`) and for its current organization, by key. */
export interface Preferences {
  readonly user: Readonly<Record<string, string>>
  readonly organization: Readonly<Record<string, string>>
}

export type UserRecord = {
  readonly employeeID: string
  readonly name?: string
  readonly admin: boolean
}

export type OrganizationRecord = {
  readonly id: string
  readonly name: string
  readonly members: ReadonlyArray<string>
  /** Display names of the members who have one, by employee ID. */
  readonly names: Readonly<Record<string, string>>
  /** Members who manage this organization. */
  readonly admins: ReadonlyArray<string>
  readonly settingsPages: ReadonlyArray<string>
  /** Whether the organization's sessions are copied to the shared Postgres; absent without one. */
  readonly sessionSync?: boolean
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
      readonly name?: string
      readonly admin?: boolean
      readonly organizationID?: string
    },
  ) => Effect.Effect<UserRecord, Rejected>
  /** Removes an employee ID with its sessions and memberships. Admins can't remove themselves. */
  readonly deleteUser: (sessionID: string, employeeID: string) => Effect.Effect<void, Rejected>
  /** Notes an administrative action. A failure to write it never fails the action itself. */
  readonly audit: (entry: AuditInput) => Effect.Effect<void>
  /** The most recent audit entries, newest first. Platform admins only. */
  readonly auditLog: (sessionID: string, limit: number) => Effect.Effect<ReadonlyArray<AuditEntry>, Rejected>
  /** Sets a display name. Only platform admins name members. An empty name clears it. */
  readonly setName: (sessionID: string, employeeID: string, name: string) => Effect.Effect<UserRecord, Rejected>
  /** Grants or withdraws platform admin. Admins can't change their own role. */
  readonly setAdmin: (sessionID: string, employeeID: string, admin: boolean) => Effect.Effect<UserRecord, Rejected>
  /** Every organization for a platform admin, otherwise the ones the account manages. */
  readonly listOrganizations: (sessionID: string) => Effect.Effect<ReadonlyArray<OrganizationRecord>, Rejected>
  /** Whether the account is a platform admin or an admin of this organization. */
  readonly canManageOrganization: (sessionID: string, organizationID: string) => Effect.Effect<boolean, Rejected>
  /** Makes a member an admin of their organization or an ordinary member again. Only platform admins can change roles. */
  readonly setMemberRole: (
    sessionID: string,
    organizationID: string,
    employeeID: string,
    role: MemberRole,
  ) => Effect.Effect<OrganizationRecord, Rejected>
  readonly renameOrganization: (
    sessionID: string,
    organizationID: string,
    name: string,
  ) => Effect.Effect<OrganizationRecord, Rejected>
  /**
   * Deletes an organization. Its members stay and fall back to their other organizations; what the organization's
   * projects hold is the caller's to remove first. Platform admins only.
   */
  readonly deleteOrganization: (sessionID: string, organizationID: string) => Effect.Effect<void, Rejected>
  /** Forgets this process's copy of an organization that was deleted from the shared store. */
  readonly dropOrganization: (organizationID: string) => Effect.Effect<void>
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
  /** Turns the copy of an organization's sessions to the shared Postgres on or off. Needs the shared Postgres. */
  readonly setSessionSync: (
    sessionID: string,
    organizationID: string,
    enabled: boolean,
  ) => Effect.Effect<OrganizationRecord, Rejected>
  /**
   * Usage of one organization in a range, from the sessions copied to the shared Postgres. Organization admins and
   * platform admins see everyone; a member sees only their own. Needs the shared Postgres.
   */
  readonly usage: (
    sessionID: string,
    organizationID: string,
    query: IdentityUsage.Query,
  ) => Effect.Effect<IdentityUsage.Report, Rejected>
  /** Sessions of an organization that changed in a range, for the usage page's search. */
  readonly usageSessions: (
    sessionID: string,
    organizationID: string,
    query: IdentityUsage.SessionQuery,
  ) => Effect.Effect<{ readonly total: number; readonly items: ReadonlyArray<IdentityUsage.Session> }, Rejected>
  /** The copied messages of one session, redacted. */
  readonly usageMessages: (
    sessionID: string,
    organizationID: string,
    target: string,
    page: { readonly limit?: number; readonly offset?: number },
  ) => Effect.Effect<ReadonlyArray<IdentityUsage.Message>, Rejected>
  /** Usage of every organization in a range. Platform admins only. */
  readonly usageOrganizations: (
    sessionID: string,
    range: { readonly from: number; readonly to: number },
  ) => Effect.Effect<ReadonlyArray<IdentityUsage.Organization>, Rejected>
  /** Organizations the account has not joined, which it may ask to join. */
  readonly joinableOrganizations: (
    sessionID: string,
  ) => Effect.Effect<ReadonlyArray<{ readonly id: string; readonly name: string }>, Rejected>
  /** Asks to join an organization. One open request per organization at a time. */
  readonly requestJoin: (sessionID: string, organizationID: string, note?: string) => Effect.Effect<JoinRequest, Rejected>
  /** The account's own requests, newest first. */
  readonly myJoinRequests: (sessionID: string) => Effect.Effect<ReadonlyArray<JoinRequest>, Rejected>
  /** Open requests the account may decide: every one for a platform admin, else those for organizations it administers. */
  readonly pendingJoinRequests: (sessionID: string) => Effect.Effect<ReadonlyArray<JoinRequest>, Rejected>
  /** Approving makes the requester a member of the organization. */
  readonly decideJoinRequest: (sessionID: string, requestID: string, approve: boolean) => Effect.Effect<JoinRequest, Rejected>
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
  /**
   * Makes sure this process's database knows the user and organizations it is about to record against. Projects,
   * sessions and credentials point at them through foreign keys; with accounts in a shared Postgres they would
   * otherwise exist only there. Existing rows are left alone.
   */
  readonly prune: (existing: (userIDs: readonly string[]) => Effect.Effect<Set<string>>) => Effect.Effect<void>
  readonly mirror: (input: {
    readonly userID: string
    readonly employeeID: string
    readonly organizations: ReadonlyArray<{ readonly id: string; readonly name: string }>
    /** An organization the caller named without belonging to it, such as a platform admin's target. */
    readonly organizationID?: string
  }) => Effect.Effect<void>
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
  /** Shared space of an organization (`公共空间` inside its own directory), created on first use. */
  readonly organizationSharedDirectory: (organizationID: string) => Effect.Effect<AbsolutePath>
  /** Directory that holds an organization's projects, the parent of its default directory. It is never a project itself. */
  readonly organizationRoot: (organizationID: string) => Effect.Effect<AbsolutePath>
  /**
   * Where the organization's directory is, without creating it. Identity routes run on whichever layer answers, which
   * is usually not the one the organization is pinned to, and must not leave an empty directory behind on the others.
   */
  readonly organizationPath: (organizationID: string) => Effect.Effect<AbsolutePath>
  readonly projectIDs: (organizationID: string) => Effect.Effect<ReadonlySet<string>>
  /** Who owns and who may see a project; missing when it doesn't exist. */
  readonly projectAccess: (projectID: ProjectSchema.ID) => Effect.Effect<ProjectAccess | undefined>
  readonly setProjectVisibility: (projectID: ProjectSchema.ID, visibility: Visibility) => Effect.Effect<void>
  /** Who started a session and who may see it; missing when no user ever touched it. */
  readonly sessionAccess: (sessionID: SessionSchema.ID) => Effect.Effect<SessionAccess | undefined>
  readonly setSessionVisibility: (sessionID: SessionSchema.ID, visibility: Visibility) => Effect.Effect<void>
  /** The account's own client state and that of its current organization, which follow it to any browser. */
  readonly preferences: (sessionID: string) => Effect.Effect<Preferences, Rejected>
  readonly setPreference: (
    sessionID: string,
    scope: PreferenceScope,
    key: string,
    value: string,
  ) => Effect.Effect<void, Rejected>
  readonly removePreference: (sessionID: string, scope: PreferenceScope, key: string) => Effect.Effect<void, Rejected>
  /** Employee IDs for user IDs, for showing who owns what. */
  readonly employeeIDs: (userIDs: ReadonlyArray<string>) => Effect.Effect<ReadonlyMap<string, string>>
}

export type Visibility = "organization" | "private"
export interface ProjectAccess {
  readonly organizationID: string | undefined
  readonly creatorUserID: string | undefined
  readonly visibility: Visibility
}
export interface SessionAccess {
  readonly creatorUserID: string
  readonly visibility: Visibility
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Identity") {}

type DatabaseClient = Database.Interface["db"]

function make(db: DatabaseClient, global: Global.Interface): Interface {
  // Organizations whose own config has been brought up to date with the global one since this process started.
  const configured = new Set<string>()

  const organizationDirectory = Effect.fn("Identity.organizationDirectory")(function* (organizationID: string) {
    const directory = path.join(global.data, "organizations", organizationID, DEFAULT_DIRECTORY)
    yield* Effect.promise(() => mkdir(directory, { recursive: true })).pipe(Effect.orDie)
    // Every organization has a shared space beside its default directory, including ones created before it existed.
    yield* Effect.promise(() => mkdir(path.join(path.dirname(directory), SHARED_DIRECTORY), { recursive: true })).pipe(
      Effect.orDie,
    )
    // Each organization loads its own `.opencode` config, seeded from the global one when the organization is created.
    if (!configured.has(organizationID)) {
      configured.add(organizationID)
      yield* Effect.promise(async () =>
        syncOrganizationConfig(
          global.config,
          path.dirname(directory),
          await GlobalPackage.readHidden(global.config, global.data, organizationID),
        ),
      ).pipe(
        Effect.catchCause((cause) => Effect.logWarning("failed to sync organization config", { organizationID, cause })),
      )
    }
    return AbsolutePath.make(directory)
  })

  const organizationSharedDirectory = Effect.fn("Identity.organizationSharedDirectory")(function* (
    organizationID: string,
  ) {
    const directory = path.join(global.data, "organizations", organizationID, SHARED_DIRECTORY)
    yield* Effect.promise(() => mkdir(directory, { recursive: true })).pipe(Effect.orDie)
    return AbsolutePath.make(directory)
  })

  const organizationRoot = (organizationID: string) =>
    organizationDirectory(organizationID).pipe(Effect.map((directory) => AbsolutePath.make(path.dirname(directory))))

  const organizationPath = (organizationID: string) =>
    Effect.succeed(AbsolutePath.make(path.join(global.data, "organizations", organizationID)))

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

  /** The user and current organization a session signed in as; preferences belong to them. */
  const preferenceOwner = Effect.fn("Identity.preferenceOwner")(function* (sessionID: string) {
    const found = yield* account(sessionID)
    if (!found) return yield* new Rejected({ reason: "credentials" })
    return { userID: found.userID, organizationID: found.organizationID }
  })

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
    const role = current
      ? yield* db
          .select({ role: IdentityMembershipTable.role })
          .from(IdentityMembershipTable)
          .where(
            and(eq(IdentityMembershipTable.organization_id, current), eq(IdentityMembershipTable.user_id, user.id)),
          )
          .get()
          .pipe(Effect.orDie)
      : undefined
    const organizationAdmin = user.admin || role?.role === "admin"
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
      name: user.name ?? undefined,
      admin: user.admin,
      organizationID: current,
      organizationAdmin,
      settingsPages: organizationAdmin ? SETTINGS_PAGES : (configured?.pages ?? DEFAULT_SETTINGS_PAGES),
      organizations,
    }
  })

  const requireSession = (sessionID: string) =>
    Effect.gen(function* () {
      const current = yield* account(sessionID)
      if (!current) return yield* new Rejected({ reason: "credentials" })
      return current
    })

  const requireAdmin = (sessionID: string) =>
    Effect.gen(function* () {
      const current = yield* requireSession(sessionID)
      if (!current.admin) return yield* new Rejected({ reason: "forbidden" })
      return current
    })

  const requireOrganizationAdmin = (sessionID: string, organizationID: string) =>
    Effect.gen(function* () {
      const current = yield* requireSession(sessionID)
      if (current.admin) return current
      const membership = yield* db
        .select({ role: IdentityMembershipTable.role })
        .from(IdentityMembershipTable)
        .where(
          and(
            eq(IdentityMembershipTable.organization_id, organizationID),
            eq(IdentityMembershipTable.user_id, current.userID),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      if (membership?.role !== "admin") return yield* new Rejected({ reason: "forbidden" })
      return current
    })

  const joinRequests = (where: SQL | undefined) =>
    db
      .select({
        id: IdentityJoinRequestTable.id,
        organizationID: IdentityJoinRequestTable.organization_id,
        organizationName: IdentityOrganizationTable.name,
        employeeID: IdentityUserTable.employee_id,
        name: IdentityUserTable.name,
        note: IdentityJoinRequestTable.note,
        status: IdentityJoinRequestTable.status,
        time: IdentityJoinRequestTable.time_created,
      })
      .from(IdentityJoinRequestTable)
      .innerJoin(IdentityOrganizationTable, eq(IdentityJoinRequestTable.organization_id, IdentityOrganizationTable.id))
      .innerJoin(IdentityUserTable, eq(IdentityJoinRequestTable.user_id, IdentityUserTable.id))
      .where(where)
      .orderBy(desc(IdentityJoinRequestTable.time_created))
      .all()
      .pipe(
        Effect.orDie,
        Effect.map((rows): ReadonlyArray<JoinRequest> =>
          rows.map((row) => ({ ...row, name: row.name ?? undefined, note: row.note ?? undefined })),
        ),
      )

  const organization = Effect.fn("Identity.organization")(function* (organizationID: string) {
    const row = yield* db
      .select()
      .from(IdentityOrganizationTable)
      .where(eq(IdentityOrganizationTable.id, organizationID))
      .get()
      .pipe(Effect.orDie)
    if (!row) return
    const members = yield* db
      .select({ employeeID: IdentityUserTable.employee_id, name: IdentityUserTable.name, role: IdentityMembershipTable.role })
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
      names: Object.fromEntries(members.flatMap((item) => (item.name ? [[item.employeeID, item.name]] : []))),
      admins: members.filter((item) => item.role === "admin").map((item) => item.employeeID),
      settingsPages: row.settings_pages ?? DEFAULT_SETTINGS_PAGES,
    }
  })

  const mirrored = new Set<string>()

  return {
    prune: Effect.fn("Identity.prune")(function* (existing) {
      const ids = (yield* db.select({ id: IdentityUserTable.id }).from(IdentityUserTable).all().pipe(Effect.orDie)).map(
        (row) => row.id,
      )
      const present = yield* existing(ids)
      const gone = ids.filter((id) => !present.has(id))
      if (gone.length === 0) return
      // Projects and sessions the user created stay, owned by no one; their credentials and memberships go with them.
      yield* db.delete(IdentityUserTable).where(inArray(IdentityUserTable.id, gone)).run().pipe(Effect.orDie)
      for (const key of mirrored) if (gone.some((id) => key.startsWith(`${id}|`))) mirrored.delete(key)
    }),
    mirror: Effect.fn("Identity.mirror")(function* (input) {
      const key = `${input.userID}|${input.organizations.map((item) => item.id).join(",")}`
      if (mirrored.has(key)) return
      const now = Date.now()
      yield* db
        .insert(IdentityUserTable)
        // The hash is not a valid scrypt string, so a mirrored row can never be logged into.
        .values({ id: input.userID, employee_id: input.employeeID, password_hash: "!", admin: false, time_created: now, time_updated: now })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      for (const item of input.organizations)
        yield* db
          .insert(IdentityOrganizationTable)
          .values({ id: item.id, name: item.name, time_created: now, time_updated: now })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
      mirrored.add(key)
    }),
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
        .select({ employeeID: IdentityUserTable.employee_id, name: IdentityUserTable.name, admin: IdentityUserTable.admin })
        .from(IdentityUserTable)
        .orderBy(asc(IdentityUserTable.employee_id))
        .all()
        .pipe(Effect.orDie)
        .pipe(Effect.map((rows) => rows.map((row) => ({ ...row, name: row.name ?? undefined }))))
    }),
    createUser: Effect.fn("Identity.createUser")(function* (sessionID, input) {
      yield* requireAdmin(sessionID)
      const employeeID = normalizeEmployeeID(input.employeeID)
      const name = normalizeName(input.name)
      if (!employeeID || !validPassword(input.password) || name === undefined) return yield* new Rejected({ reason: "invalid" })
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
                name,
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
      return { employeeID, name: name ?? undefined, admin }
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
    audit: Effect.fn("Identity.audit")(function* (entry) {
      yield* db
        .insert(IdentityAuditTable)
        .values({
          id: identifier("aud"),
          actor: entry.actor,
          action: entry.action,
          target: entry.target ?? null,
          detail: entry.detail?.slice(0, 500) ?? null,
          time_created: Date.now(),
        })
        .run()
        .pipe(Effect.ignore)
    }),
    auditLog: Effect.fn("Identity.auditLog")(function* (sessionID, limit) {
      yield* requireAdmin(sessionID)
      const rows = yield* db
        .select()
        .from(IdentityAuditTable)
        .orderBy(desc(IdentityAuditTable.time_created))
        .limit(Math.min(Math.max(limit, 1), 500))
        .pipe(Effect.orDie)
      return rows.map((row) => ({
        id: row.id,
        actor: row.actor,
        action: row.action,
        target: row.target ?? undefined,
        detail: row.detail ?? undefined,
        time: row.time_created,
      }))
    }),
    setName: Effect.fn("Identity.setName")(function* (sessionID, employeeID, input) {
      const current = yield* requireSession(sessionID)
      const normalized = normalizeEmployeeID(employeeID)
      const name = normalizeName(input)
      if (name === undefined) return yield* new Rejected({ reason: "invalid" })
      const user = normalized ? yield* userByEmployee(normalized) : undefined
      if (!user) return yield* new Rejected({ reason: "missing" })
      if (!current.admin) return yield* new Rejected({ reason: "forbidden" })
      yield* db
        .update(IdentityUserTable)
        .set({ name, time_updated: Date.now() })
        .where(eq(IdentityUserTable.id, user.id))
        .run()
        .pipe(Effect.orDie)
      return { employeeID: user.employee_id, name: name ?? undefined, admin: user.admin }
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
      return { employeeID: user.employee_id, name: user.name ?? undefined, admin }
    }),
    listOrganizations: Effect.fn("Identity.listOrganizations")(function* (sessionID) {
      const current = yield* requireSession(sessionID)
      const rows = yield* db
        .select({ id: IdentityOrganizationTable.id })
        .from(IdentityOrganizationTable)
        .where(
          current.admin
            ? undefined
            : inArray(
                IdentityOrganizationTable.id,
                db
                  .select({ id: IdentityMembershipTable.organization_id })
                  .from(IdentityMembershipTable)
                  .where(
                    and(eq(IdentityMembershipTable.user_id, current.userID), eq(IdentityMembershipTable.role, "admin")),
                  ),
              ),
        )
        .orderBy(asc(IdentityOrganizationTable.time_created), asc(IdentityOrganizationTable.id))
        .all()
        .pipe(Effect.orDie)
      const listed = yield* Effect.forEach(rows, (row) => organization(row.id))
      return listed.filter((item) => item !== undefined)
    }),
    canManageOrganization: Effect.fn("Identity.canManageOrganization")(function* (sessionID, organizationID) {
      return yield* requireOrganizationAdmin(sessionID, organizationID).pipe(
        Effect.as(true),
        Effect.catchIf((error) => error.reason === "forbidden", () => Effect.succeed(false)),
      )
    }),
    setMemberRole: Effect.fn("Identity.setMemberRole")(function* (sessionID, organizationID, employeeID, role) {
      yield* requireAdmin(sessionID)
      const normalized = normalizeEmployeeID(employeeID)
      const user = normalized ? yield* userByEmployee(normalized) : undefined
      if (!user) return yield* new Rejected({ reason: "missing" })
      const updated = yield* db
        .update(IdentityMembershipTable)
        .set({ role, time_updated: Date.now() })
        .where(
          and(eq(IdentityMembershipTable.organization_id, organizationID), eq(IdentityMembershipTable.user_id, user.id)),
        )
        .returning({ userID: IdentityMembershipTable.user_id })
        .get()
        .pipe(Effect.orDie)
      if (!updated) return yield* new Rejected({ reason: "invalid" })
      const detail = yield* organization(organizationID)
      if (!detail) return yield* new Rejected({ reason: "invalid" })
      return detail
    }),
    deleteOrganization: Effect.fn("Identity.deleteOrganization")(function* (sessionID, organizationID) {
      yield* requireAdmin(sessionID)
      const deleted = yield* db
        .delete(IdentityOrganizationTable)
        .where(eq(IdentityOrganizationTable.id, organizationID))
        .returning({ id: IdentityOrganizationTable.id })
        .get()
        .pipe(Effect.orDie)
      if (!deleted) return yield* new Rejected({ reason: "missing" })
    }),
    dropOrganization: Effect.fn("Identity.dropOrganization")(function* (organizationID) {
      yield* db
        .delete(IdentityOrganizationTable)
        .where(eq(IdentityOrganizationTable.id, organizationID))
        .run()
        .pipe(Effect.orDie)
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
      yield* requireOrganizationAdmin(sessionID, organizationID)
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
    // Without the shared Postgres nothing is copied, so there is nothing to switch.
    setSessionSync: Effect.fn("Identity.setSessionSync")(function* (sessionID, organizationID) {
      yield* requireOrganizationAdmin(sessionID, organizationID)
      return yield* new Rejected({ reason: "invalid" })
    }),
    // Usage is read from the copies in the shared Postgres; a single process has none.
    usage: Effect.fn("Identity.usage")(function* (sessionID) {
      yield* requireSession(sessionID)
      return yield* new Rejected({ reason: "invalid" })
    }),
    usageSessions: Effect.fn("Identity.usageSessions")(function* (sessionID) {
      yield* requireSession(sessionID)
      return yield* new Rejected({ reason: "invalid" })
    }),
    usageMessages: Effect.fn("Identity.usageMessages")(function* (sessionID) {
      yield* requireSession(sessionID)
      return yield* new Rejected({ reason: "invalid" })
    }),
    usageOrganizations: Effect.fn("Identity.usageOrganizations")(function* (sessionID) {
      yield* requireSession(sessionID)
      return yield* new Rejected({ reason: "invalid" })
    }),
    joinableOrganizations: Effect.fn("Identity.joinableOrganizations")(function* (sessionID) {
      const current = yield* requireSession(sessionID)
      const joined = new Set(current.organizations.map((item) => item.id))
      const all = yield* db
        .select({ id: IdentityOrganizationTable.id, name: IdentityOrganizationTable.name })
        .from(IdentityOrganizationTable)
        .orderBy(asc(IdentityOrganizationTable.name))
        .all()
        .pipe(Effect.orDie)
      return all.filter((item) => !joined.has(item.id))
    }),
    requestJoin: Effect.fn("Identity.requestJoin")(function* (sessionID, organizationID, note) {
      const current = yield* requireSession(sessionID)
      const target = yield* organization(organizationID)
      if (!target || current.organizations.some((item) => item.id === organizationID))
        return yield* new Rejected({ reason: "invalid" })
      const open = yield* joinRequests(
        and(
          eq(IdentityJoinRequestTable.user_id, current.userID),
          eq(IdentityJoinRequestTable.organization_id, organizationID),
          eq(IdentityJoinRequestTable.status, "pending"),
        ),
      )
      if (open.length > 0) return yield* new Rejected({ reason: "taken" })
      const now = Date.now()
      const id = identifier("req")
      yield* db
        .insert(IdentityJoinRequestTable)
        .values({
          id,
          user_id: current.userID,
          organization_id: organizationID,
          note: note?.trim().slice(0, 500) || null,
          status: "pending",
          time_created: now,
          time_updated: now,
        })
        .run()
        .pipe(Effect.orDie)
      return (yield* joinRequests(eq(IdentityJoinRequestTable.id, id)))[0]!
    }),
    myJoinRequests: Effect.fn("Identity.myJoinRequests")(function* (sessionID) {
      const current = yield* requireSession(sessionID)
      return yield* joinRequests(eq(IdentityJoinRequestTable.user_id, current.userID))
    }),
    pendingJoinRequests: Effect.fn("Identity.pendingJoinRequests")(function* (sessionID) {
      const current = yield* requireSession(sessionID)
      const pending = eq(IdentityJoinRequestTable.status, "pending")
      if (current.admin) return yield* joinRequests(pending)
      const managed = yield* db
        .select({ id: IdentityMembershipTable.organization_id })
        .from(IdentityMembershipTable)
        .where(and(eq(IdentityMembershipTable.user_id, current.userID), eq(IdentityMembershipTable.role, "admin")))
        .all()
        .pipe(Effect.orDie)
      if (managed.length === 0) return []
      return yield* joinRequests(
        and(
          pending,
          inArray(
            IdentityJoinRequestTable.organization_id,
            managed.map((item) => item.id),
          ),
        ),
      )
    }),
    decideJoinRequest: Effect.fn("Identity.decideJoinRequest")(function* (sessionID, requestID, approve) {
      const found = (yield* joinRequests(eq(IdentityJoinRequestTable.id, requestID)))[0]
      if (!found || found.status !== "pending") return yield* new Rejected({ reason: "missing" })
      const current = yield* requireOrganizationAdmin(sessionID, found.organizationID)
      const now = Date.now()
      const row = yield* db
        .select({ userID: IdentityJoinRequestTable.user_id })
        .from(IdentityJoinRequestTable)
        .where(eq(IdentityJoinRequestTable.id, requestID))
        .get()
        .pipe(Effect.orDie)
      yield* db
        .update(IdentityJoinRequestTable)
        .set({ status: approve ? "approved" : "rejected", decided_by_user_id: current.userID, time_updated: now })
        .where(eq(IdentityJoinRequestTable.id, requestID))
        .run()
        .pipe(Effect.orDie)
      if (approve && row) {
        yield* db
          .insert(IdentityMembershipTable)
          .values({ organization_id: found.organizationID, user_id: row.userID, time_created: now, time_updated: now })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
        yield* db
          .update(IdentitySessionTable)
          .set({ organization_id: found.organizationID, time_updated: now })
          .where(and(eq(IdentitySessionTable.user_id, row.userID), isNull(IdentitySessionTable.organization_id)))
          .run()
          .pipe(Effect.orDie)
      }
      return { ...found, status: approve ? ("approved" as const) : ("rejected" as const) }
    }),
    addMember: Effect.fn("Identity.addMember")(function* (sessionID, organizationID, employeeID) {
      yield* requireOrganizationAdmin(sessionID, organizationID)
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
      const current = yield* requireOrganizationAdmin(sessionID, organizationID)
      const normalized = normalizeEmployeeID(employeeID)
      if (!normalized) return yield* new Rejected({ reason: "invalid" })
      const existing = yield* organization(organizationID)
      if (!existing) return yield* new Rejected({ reason: "invalid" })
      // Only a platform admin can remove another admin of the organization.
      if (!current.admin && existing.admins.includes(normalized)) return yield* new Rejected({ reason: "forbidden" })
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
        .values({ session_id: sessionID, user_id: userID, created_by_user_id: userID, time_created: now, time_updated: now })
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
    projectAccess: Effect.fn("Identity.projectAccess")(function* (projectID) {
      const row = yield* db
        .select({
          organizationID: ProjectTable.organization_id,
          creatorUserID: ProjectTable.created_by_user_id,
          visibility: ProjectTable.visibility,
        })
        .from(ProjectTable)
        .where(eq(ProjectTable.id, projectID))
        .get()
        .pipe(Effect.orDie)
      if (!row) return undefined
      return {
        organizationID: row.organizationID ?? undefined,
        creatorUserID: row.creatorUserID ?? undefined,
        visibility: row.visibility,
      }
    }),
    setProjectVisibility: Effect.fn("Identity.setProjectVisibility")(function* (projectID, visibility) {
      yield* db
        .update(ProjectTable)
        .set({ visibility, time_updated: Date.now() })
        .where(eq(ProjectTable.id, projectID))
        .run()
        .pipe(Effect.orDie)
    }),
    sessionAccess: Effect.fn("Identity.sessionAccess")(function* (sessionID) {
      let current: SessionSchema.ID | null = sessionID
      // A subagent's session is as private as the session that spawned it.
      for (let depth = 0; current && depth < 8; depth++) {
        const row = yield* db
          .select({
            creator: SessionUserTable.created_by_user_id,
            user: SessionUserTable.user_id,
            visibility: SessionUserTable.visibility,
          })
          .from(SessionUserTable)
          .where(eq(SessionUserTable.session_id, current))
          .get()
          .pipe(Effect.orDie)
        // Older rows only know the latest prompter, which is the best available owner.
        if (row) return { creatorUserID: row.creator ?? row.user, visibility: row.visibility }
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
    setSessionVisibility: Effect.fn("Identity.setSessionVisibility")(function* (sessionID, visibility) {
      yield* db
        .update(SessionUserTable)
        .set({ visibility, time_updated: Date.now() })
        .where(eq(SessionUserTable.session_id, sessionID))
        .run()
        .pipe(Effect.orDie)
    }),
    preferences: Effect.fn("Identity.preferences")(function* (sessionID) {
      const where = yield* preferenceOwner(sessionID)
      const rows = yield* db
        .select()
        .from(IdentityPreferenceTable)
        .where(
          and(
            eq(IdentityPreferenceTable.user_id, where.userID),
            inArray(IdentityPreferenceTable.organization_id, ["", where.organizationID ?? ""]),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      const pick = (organizationID: string) =>
        Object.fromEntries(rows.filter((row) => row.organization_id === organizationID).map((row) => [row.key, row.value]))
      return { user: pick(""), organization: where.organizationID ? pick(where.organizationID) : {} }
    }),
    setPreference: Effect.fn("Identity.setPreference")(function* (sessionID, scope, key, value) {
      if (!validPreferenceKey(key) || Buffer.byteLength(value) > PREFERENCE_MAX_BYTES)
        return yield* new Rejected({ reason: "invalid" })
      const where = yield* preferenceOwner(sessionID)
      const organizationID = scope === "user" ? "" : where.organizationID
      if (organizationID === undefined) return yield* new Rejected({ reason: "invalid" })
      const now = Date.now()
      yield* db
        .insert(IdentityPreferenceTable)
        .values({ user_id: where.userID, organization_id: organizationID, key, value, time_created: now, time_updated: now })
        .onConflictDoUpdate({
          target: [IdentityPreferenceTable.user_id, IdentityPreferenceTable.organization_id, IdentityPreferenceTable.key],
          set: { value, time_updated: now },
        })
        .run()
        .pipe(Effect.orDie)
    }),
    removePreference: Effect.fn("Identity.removePreference")(function* (sessionID, scope, key) {
      const where = yield* preferenceOwner(sessionID)
      const organizationID = scope === "user" ? "" : where.organizationID
      if (organizationID === undefined) return yield* new Rejected({ reason: "invalid" })
      yield* db
        .delete(IdentityPreferenceTable)
        .where(
          and(
            eq(IdentityPreferenceTable.user_id, where.userID),
            eq(IdentityPreferenceTable.organization_id, organizationID),
            eq(IdentityPreferenceTable.key, key),
          ),
        )
        .run()
        .pipe(Effect.orDie)
    }),
    employeeIDs: Effect.fn("Identity.employeeIDs")(function* (userIDs) {
      if (userIDs.length === 0) return new Map<string, string>()
      const rows = yield* db
        .select({ id: IdentityUserTable.id, employeeID: IdentityUserTable.employee_id })
        .from(IdentityUserTable)
        .where(inArray(IdentityUserTable.id, [...userIDs]))
        .all()
        .pipe(Effect.orDie)
      return new Map(rows.map((row) => [row.id, row.employeeID]))
    }),
    organizationDirectory,
    organizationSharedDirectory,
    organizationRoot,
    organizationPath,
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
    const local = make(db, yield* Global.Service)
    // With a shared Postgres, accounts and organizations live there so every execution layer sees the same ones; what
    // belongs to this process's projects and sessions stays in its own database.
    const url = process.env.OPENCODE_IDENTITY_POSTGRES_URL
    const connection = url ? yield* sharedIdentity(url) : undefined
    const shared = connection?.store
    const identity = shared ? withSharedIdentity(local, shared) : local
    // Changes to the global config reach every organization on this layer; keys an organization edited stay as they are.
    const global = yield* Global.Service
    yield* Effect.gen(function* () {
      let signature = yield* Effect.promise(() => globalConfigSignature(global.config, global.data))
      yield* Effect.gen(function* () {
        const next = yield* Effect.promise(() => globalConfigSignature(global.config, global.data))
        if (next === signature) return
        signature = next
        const roots = yield* Effect.promise(() => organizationRoots(global.data))
        yield* Effect.forEach(roots, (root) =>
          Effect.promise(async () =>
            syncOrganizationConfig(
              global.config,
              root,
              await GlobalPackage.readHidden(global.config, global.data, path.basename(root)),
            ),
          ),
          {
          discard: true,
        })
      }).pipe(
        Effect.catchCause((cause) => Effect.logWarning("failed to sync organization config", { cause })),
        Effect.repeat(Schedule.spaced("5 seconds")),
      )
    }).pipe(Effect.forkScoped)
    // Users deleted through another execution layer leave their mirrored row here; clear it so nothing keeps pointing
    // at an account that no longer exists.
    if (shared)
      yield* local.prune(shared.existing).pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.forkScoped)
    // Sessions and messages are copied to the shared Postgres for analysis; OPENCODE_SESSION_SYNC_INTERVAL (seconds)
    // sets how often, and 0 turns the copy off for this layer.
    const interval = Number(process.env.OPENCODE_SESSION_SYNC_INTERVAL ?? 60)
    if (connection && interval > 0) {
      const { SessionSync } = yield* Effect.promise(() => import("./session-sync.js"))
      const runtimeID = process.env.OPENCODE_ADVERTISE_URL ?? "local"
      const round = SessionSync.run({ db, sql: connection.sql, runtimeID }).pipe(
        Effect.timeout(Duration.seconds(Math.max(interval, 30))),
        // A failed round changes nothing here; the cursor did not move, so the next round sends the same rows again.
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to copy sessions to Postgres", { cause }).pipe(Effect.as({ more: false })),
        ),
      )
      // A backlog is worked off in short rounds a second apart; only a caught-up layer waits the full interval.
      yield* round.pipe(
        Effect.flatMap((result) => Effect.sleep(result.more ? Duration.seconds(1) : Duration.seconds(interval))),
        Effect.forever,
        Effect.forkScoped,
      )
    }
    const employeeID = process.env.OPENCODE_ADMIN_EMPLOYEE_ID
    const password = process.env.OPENCODE_ADMIN_PASSWORD
    if (employeeID && password) yield* identity.ensureAdmin({ employeeID, password })
    return identity
  }),
)

function withSharedIdentity(local: Interface, shared: Store): Interface {
  const { find, ...methods } = shared
  return {
    ...local,
    ...methods,
    deleteOrganization: Effect.fn("Identity.deleteOrganization")(function* (sessionID, organizationID) {
      yield* shared.deleteOrganization(sessionID, organizationID)
      yield* local.dropOrganization(organizationID)
    }),
    mirror: Effect.fn("Identity.mirror")(function* (input) {
      // Only organizations that exist in the shared store are mirrored; a made-up ID must still look missing.
      const named = input.organizationID ? yield* find(input.organizationID) : undefined
      yield* local.mirror({ ...input, organizations: named ? [...input.organizations, named] : input.organizations })
    }),
  }
}

const sharedIdentity = Effect.fnUntraced(function* (url: string) {
  const { Postgres } = yield* Effect.promise(() => import("@opencode/util/postgres"))
  const { make: makeShared, migrations } = yield* Effect.promise(() => import("./identity/postgres.js"))
  const sql = Postgres.connect(url)
  yield* Effect.addFinalizer(() => Effect.promise(() => sql.close()))
  yield* Effect.promise(() => Postgres.migrate(sql, migrations))
  return { store: makeShared(sql), sql }
})

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, Global.node],
})


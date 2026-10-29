import { randomBytes } from "node:crypto"
import type { SQL } from "bun"
import { Effect } from "effect"
import { Postgres } from "@opencode/util/postgres"
import type { Account, Interface, OrganizationRecord } from "../identity.js"
import {
  DEFAULT_SETTINGS_PAGES,
  Rejected,
  SESSION_TTL_MS,
  SETTINGS_PAGES,
  PREFERENCE_MAX_BYTES,
  hashPassword,
  identifier,
  normalizeEmployeeID,
  tokenHash,
  validPassword,
  validPreferenceKey,
  verifyPassword,
} from "./shared.js"

/** Identity data every execution layer shares: accounts, sessions, organizations and who belongs to them. */
export type Shared = Pick<
  Interface,
  | "ensureAdmin"
  | "register"
  | "login"
  | "logout"
  | "authenticate"
  | "account"
  | "switchOrganization"
  | "createOrganization"
  | "listUsers"
  | "createUser"
  | "deleteUser"
  | "setAdmin"
  | "listOrganizations"
  | "canManageOrganization"
  | "setMemberRole"
  | "renameOrganization"
  | "deleteOrganization"
  | "resetPassword"
  | "setSettingsPages"
  | "addMember"
  | "removeMember"
  | "preferences"
  | "setPreference"
  | "removePreference"
  | "employeeIDs"
>

export type Store = Shared & {
  /** An organization by ID, if it exists in the shared store. */
  readonly find: (organizationID: string) => Effect.Effect<{ readonly id: string; readonly name: string } | undefined>
  /** Which of these user IDs still exist in the shared store. */
  readonly existing: (userIDs: readonly string[]) => Effect.Effect<Set<string>>
}

export const migrations: ReadonlyArray<Postgres.Migration> = [
  {
    id: "identity_001",
    sql: `
      CREATE TABLE identity_user (
        id text PRIMARY KEY,
        employee_id text NOT NULL UNIQUE,
        password_hash text NOT NULL,
        admin boolean NOT NULL,
        time_created bigint NOT NULL,
        time_updated bigint NOT NULL
      );
      CREATE TABLE identity_organization (
        id text PRIMARY KEY,
        name text NOT NULL,
        settings_pages text,
        time_created bigint NOT NULL,
        time_updated bigint NOT NULL
      );
      CREATE TABLE identity_membership (
        organization_id text NOT NULL REFERENCES identity_organization (id) ON DELETE CASCADE,
        user_id text NOT NULL REFERENCES identity_user (id) ON DELETE CASCADE,
        role text NOT NULL DEFAULT 'member',
        time_created bigint NOT NULL,
        time_updated bigint NOT NULL,
        PRIMARY KEY (organization_id, user_id)
      );
      CREATE TABLE identity_session (
        id text PRIMARY KEY,
        token_hash text NOT NULL UNIQUE,
        user_id text NOT NULL REFERENCES identity_user (id) ON DELETE CASCADE,
        organization_id text REFERENCES identity_organization (id) ON DELETE SET NULL,
        expires_at bigint NOT NULL,
        time_created bigint NOT NULL,
        time_updated bigint NOT NULL
      );
    `,
  },
  {
    // Client state that follows an account to any browser. An empty organization_id is the user's own.
    id: "identity_002",
    sql: `
      CREATE TABLE identity_preference (
        user_id text NOT NULL REFERENCES identity_user (id) ON DELETE CASCADE,
        organization_id text NOT NULL,
        key text NOT NULL,
        value text NOT NULL,
        time_created bigint NOT NULL,
        time_updated bigint NOT NULL,
        PRIMARY KEY (user_id, organization_id, key)
      );
    `,
  },
]

type Row = Record<string, any>

export function make(sql: SQL): Store {
  const run = <A>(query: () => Promise<A>) => Effect.promise(query).pipe(Effect.orDie)
  const first = (rows: Row[]): Row | undefined => rows[0]

  const userByEmployee = (employeeID: string) =>
    run(async () => first(await sql`SELECT * FROM identity_user WHERE employee_id = ${employeeID}`))

  const issue = (userID: string) =>
    run(async () => {
      const token = randomBytes(32).toString("base64url")
      const now = Date.now()
      await sql`
        INSERT INTO identity_session (id, token_hash, user_id, expires_at, time_created, time_updated)
        VALUES (${identifier("ses")}, ${tokenHash(token)}, ${userID}, ${now + SESSION_TTL_MS}, ${now}, ${now})`
      return { token }
    })

  const account = Effect.fn("Identity.postgres.account")(function* (sessionID: string) {
    return yield* run(async (): Promise<Account | undefined> => {
      const session = first(await sql`SELECT * FROM identity_session WHERE id = ${sessionID}`)
      if (!session || Number(session.expires_at) <= Date.now()) return
      const user = first(await sql`SELECT * FROM identity_user WHERE id = ${session.user_id}`)
      if (!user) return
      const organizations: Array<{ id: string; name: string }> = (
        await sql`
          SELECT o.id, o.name FROM identity_membership m
          JOIN identity_organization o ON o.id = m.organization_id
          WHERE m.user_id = ${user.id} ORDER BY m.time_created, o.id`
      ).map((row: Row) => ({ id: row.id, name: row.name }))
      const current = organizations.some((item) => item.id === session.organization_id)
        ? (session.organization_id as string)
        : organizations[0]?.id
      if (current !== (session.organization_id ?? undefined))
        await sql`UPDATE identity_session SET organization_id = ${current ?? null}, time_updated = ${Date.now()} WHERE id = ${session.id}`
      const role = current
        ? first(await sql`SELECT role FROM identity_membership WHERE organization_id = ${current} AND user_id = ${user.id}`)
        : undefined
      const organizationAdmin = user.admin || role?.role === "admin"
      const configured = current
        ? first(await sql`SELECT settings_pages FROM identity_organization WHERE id = ${current}`)
        : undefined
      return {
        sessionID: session.id,
        userID: user.id,
        employeeID: user.employee_id,
        admin: user.admin,
        organizationID: current,
        organizationAdmin,
        settingsPages: organizationAdmin
          ? SETTINGS_PAGES
          : configured?.settings_pages
            ? (JSON.parse(configured.settings_pages) as string[])
            : DEFAULT_SETTINGS_PAGES,
        organizations,
      }
    })
  })

  /** The user and current organization a session signed in as; preferences belong to them. */
  const preferenceOwner = Effect.fn("Identity.postgres.preferenceOwner")(function* (sessionID: string) {
    const found = yield* account(sessionID)
    if (!found) return yield* new Rejected({ reason: "credentials" })
    return { userID: found.userID, organizationID: found.organizationID }
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
      const membership = yield* run(async () =>
        first(await sql`SELECT role FROM identity_membership WHERE organization_id = ${organizationID} AND user_id = ${current.userID}`),
      )
      if (membership?.role !== "admin") return yield* new Rejected({ reason: "forbidden" })
      return current
    })

  const organization = (organizationID: string) =>
    run(async (): Promise<OrganizationRecord | undefined> => {
      const row = first(await sql`SELECT * FROM identity_organization WHERE id = ${organizationID}`)
      if (!row) return
      const members: Row[] = await sql`
        SELECT u.employee_id, m.role FROM identity_membership m
        JOIN identity_user u ON u.id = m.user_id
        WHERE m.organization_id = ${organizationID} ORDER BY u.employee_id`
      return {
        id: row.id,
        name: row.name,
        members: members.map((item) => item.employee_id),
        admins: members.filter((item) => item.role === "admin").map((item) => item.employee_id),
        settingsPages: row.settings_pages ? (JSON.parse(row.settings_pages) as string[]) : DEFAULT_SETTINGS_PAGES,
      }
    })

  const detail = (organizationID: string) =>
    Effect.gen(function* () {
      const found = yield* organization(organizationID)
      if (!found) return yield* new Rejected({ reason: "invalid" })
      return found
    })

  const targetUser = (employeeID: string) =>
    Effect.gen(function* () {
      const normalized = normalizeEmployeeID(employeeID)
      const user = normalized ? yield* userByEmployee(normalized) : undefined
      if (!user) return yield* new Rejected({ reason: "missing" })
      return user
    })

  return {
    existing: (userIDs) =>
      run(async () => {
        if (userIDs.length === 0) return new Set<string>()
        const rows = await sql`SELECT id FROM identity_user WHERE id IN ${sql(userIDs)}`
        return new Set<string>(rows.map((row: Row) => row.id as string))
      }),
    find: (organizationID) =>
      run(async () => {
        const row = first(await sql`SELECT id, name FROM identity_organization WHERE id = ${organizationID}`)
        return row ? { id: row.id as string, name: row.name as string } : undefined
      }),
    ensureAdmin: Effect.fn("Identity.postgres.ensureAdmin")(function* (input) {
      const existingAdmin = yield* run(async () => first(await sql`SELECT id FROM identity_user WHERE admin = true LIMIT 1`))
      if (existingAdmin) return
      const employeeID = normalizeEmployeeID(input.employeeID)
      if (!employeeID || !validPassword(input.password)) {
        yield* Effect.logWarning("platform admin bootstrap skipped because the employee ID or password is invalid")
        return
      }
      if (yield* userByEmployee(employeeID)) {
        yield* Effect.logWarning("platform admin bootstrap skipped because that employee ID is already registered")
        return
      }
      const now = Date.now()
      const hash = yield* Effect.promise(() => hashPassword(input.password))
      // Several execution layers can start together; the unique employee ID lets exactly one create the admin.
      yield* run(
        () => sql`
          INSERT INTO identity_user (id, employee_id, password_hash, admin, time_created, time_updated)
          VALUES (${identifier("usr")}, ${employeeID}, ${hash}, true, ${now}, ${now})
          ON CONFLICT (employee_id) DO NOTHING`,
      )
      yield* Effect.logInfo("platform admin created", { employeeID })
    }),
    register: Effect.fn("Identity.postgres.register")(function* (input) {
      const employeeID = normalizeEmployeeID(input.employeeID)
      if (!employeeID || !validPassword(input.password)) return yield* new Rejected({ reason: "invalid" })
      if (yield* userByEmployee(employeeID)) return yield* new Rejected({ reason: "taken" })
      const now = Date.now()
      const userID = identifier("usr")
      const hash = yield* Effect.promise(() => hashPassword(input.password))
      yield* run(
        () => sql`
          INSERT INTO identity_user (id, employee_id, password_hash, admin, time_created, time_updated)
          VALUES (${userID}, ${employeeID}, ${hash}, false, ${now}, ${now})`,
      )
      return yield* issue(userID)
    }),
    login: Effect.fn("Identity.postgres.login")(function* (input) {
      const employeeID = normalizeEmployeeID(input.employeeID)
      if (!employeeID || !input.password) return
      const user = yield* userByEmployee(employeeID)
      if (!user) return
      if (!(yield* Effect.promise(() => verifyPassword(input.password, user.password_hash)))) return
      return yield* issue(user.id)
    }),
    logout: (sessionID) => run(() => sql`DELETE FROM identity_session WHERE id = ${sessionID}`).pipe(Effect.asVoid),
    authenticate: Effect.fn("Identity.postgres.authenticate")(function* (token) {
      const session = yield* run(async () => first(await sql`SELECT id, expires_at FROM identity_session WHERE token_hash = ${tokenHash(token)}`))
      if (!session) return
      if (Number(session.expires_at) <= Date.now()) {
        yield* run(() => sql`DELETE FROM identity_session WHERE id = ${session.id}`)
        return
      }
      return yield* account(session.id)
    }),
    account,
    switchOrganization: Effect.fn("Identity.postgres.switchOrganization")(function* (sessionID, organizationID) {
      const current = yield* account(sessionID)
      if (!current) return yield* new Rejected({ reason: "credentials" })
      if (!current.organizations.some((item) => item.id === organizationID))
        return yield* new Rejected({ reason: "invalid" })
      yield* run(
        () => sql`UPDATE identity_session SET organization_id = ${organizationID}, time_updated = ${Date.now()} WHERE id = ${sessionID}`,
      )
      const next = yield* account(sessionID)
      if (!next) return yield* new Rejected({ reason: "credentials" })
      return next
    }),
    createOrganization: Effect.fn("Identity.postgres.createOrganization")(function* (sessionID, name) {
      yield* requireAdmin(sessionID)
      const trimmed = name.trim()
      if (!trimmed || trimmed.length > 80) return yield* new Rejected({ reason: "invalid" })
      const organizationID = identifier("org")
      const now = Date.now()
      yield* run(
        () => sql`
          INSERT INTO identity_organization (id, name, time_created, time_updated)
          VALUES (${organizationID}, ${trimmed}, ${now}, ${now})`,
      )
      // Its directory is made by the layer the organization is pinned to, on first use; this layer may not be that one.
      return yield* detail(organizationID)
    }),
    listUsers: Effect.fn("Identity.postgres.listUsers")(function* (sessionID) {
      yield* requireAdmin(sessionID)
      const rows: Row[] = yield* run(() => sql`SELECT employee_id, admin FROM identity_user ORDER BY employee_id`)
      return rows.map((row) => ({ employeeID: row.employee_id as string, admin: row.admin as boolean }))
    }),
    createUser: Effect.fn("Identity.postgres.createUser")(function* (sessionID, input) {
      yield* requireAdmin(sessionID)
      const employeeID = normalizeEmployeeID(input.employeeID)
      if (!employeeID || !validPassword(input.password)) return yield* new Rejected({ reason: "invalid" })
      if (yield* userByEmployee(employeeID)) return yield* new Rejected({ reason: "taken" })
      if (input.organizationID && !(yield* organization(input.organizationID)))
        return yield* new Rejected({ reason: "invalid" })
      const now = Date.now()
      const userID = identifier("usr")
      const admin = input.admin === true
      const hash = yield* Effect.promise(() => hashPassword(input.password))
      yield* run(() =>
        sql.begin(async (tx) => {
          await tx`
            INSERT INTO identity_user (id, employee_id, password_hash, admin, time_created, time_updated)
            VALUES (${userID}, ${employeeID}, ${hash}, ${admin}, ${now}, ${now})`
          if (input.organizationID)
            await tx`
              INSERT INTO identity_membership (organization_id, user_id, time_created, time_updated)
              VALUES (${input.organizationID}, ${userID}, ${now}, ${now})`
        }),
      )
      return { employeeID, admin }
    }),
    deleteUser: Effect.fn("Identity.postgres.deleteUser")(function* (sessionID, employeeID) {
      const current = yield* requireAdmin(sessionID)
      const user = yield* targetUser(employeeID)
      if (user.id === current.userID) return yield* new Rejected({ reason: "self" })
      yield* run(() => sql`DELETE FROM identity_user WHERE id = ${user.id}`)
    }),
    setAdmin: Effect.fn("Identity.postgres.setAdmin")(function* (sessionID, employeeID, admin) {
      const current = yield* requireAdmin(sessionID)
      const user = yield* targetUser(employeeID)
      if (user.id === current.userID) return yield* new Rejected({ reason: "self" })
      yield* run(() => sql`UPDATE identity_user SET admin = ${admin}, time_updated = ${Date.now()} WHERE id = ${user.id}`)
      return { employeeID: user.employee_id as string, admin }
    }),
    listOrganizations: Effect.fn("Identity.postgres.listOrganizations")(function* (sessionID) {
      const current = yield* requireSession(sessionID)
      const rows: Row[] = yield* run(() =>
        current.admin
          ? sql`SELECT id FROM identity_organization ORDER BY time_created, id`
          : sql`
              SELECT id FROM identity_organization
              WHERE id IN (SELECT organization_id FROM identity_membership WHERE user_id = ${current.userID} AND role = 'admin')
              ORDER BY time_created, id`,
      )
      const listed = yield* Effect.forEach(rows, (row) => organization(row.id))
      return listed.filter((item) => item !== undefined)
    }),
    canManageOrganization: (sessionID, organizationID) =>
      requireOrganizationAdmin(sessionID, organizationID).pipe(
        Effect.as(true),
        Effect.catchIf((error) => error.reason === "forbidden", () => Effect.succeed(false)),
      ),
    setMemberRole: Effect.fn("Identity.postgres.setMemberRole")(function* (sessionID, organizationID, employeeID, role) {
      yield* requireAdmin(sessionID)
      const user = yield* targetUser(employeeID)
      const updated = yield* run(
        async () =>
          first(
            await sql`
              UPDATE identity_membership SET role = ${role}, time_updated = ${Date.now()}
              WHERE organization_id = ${organizationID} AND user_id = ${user.id} RETURNING user_id`,
          ),
      )
      if (!updated) return yield* new Rejected({ reason: "invalid" })
      return yield* detail(organizationID)
    }),
    deleteOrganization: Effect.fn("Identity.postgres.deleteOrganization")(function* (sessionID, organizationID) {
      yield* requireAdmin(sessionID)
      const deleted = yield* run(
        async () => first(await sql`DELETE FROM identity_organization WHERE id = ${organizationID} RETURNING id`),
      )
      if (!deleted) return yield* new Rejected({ reason: "missing" })
      yield* run(() => sql`DELETE FROM identity_preference WHERE organization_id = ${organizationID}`)
    }),
    renameOrganization: Effect.fn("Identity.postgres.renameOrganization")(function* (sessionID, organizationID, name) {
      yield* requireAdmin(sessionID)
      const trimmed = name.trim()
      if (!trimmed || trimmed.length > 80) return yield* new Rejected({ reason: "invalid" })
      const updated = yield* run(
        async () =>
          first(
            await sql`UPDATE identity_organization SET name = ${trimmed}, time_updated = ${Date.now()} WHERE id = ${organizationID} RETURNING id`,
          ),
      )
      if (!updated) return yield* new Rejected({ reason: "invalid" })
      return yield* detail(organizationID)
    }),
    resetPassword: Effect.fn("Identity.postgres.resetPassword")(function* (sessionID, employeeID, password) {
      yield* requireAdmin(sessionID)
      const normalized = normalizeEmployeeID(employeeID)
      if (!normalized || !validPassword(password)) return yield* new Rejected({ reason: "invalid" })
      const user = yield* userByEmployee(normalized)
      if (!user) return yield* new Rejected({ reason: "missing" })
      const hash = yield* Effect.promise(() => hashPassword(password))
      yield* run(() => sql`UPDATE identity_user SET password_hash = ${hash}, time_updated = ${Date.now()} WHERE id = ${user.id}`)
      yield* run(() => sql`DELETE FROM identity_session WHERE user_id = ${user.id}`)
    }),
    setSettingsPages: Effect.fn("Identity.postgres.setSettingsPages")(function* (sessionID, organizationID, pages) {
      yield* requireOrganizationAdmin(sessionID, organizationID)
      const known = new Set<string>(SETTINGS_PAGES)
      const unique = SETTINGS_PAGES.filter((page) => pages.includes(page))
      if (unique.length === 0 || pages.some((page) => !known.has(page))) return yield* new Rejected({ reason: "invalid" })
      const updated = yield* run(
        async () =>
          first(
            await sql`
              UPDATE identity_organization SET settings_pages = ${JSON.stringify(unique)}, time_updated = ${Date.now()}
              WHERE id = ${organizationID} RETURNING id`,
          ),
      )
      if (!updated) return yield* new Rejected({ reason: "invalid" })
      return yield* detail(organizationID)
    }),
    addMember: Effect.fn("Identity.postgres.addMember")(function* (sessionID, organizationID, employeeID) {
      yield* requireOrganizationAdmin(sessionID, organizationID)
      const normalized = normalizeEmployeeID(employeeID)
      if (!normalized) return yield* new Rejected({ reason: "invalid" })
      const user = yield* userByEmployee(normalized)
      if (!user) return yield* new Rejected({ reason: "missing" })
      yield* detail(organizationID)
      const now = Date.now()
      yield* run(
        () => sql`
          INSERT INTO identity_membership (organization_id, user_id, time_created, time_updated)
          VALUES (${organizationID}, ${user.id}, ${now}, ${now}) ON CONFLICT DO NOTHING`,
      )
      yield* run(
        () => sql`
          UPDATE identity_session SET organization_id = ${organizationID}, time_updated = ${now}
          WHERE user_id = ${user.id} AND organization_id IS NULL`,
      )
      return yield* detail(organizationID)
    }),
    removeMember: Effect.fn("Identity.postgres.removeMember")(function* (sessionID, organizationID, employeeID) {
      const current = yield* requireOrganizationAdmin(sessionID, organizationID)
      const normalized = normalizeEmployeeID(employeeID)
      if (!normalized) return yield* new Rejected({ reason: "invalid" })
      const existing = yield* detail(organizationID)
      // Only a platform admin can remove another admin of the organization.
      if (!current.admin && existing.admins.includes(normalized)) return yield* new Rejected({ reason: "forbidden" })
      const user = yield* userByEmployee(normalized)
      if (user) {
        yield* run(() => sql`DELETE FROM identity_membership WHERE organization_id = ${organizationID} AND user_id = ${user.id}`)
        yield* run(
          () => sql`
            UPDATE identity_session SET organization_id = NULL, time_updated = ${Date.now()}
            WHERE user_id = ${user.id} AND organization_id = ${organizationID}`,
        )
      }
      return yield* detail(organizationID)
    }),
    preferences: Effect.fn("Identity.postgres.preferences")(function* (sessionID) {
      const owner = yield* preferenceOwner(sessionID)
      const rows: Row[] = yield* run(
        () => sql`
          SELECT organization_id, key, value FROM identity_preference
          WHERE user_id = ${owner.userID} AND organization_id IN ${sql(["", owner.organizationID ?? ""])}`,
      )
      const pick = (organizationID: string) =>
        Object.fromEntries(rows.filter((row) => row.organization_id === organizationID).map((row) => [row.key, row.value]))
      return { user: pick(""), organization: owner.organizationID ? pick(owner.organizationID) : {} }
    }),
    setPreference: Effect.fn("Identity.postgres.setPreference")(function* (sessionID, scope, key, value) {
      if (!validPreferenceKey(key) || Buffer.byteLength(value) > PREFERENCE_MAX_BYTES)
        return yield* new Rejected({ reason: "invalid" })
      const owner = yield* preferenceOwner(sessionID)
      const organizationID = scope === "user" ? "" : owner.organizationID
      if (organizationID === undefined) return yield* new Rejected({ reason: "invalid" })
      const now = Date.now()
      yield* run(
        () => sql`
          INSERT INTO identity_preference (user_id, organization_id, key, value, time_created, time_updated)
          VALUES (${owner.userID}, ${organizationID}, ${key}, ${value}, ${now}, ${now})
          ON CONFLICT (user_id, organization_id, key) DO UPDATE SET value = EXCLUDED.value, time_updated = EXCLUDED.time_updated`,
      )
    }),
    removePreference: Effect.fn("Identity.postgres.removePreference")(function* (sessionID, scope, key) {
      const owner = yield* preferenceOwner(sessionID)
      const organizationID = scope === "user" ? "" : owner.organizationID
      if (organizationID === undefined) return yield* new Rejected({ reason: "invalid" })
      yield* run(
        () => sql`
          DELETE FROM identity_preference
          WHERE user_id = ${owner.userID} AND organization_id = ${organizationID} AND key = ${key}`,
      )
    }),
    employeeIDs: Effect.fn("Identity.postgres.employeeIDs")(function* (userIDs) {
      if (userIDs.length === 0) return new Map<string, string>()
      const rows: Row[] = yield* run(() => sql`SELECT id, employee_id FROM identity_user WHERE id IN ${sql([...userIDs])}`)
      return new Map(rows.map((row) => [row.id as string, row.employee_id as string]))
    }),
  }
}

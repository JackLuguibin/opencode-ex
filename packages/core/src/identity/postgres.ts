import { randomBytes } from "node:crypto"
import type { SQL } from "bun"
import { Effect } from "effect"
import { Postgres } from "@opencode/util/postgres"
import type { Account, Interface, JoinRequest, OrganizationRecord } from "../identity.js"
import {
  DEFAULT_SETTINGS_PAGES,
  Rejected,
  SESSION_TTL_MS,
  SETTINGS_PAGES,
  PREFERENCE_MAX_BYTES,
  hashPassword,
  identifier,
  normalizeEmployeeID,
  normalizeName,
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
  | "setName"
  | "audit"
  | "auditLog"
  | "listOrganizations"
  | "canManageOrganization"
  | "setMemberRole"
  | "renameOrganization"
  | "deleteOrganization"
  | "resetPassword"
  | "setSettingsPages"
  | "setSessionSync"
  | "joinableOrganizations"
  | "requestJoin"
  | "myJoinRequests"
  | "pendingJoinRequests"
  | "decideJoinRequest"
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
  {
    // A member's display name; the employee ID stays their login.
    id: "identity_003",
    sql: `ALTER TABLE identity_user ADD COLUMN name text;`,
  },
  {
    // A member's request to join an organization, decided by its admins or a platform admin.
    id: "identity_004",
    sql: `
      CREATE TABLE identity_join_request (
        id text PRIMARY KEY,
        user_id text NOT NULL REFERENCES identity_user (id) ON DELETE CASCADE,
        organization_id text NOT NULL REFERENCES identity_organization (id) ON DELETE CASCADE,
        note text,
        status text NOT NULL,
        decided_by_user_id text,
        time_created bigint NOT NULL,
        time_updated bigint NOT NULL
      );
    `,
  },
  {
    // Administrative actions. No foreign keys: the log outlives the users and organizations it names.
    id: "identity_005",
    sql: `
      CREATE TABLE identity_audit (
        id text PRIMARY KEY,
        actor text NOT NULL,
        action text NOT NULL,
        target text,
        detail text,
        time_created bigint NOT NULL
      );
      CREATE INDEX identity_audit_time ON identity_audit (time_created DESC);
    `,
  },
  {
    // Copies of each execution layer's sessions and messages, kept for analysis. They name an organization but have no
    // foreign key: the copy outlives the session, the user and the organization it came from.
    id: "identity_006",
    sql: `
      CREATE TABLE session_sync_session (
        session_id text PRIMARY KEY,
        organization_id text,
        runtime_id text NOT NULL,
        project_id text NOT NULL,
        parent_id text,
        title text,
        directory text,
        agent text,
        model jsonb,
        cost double precision NOT NULL,
        tokens_input bigint NOT NULL,
        tokens_output bigint NOT NULL,
        tokens_reasoning bigint NOT NULL,
        tokens_cache_read bigint NOT NULL,
        tokens_cache_write bigint NOT NULL,
        created_by_user_id text,
        holder_user_id text,
        visibility text,
        time_created bigint NOT NULL,
        time_updated bigint NOT NULL,
        time_archived bigint,
        time_synced bigint NOT NULL
      );
      CREATE INDEX session_sync_session_org ON session_sync_session (organization_id, time_updated DESC);
      CREATE TABLE session_sync_message (
        session_id text NOT NULL,
        seq integer NOT NULL,
        id text NOT NULL,
        organization_id text,
        runtime_id text NOT NULL,
        type text NOT NULL,
        data jsonb NOT NULL,
        time_created bigint NOT NULL,
        time_updated bigint NOT NULL,
        time_synced bigint NOT NULL,
        PRIMARY KEY (session_id, seq)
      );
      CREATE INDEX session_sync_message_org ON session_sync_message (organization_id, type, time_created);
    `,
  },
  {
    // An organization can keep its sessions out of the copies above.
    id: "identity_007",
    sql: `ALTER TABLE identity_organization ADD COLUMN session_sync boolean NOT NULL DEFAULT true;`,
  },
  {
    // Projects live in each layer's own database and two layers can hold the same project ID, so a project is keyed by
    // the layer too. Messages carry their project so they can be grouped without going through the session.
    id: "identity_008",
    sql: `
      CREATE TABLE session_sync_project (
        runtime_id text NOT NULL,
        project_id text NOT NULL,
        organization_id text,
        name text,
        worktree text NOT NULL,
        vcs text,
        created_by_user_id text,
        visibility text,
        time_created bigint NOT NULL,
        time_updated bigint NOT NULL,
        time_archived bigint,
        time_synced bigint NOT NULL,
        PRIMARY KEY (runtime_id, project_id)
      );
      CREATE INDEX session_sync_project_org ON session_sync_project (organization_id, time_updated DESC);
      ALTER TABLE session_sync_message ADD COLUMN project_id text;
      UPDATE session_sync_message m SET project_id = s.project_id FROM session_sync_session s WHERE s.session_id = m.session_id;
      CREATE INDEX session_sync_message_project ON session_sync_message (runtime_id, project_id, time_created);
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

  // A page opens with a burst of requests and each can end up here, so an account is read in two round trips: the
  // session with its user, then every organization the user belongs to with their role and its settings.
  const loadAccount = async (session: Row | undefined): Promise<Account | undefined> => {
    if (!session || Number(session.expires_at) <= Date.now()) return
    const memberships: Row[] = await sql`
      SELECT o.id, o.name, o.settings_pages, m.role FROM identity_membership m
      JOIN identity_organization o ON o.id = m.organization_id
      WHERE m.user_id = ${session.user_id} ORDER BY m.time_created, o.id`
    const organizations = memberships.map((row) => ({ id: row.id as string, name: row.name as string }))
    const current = organizations.some((item) => item.id === session.organization_id)
      ? (session.organization_id as string)
      : organizations[0]?.id
    if (current !== (session.organization_id ?? undefined))
      await sql`UPDATE identity_session SET organization_id = ${current ?? null}, time_updated = ${Date.now()} WHERE id = ${session.id}`
    const membership = memberships.find((row) => row.id === current)
    const organizationAdmin = session.admin || membership?.role === "admin"
    return {
      sessionID: session.id,
      userID: session.user_id,
      employeeID: session.employee_id,
      name: (session.name as string | null) ?? undefined,
      admin: session.admin,
      organizationID: current,
      organizationAdmin,
      settingsPages: organizationAdmin
        ? SETTINGS_PAGES
        : membership?.settings_pages
          ? (JSON.parse(membership.settings_pages) as string[])
          : DEFAULT_SETTINGS_PAGES,
      organizations,
    }
  }

  const account = Effect.fn("Identity.postgres.account")(function* (sessionID: string) {
    return yield* run(async () =>
      loadAccount(
        first(await sql`
          SELECT s.id, s.user_id, s.organization_id, s.expires_at, u.employee_id, u.name, u.admin
          FROM identity_session s JOIN identity_user u ON u.id = s.user_id WHERE s.id = ${sessionID}`),
      ),
    )
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

  const joinRequests = (filter: { readonly id?: string; readonly userID?: string; readonly pending?: boolean }) =>
    run(async (): Promise<ReadonlyArray<JoinRequest>> => {
      const id = filter.id ?? null
      const userID = filter.userID ?? null
      const rows: Row[] = await sql`
        SELECT r.id, r.organization_id, o.name AS organization_name, u.employee_id, u.name, r.note, r.status, r.time_created
        FROM identity_join_request r
        JOIN identity_organization o ON o.id = r.organization_id
        JOIN identity_user u ON u.id = r.user_id
        WHERE (${id}::text IS NULL OR r.id = ${id})
          AND (${userID}::text IS NULL OR r.user_id = ${userID})
          AND (${filter.pending === true} = false OR r.status = 'pending')
        ORDER BY r.time_created DESC`
      return rows.map((row) => ({
        id: row.id,
        organizationID: row.organization_id,
        organizationName: row.organization_name,
        employeeID: row.employee_id,
        name: (row.name as string | null) ?? undefined,
        note: (row.note as string | null) ?? undefined,
        status: row.status,
        time: Number(row.time_created),
      }))
    })

  const organization = (organizationID: string) =>
    run(async (): Promise<OrganizationRecord | undefined> => {
      const row = first(await sql`SELECT * FROM identity_organization WHERE id = ${organizationID}`)
      if (!row) return
      const members: Row[] = await sql`
        SELECT u.employee_id, u.name, m.role FROM identity_membership m
        JOIN identity_user u ON u.id = m.user_id
        WHERE m.organization_id = ${organizationID} ORDER BY u.employee_id`
      return {
        id: row.id,
        name: row.name,
        members: members.map((item) => item.employee_id),
        names: Object.fromEntries(members.flatMap((item) => (item.name ? [[item.employee_id, item.name as string]] : []))),
        admins: members.filter((item) => item.role === "admin").map((item) => item.employee_id),
        settingsPages: row.settings_pages ? (JSON.parse(row.settings_pages) as string[]) : DEFAULT_SETTINGS_PAGES,
        sessionSync: row.session_sync as boolean,
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
      return yield* run(async () => {
        const session = first(await sql`
          SELECT s.id, s.user_id, s.organization_id, s.expires_at, u.employee_id, u.name, u.admin
          FROM identity_session s JOIN identity_user u ON u.id = s.user_id WHERE s.token_hash = ${tokenHash(token)}`)
        if (session && Number(session.expires_at) <= Date.now()) {
          await sql`DELETE FROM identity_session WHERE id = ${session.id}`
          return
        }
        return loadAccount(session)
      })
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
      const rows: Row[] = yield* run(() => sql`SELECT employee_id, name, admin FROM identity_user ORDER BY employee_id`)
      return rows.map((row) => ({
        employeeID: row.employee_id as string,
        name: (row.name as string | null) ?? undefined,
        admin: row.admin as boolean,
      }))
    }),
    createUser: Effect.fn("Identity.postgres.createUser")(function* (sessionID, input) {
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
      const hash = yield* Effect.promise(() => hashPassword(input.password))
      yield* run(() =>
        sql.begin(async (tx) => {
          await tx`
            INSERT INTO identity_user (id, employee_id, name, password_hash, admin, time_created, time_updated)
            VALUES (${userID}, ${employeeID}, ${name}, ${hash}, ${admin}, ${now}, ${now})`
          if (input.organizationID)
            await tx`
              INSERT INTO identity_membership (organization_id, user_id, time_created, time_updated)
              VALUES (${input.organizationID}, ${userID}, ${now}, ${now})`
        }),
      )
      return { employeeID, name: name ?? undefined, admin }
    }),
    deleteUser: Effect.fn("Identity.postgres.deleteUser")(function* (sessionID, employeeID) {
      const current = yield* requireAdmin(sessionID)
      const user = yield* targetUser(employeeID)
      if (user.id === current.userID) return yield* new Rejected({ reason: "self" })
      yield* run(() => sql`DELETE FROM identity_user WHERE id = ${user.id}`)
    }),
    audit: Effect.fn("Identity.postgres.audit")(function* (entry) {
      yield* Effect.promise(
        () =>
          sql`INSERT INTO identity_audit (id, actor, action, target, detail, time_created)
              VALUES (${identifier("aud")}, ${entry.actor}, ${entry.action}, ${entry.target ?? null}, ${entry.detail?.slice(0, 500) ?? null}, ${Date.now()})`,
      ).pipe(Effect.ignore)
    }),
    auditLog: Effect.fn("Identity.postgres.auditLog")(function* (sessionID, limit) {
      yield* requireAdmin(sessionID)
      const rows: Row[] = yield* run(
        () => sql`SELECT * FROM identity_audit ORDER BY time_created DESC LIMIT ${Math.min(Math.max(limit, 1), 500)}`,
      )
      return rows.map((row) => ({
        id: row.id as string,
        actor: row.actor as string,
        action: row.action as string,
        target: (row.target as string | null) ?? undefined,
        detail: (row.detail as string | null) ?? undefined,
        time: Number(row.time_created),
      }))
    }),
    setName: Effect.fn("Identity.postgres.setName")(function* (sessionID, employeeID, input) {
      const current = yield* requireSession(sessionID)
      const name = normalizeName(input)
      if (name === undefined) return yield* new Rejected({ reason: "invalid" })
      const user = yield* targetUser(employeeID)
      if (!current.admin) return yield* new Rejected({ reason: "forbidden" })
      yield* run(() => sql`UPDATE identity_user SET name = ${name}, time_updated = ${Date.now()} WHERE id = ${user.id}`)
      return { employeeID: user.employee_id as string, name: name ?? undefined, admin: user.admin as boolean }
    }),
    setAdmin: Effect.fn("Identity.postgres.setAdmin")(function* (sessionID, employeeID, admin) {
      const current = yield* requireAdmin(sessionID)
      const user = yield* targetUser(employeeID)
      if (user.id === current.userID) return yield* new Rejected({ reason: "self" })
      yield* run(() => sql`UPDATE identity_user SET admin = ${admin}, time_updated = ${Date.now()} WHERE id = ${user.id}`)
      return { employeeID: user.employee_id as string, name: (user.name as string | null) ?? undefined, admin }
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
      // The copies of its sessions go with it; they are kept for analysis of organizations that exist.
      yield* run(() => sql`DELETE FROM session_sync_message WHERE organization_id = ${organizationID}`)
      yield* run(() => sql`DELETE FROM session_sync_session WHERE organization_id = ${organizationID}`)
      yield* run(() => sql`DELETE FROM session_sync_project WHERE organization_id = ${organizationID}`)
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
    setSessionSync: Effect.fn("Identity.postgres.setSessionSync")(function* (sessionID, organizationID, enabled) {
      yield* requireOrganizationAdmin(sessionID, organizationID)
      const updated = yield* run(
        async () =>
          first(
            await sql`
              UPDATE identity_organization SET session_sync = ${enabled}, time_updated = ${Date.now()}
              WHERE id = ${organizationID} RETURNING id`,
          ),
      )
      if (!updated) return yield* new Rejected({ reason: "invalid" })
      return yield* detail(organizationID)
    }),
    joinableOrganizations: Effect.fn("Identity.postgres.joinableOrganizations")(function* (sessionID) {
      const current = yield* requireSession(sessionID)
      const joined = new Set(current.organizations.map((item) => item.id))
      const rows: Row[] = yield* run(() => sql`SELECT id, name FROM identity_organization ORDER BY name`)
      return rows.filter((row) => !joined.has(row.id)).map((row) => ({ id: row.id as string, name: row.name as string }))
    }),
    requestJoin: Effect.fn("Identity.postgres.requestJoin")(function* (sessionID, organizationID, note) {
      const current = yield* requireSession(sessionID)
      const target = yield* run(async () => first(await sql`SELECT id FROM identity_organization WHERE id = ${organizationID}`))
      if (!target || current.organizations.some((item) => item.id === organizationID))
        return yield* new Rejected({ reason: "invalid" })
      const open = yield* run(
        async () => first(await sql`
          SELECT id FROM identity_join_request
          WHERE user_id = ${current.userID} AND organization_id = ${organizationID} AND status = 'pending'`),
      )
      if (open) return yield* new Rejected({ reason: "taken" })
      const now = Date.now()
      const id = identifier("req")
      yield* run(
        () => sql`
          INSERT INTO identity_join_request (id, user_id, organization_id, note, status, time_created, time_updated)
          VALUES (${id}, ${current.userID}, ${organizationID}, ${note?.trim().slice(0, 500) || null}, 'pending', ${now}, ${now})`,
      )
      return (yield* joinRequests({ id }))[0]!
    }),
    myJoinRequests: Effect.fn("Identity.postgres.myJoinRequests")(function* (sessionID) {
      const current = yield* requireSession(sessionID)
      return yield* joinRequests({ userID: current.userID })
    }),
    pendingJoinRequests: Effect.fn("Identity.postgres.pendingJoinRequests")(function* (sessionID) {
      const current = yield* requireSession(sessionID)
      const pending = yield* joinRequests({ pending: true })
      if (current.admin) return pending
      const managed: Row[] = yield* run(
        () => sql`SELECT organization_id FROM identity_membership WHERE user_id = ${current.userID} AND role = 'admin'`,
      )
      const ids = new Set(managed.map((row) => row.organization_id as string))
      return pending.filter((item) => ids.has(item.organizationID))
    }),
    decideJoinRequest: Effect.fn("Identity.postgres.decideJoinRequest")(function* (sessionID, requestID, approve) {
      const found = (yield* joinRequests({ id: requestID }))[0]
      if (!found || found.status !== "pending") return yield* new Rejected({ reason: "missing" })
      const current = yield* requireOrganizationAdmin(sessionID, found.organizationID)
      const now = Date.now()
      const status = approve ? "approved" : "rejected"
      yield* run(async () => {
        const row = first(await sql`SELECT user_id FROM identity_join_request WHERE id = ${requestID}`)
        await sql`
          UPDATE identity_join_request SET status = ${status}, decided_by_user_id = ${current.userID}, time_updated = ${now}
          WHERE id = ${requestID}`
        if (!approve || !row) return
        await sql`
          INSERT INTO identity_membership (organization_id, user_id, time_created, time_updated)
          VALUES (${found.organizationID}, ${row.user_id}, ${now}, ${now}) ON CONFLICT DO NOTHING`
        await sql`
          UPDATE identity_session SET organization_id = ${found.organizationID}, time_updated = ${now}
          WHERE user_id = ${row.user_id} AND organization_id IS NULL`
      })
      return { ...found, status: status as "approved" | "rejected" }
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

export * as SessionSync from "./session-sync.js"

import type { SQL } from "bun"
import { and, asc, eq, gt, inArray, lt, or, sql, type AnyColumn } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "./database/database.js"
import { ProjectTable } from "./project/sql.js"
import type { SessionSchema } from "./session/schema.js"
import { SessionSyncCursorTable } from "./session-sync/sql.js"
import { SessionMessageTable, SessionTable, SessionUserTable } from "./session/sql.js"

type Db = Database.Interface["db"]

const BATCH = 200
// One round stops after this many batches, so a layer with a long backlog still answers other work between rounds.
const MAX_BATCHES = 25
// Rows changed in the last moments are left for the next round. A row is stamped when it is written, and a row stamped
// a millisecond before one already sent can still commit afterwards; waiting this long means every row with an older
// stamp has committed, so the cursor never steps past a row it has not seen.
const SETTLE_MS = 2_000

/**
 * Copies this layer's sessions and messages to the shared Postgres, for analysis. Each kind has a cursor, the last
 * `(time_updated, id)` sent, so a round sends only what changed since; writes are upserts, so a repeat is harmless.
 * Organizations that turned the copy off are skipped and their rows are never sent, including after they turn it back on.
 */
export const run = Effect.fn("SessionSync.run")(function* (input: { db: Db; sql: SQL; runtimeID: string }) {
  const rows: { id: string }[] = yield* Effect.promise(
    () => input.sql`SELECT id FROM identity_organization WHERE session_sync = false`,
  )
  const off = new Set(rows.map((row) => row.id))
  // A session's cost and tokens are added without touching its own `time_updated` (see `applyUsage` in the projector),
  // so the session cursor alone would miss them. The messages of that step do change, so every session with a message
  // sent this round is sent again, whatever its own stamp says.
  const touched = new Set<SessionSchema.ID>()
  const messages = yield* copy("message", input, off, messageBatch(touched))
  const refreshed = yield* sendSessions(input, off, [...touched])
  const sessions = yield* copy("session", input, off, sessionBatch(touched))
  yield* copy("project", input, off, projectBatch)
  // `more` tells the caller the round stopped at its cap with rows left, so it should come back soon instead of waiting.
  return { sessions: sessions.sent + refreshed, messages: messages.sent, more: messages.more || sessions.more }
})

type Cursor = { readonly time: number; readonly id: string }
type Written = { readonly written: number; readonly skipped: ReadonlyArray<string> }
type Batch = {
  /** Rows to send, already filtered for organizations that opted out. */
  readonly send: () => Promise<Written>
  /** Where the batch ended, counting the rows that were filtered out. */
  readonly last: Cursor | undefined
  readonly read: number
}
type Reader = (input: { db: Db; sql: SQL; runtimeID: string }, after: Cursor, off: Set<string>) => Effect.Effect<Batch>

const copy = Effect.fnUntraced(function* (
  kind: "session" | "message" | "project",
  input: { db: Db; sql: SQL; runtimeID: string },
  off: Set<string>,
  read: Reader,
) {
  const stored = (yield* input.db
    .select()
    .from(SessionSyncCursorTable)
    .where(eq(SessionSyncCursorTable.kind, kind))
    .all()
    .pipe(Effect.orDie))[0]
  let cursor: Cursor = { time: stored?.time ?? 0, id: stored?.id ?? "" }
  let sent = 0
  let more = false
  for (let index = 0; index < MAX_BATCHES; index++) {
    const batch = yield* read(input, cursor, off)
    if (!batch.last) break
    const result = yield* Effect.promise(batch.send)
    if (result.skipped.length > 0)
      yield* Effect.logWarning("Postgres refused rows while copying sessions; they were skipped", {
        kind,
        ids: result.skipped,
      })
    cursor = batch.last
    yield* input.db
      .insert(SessionSyncCursorTable)
      .values({ kind, time: cursor.time, id: cursor.id })
      .onConflictDoUpdate({ target: SessionSyncCursorTable.kind, set: { time: cursor.time, id: cursor.id } })
      .run()
      .pipe(Effect.orDie)
    sent += result.written
    if (batch.read < BATCH) break
    more = index === MAX_BATCHES - 1
  }
  return { sent, more }
})

function after(time: AnyColumn, id: AnyColumn, cursor: Cursor) {
  return and(
    or(gt(time, cursor.time), and(eq(time, cursor.time), gt(id, cursor.id))),
    lt(time, Date.now() - SETTLE_MS),
  )
}

type SessionRow = { session: typeof SessionTable.$inferSelect; organizationID: string | null }

const selectSessions = (db: Db) =>
  db
    .select({ session: SessionTable, organizationID: ProjectTable.organization_id })
    .from(SessionTable)
    .leftJoin(ProjectTable, eq(ProjectTable.id, SessionTable.project_id))

/** Sends the given sessions, whatever their stamp, to every organization that has not opted out. */
const sendSessions = Effect.fnUntraced(function* (
  input: { db: Db; sql: SQL; runtimeID: string },
  off: Set<string>,
  ids: ReadonlyArray<SessionSchema.ID>,
) {
  if (ids.length === 0) return 0
  const rows = yield* selectSessions(input.db)
    .where(inArray(SessionTable.id, [...ids]))
    .all()
    .pipe(Effect.orDie)
  const owners = yield* ownersOf(input.db, rows)
  const result = yield* Effect.promise(() => writeSessions(input, off, rows, owners))
  if (result.skipped.length > 0)
    yield* Effect.logWarning("Postgres refused rows while copying sessions; they were skipped", {
      kind: "session",
      ids: result.skipped,
    })
  return result.written
})

/** `sent` holds sessions already sent this round, which the cursor passes over. */
const sessionBatch =
  (sent: ReadonlySet<SessionSchema.ID>): Reader =>
  (input, cursor, off) =>
  Effect.gen(function* () {
    const rows = yield* selectSessions(input.db)
      .where(after(SessionTable.time_updated, SessionTable.id, cursor))
      .orderBy(asc(SessionTable.time_updated), asc(SessionTable.id))
      .limit(BATCH)
      .all()
      .pipe(Effect.orDie)
    const pending = rows.filter((row) => !sent.has(row.session.id))
    const owners = yield* ownersOf(input.db, pending)
    const last = rows.at(-1)
    return {
      read: rows.length,
      last: last && { time: last.session.time_updated, id: last.session.id },
      send: () => writeSessions(input, off, pending, owners),
    }
  })

const projectBatch: Reader = (input, cursor, off) =>
  Effect.gen(function* () {
    const rows = yield* input.db
      .select()
      .from(ProjectTable)
      .where(after(ProjectTable.time_updated, ProjectTable.id, cursor))
      .orderBy(asc(ProjectTable.time_updated), asc(ProjectTable.id))
      .limit(BATCH)
      .all()
      .pipe(Effect.orDie)
    const sendable = rows.filter((row) => !(row.organization_id && off.has(row.organization_id)))
    const last = rows.at(-1)
    return {
      read: rows.length,
      last: last && { time: last.time_updated, id: last.id },
      send: () =>
        write(
          input.sql,
          sendable,
          (db, project) => db`
            INSERT INTO session_sync_project (
              runtime_id, project_id, organization_id, name, worktree, vcs, created_by_user_id, visibility,
              time_created, time_updated, time_archived, time_synced
            ) VALUES (
              ${input.runtimeID}, ${project.id}, ${project.organization_id}, ${text(project.name)},
              ${text(project.worktree)}, ${project.vcs}, ${project.created_by_user_id}, ${project.visibility},
              ${project.time_created}, ${project.time_updated}, ${project.time_archived}, ${Date.now()}
            )
            ON CONFLICT (runtime_id, project_id) DO UPDATE SET
              organization_id = EXCLUDED.organization_id, name = EXCLUDED.name, worktree = EXCLUDED.worktree,
              vcs = EXCLUDED.vcs, created_by_user_id = EXCLUDED.created_by_user_id,
              visibility = EXCLUDED.visibility, time_updated = EXCLUDED.time_updated,
              time_archived = EXCLUDED.time_archived, time_synced = EXCLUDED.time_synced`,
          (project) => project.id,
        ),
    }
  })

/** Who started each session and who it currently acts for. */
const ownersOf = (db: Db, rows: ReadonlyArray<SessionRow>) =>
  rows.length === 0
    ? Effect.succeed(new Map<string, typeof SessionUserTable.$inferSelect>())
    : db
        .select()
        .from(SessionUserTable)
        .where(
          inArray(
            SessionUserTable.session_id,
            rows.map((row) => row.session.id),
          ),
        )
        .all()
        .pipe(
          Effect.orDie,
          Effect.map((owners) => new Map(owners.map((row) => [row.session_id as string, row] as const))),
        )

const writeSessions = async (
  input: { db: Db; sql: SQL; runtimeID: string },
  off: Set<string>,
  rows: SessionRow[],
  owners: ReadonlyMap<string, typeof SessionUserTable.$inferSelect>,
) => {
  const sendable = rows.filter((row) => !(row.organizationID && off.has(row.organizationID)))
  return write(input.sql, sendable, (db, { session, organizationID }) => {
    const owner = owners.get(session.id)
    return db`
      INSERT INTO session_sync_session (
        session_id, organization_id, runtime_id, project_id, parent_id, title, directory, agent, model, cost,
        tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
        created_by_user_id, holder_user_id, visibility, time_created, time_updated, time_archived, time_synced
      ) VALUES (
        ${session.id}, ${organizationID}, ${input.runtimeID}, ${session.project_id}, ${session.parent_id},
        ${text(session.title)}, ${text(session.directory)}, ${session.agent}, ${session.model ?? null}::jsonb,
        ${session.cost}, ${session.tokens_input}, ${session.tokens_output}, ${session.tokens_reasoning},
        ${session.tokens_cache_read}, ${session.tokens_cache_write}, ${owner?.created_by_user_id ?? null},
        ${owner?.user_id ?? null}, ${owner?.visibility ?? null}, ${session.time_created},
        ${session.time_updated}, ${session.time_archived}, ${Date.now()}
      )
      ON CONFLICT (session_id) DO UPDATE SET
        organization_id = EXCLUDED.organization_id, runtime_id = EXCLUDED.runtime_id,
        parent_id = EXCLUDED.parent_id, title = EXCLUDED.title, directory = EXCLUDED.directory,
        agent = EXCLUDED.agent, model = EXCLUDED.model, cost = EXCLUDED.cost,
        tokens_input = EXCLUDED.tokens_input, tokens_output = EXCLUDED.tokens_output,
        tokens_reasoning = EXCLUDED.tokens_reasoning, tokens_cache_read = EXCLUDED.tokens_cache_read,
        tokens_cache_write = EXCLUDED.tokens_cache_write, created_by_user_id = EXCLUDED.created_by_user_id,
        holder_user_id = EXCLUDED.holder_user_id, visibility = EXCLUDED.visibility,
        time_updated = EXCLUDED.time_updated, time_archived = EXCLUDED.time_archived,
        time_synced = EXCLUDED.time_synced`
  }, (row) => row.session.id)
}

/** `touched` collects the sessions whose messages were sent, for `run` to send again. */
const messageBatch =
  (touched: Set<SessionSchema.ID>): Reader =>
  (input, cursor, off) =>
    Effect.gen(function* () {
      const rows = yield* input.db
        .select({
          message: SessionMessageTable,
          organizationID: ProjectTable.organization_id,
          projectID: SessionTable.project_id,
          // A user message has its own sender; any other message takes the one who wrote the prompt before it.
          userID: sql<string | null>`case when ${SessionMessageTable.type} = 'user' then ${SessionMessageTable.user_id} else (
            select prev.user_id from session_message prev
            where prev.session_id = ${SessionMessageTable.session_id} and prev.type = 'user' and prev.seq < ${SessionMessageTable.seq}
            order by prev.seq desc limit 1
          ) end`,
        })
        .from(SessionMessageTable)
        .innerJoin(SessionTable, eq(SessionTable.id, SessionMessageTable.session_id))
        .leftJoin(ProjectTable, eq(ProjectTable.id, SessionTable.project_id))
        .where(after(SessionMessageTable.time_updated, SessionMessageTable.id, cursor))
        .orderBy(asc(SessionMessageTable.time_updated), asc(SessionMessageTable.id))
        .limit(BATCH)
        .all()
        .pipe(Effect.orDie)
      const sendable = rows.filter((row) => !(row.organizationID && off.has(row.organizationID)))
      const last = rows.at(-1)
      return {
        read: rows.length,
        last: last && { time: last.message.time_updated, id: last.message.id },
        send: async () => {
          const result = await write(
            input.sql,
            sendable,
            (db, { message, organizationID, projectID, userID }) => {
              const used = usage(message.data)
              return db`
              INSERT INTO session_sync_message (
                session_id, seq, id, organization_id, runtime_id, project_id, user_id, type, data, time_created,
                time_updated, time_synced, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read,
                tokens_cache_write, model
              ) VALUES (
                ${message.session_id}, ${message.seq}, ${message.id}, ${organizationID}, ${input.runtimeID},
                ${projectID}, ${userID},
                ${message.type}, ${redact(message.data)}::jsonb, ${message.time_created},
                ${message.time_updated}, ${Date.now()}, ${used.cost}, ${used.input},
                ${used.output}, ${used.reasoning}, ${used.cacheRead},
                ${used.cacheWrite}, ${used.model}
              )
              ON CONFLICT (session_id, seq) DO UPDATE SET
                id = EXCLUDED.id, organization_id = EXCLUDED.organization_id, runtime_id = EXCLUDED.runtime_id,
                project_id = EXCLUDED.project_id, user_id = EXCLUDED.user_id, type = EXCLUDED.type, data = EXCLUDED.data, time_updated = EXCLUDED.time_updated,
                time_synced = EXCLUDED.time_synced,
                cost = EXCLUDED.cost, tokens_input = EXCLUDED.tokens_input, tokens_output = EXCLUDED.tokens_output,
                tokens_reasoning = EXCLUDED.tokens_reasoning, tokens_cache_read = EXCLUDED.tokens_cache_read,
                tokens_cache_write = EXCLUDED.tokens_cache_write, model = EXCLUDED.model`
            },
            (row) => row.message.id,
          )
          sendable.forEach((row) => touched.add(row.message.session_id))
          return result
        },
      }
    })

const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null)

/** What one model call cost, from an assistant or compaction message; empty for any other message. */
function usage(data: unknown) {
  const message = data as {
    cost?: unknown
    tokens?: { input?: unknown; output?: unknown; reasoning?: unknown; cache?: { read?: unknown; write?: unknown } }
    model?: { providerID?: unknown; id?: unknown }
  }
  return {
    cost: typeof message.cost === "number" && Number.isFinite(message.cost) ? message.cost : null,
    input: count(message.tokens?.input),
    output: count(message.tokens?.output),
    reasoning: count(message.tokens?.reasoning),
    cacheRead: count(message.tokens?.cache?.read),
    cacheWrite: count(message.tokens?.cache?.write),
    model:
      typeof message.model?.id === "string" && typeof message.model.providerID === "string"
        ? `${message.model.providerID}/${message.model.id}`
        : null,
  }
}

/**
 * Writes the rows in one transaction. If Postgres refuses the batch because of a row's own content (a character it
 * cannot store, a constraint), the rows go one at a time and the refused ones are skipped, so one row cannot stop
 * every row after it. Any other failure, such as a lost connection, is thrown and the cursor stays where it was.
 */
async function write<T>(
  sql: SQL,
  rows: ReadonlyArray<T>,
  one: (db: SQL, row: T) => Promise<unknown>,
  id: (row: T) => string,
): Promise<Written> {
  if (rows.length === 0) return { written: 0, skipped: [] }
  const batch = await sql
    .begin(async (tx) => {
      for (const row of rows) await one(tx, row)
    })
    .then(
      () => true,
      (error) => {
        if (!refusedRow(error)) throw error
        return false
      },
    )
  if (batch) return { written: rows.length, skipped: [] }
  const skipped: string[] = []
  for (const row of rows)
    await one(sql, row).catch((error) => {
      if (!refusedRow(error)) throw error
      skipped.push(id(row))
    })
  return { written: rows.length - skipped.length, skipped }
}

// SQLSTATE classes that describe the row rather than the connection: data exception, integrity constraint, limit.
const refusedRow = (error: unknown) =>
  typeof error === "object" && error !== null && "errno" in error && /^(22|23|54)/.test(String(error.errno))

// Postgres text and jsonb cannot hold NUL, and jsonb refuses a lone surrogate.
const text = <T extends string | null>(value: T): T => (value === null ? value : (clean(value) as T))
const clean = (value: string) => value.replaceAll("\u0000", "").toWellFormed()

// A field whose name says it holds a credential. Token counts (`tokens`, `input_tokens`) are not credentials.
const SECRET_KEY =
  /api[_-]?key|secret|passw(?:or)?d|authorization|(?:access|refresh|auth|id|bearer|session)[_-]?token|private[_-]?key|credential/i
const SECRET_TEXT = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
]
const REDACTED = "[redacted]"

/**
 * Removes credentials from a message before it leaves the layer: the value of any field named like one, and text that
 * looks like a common key format. Best effort. Text a tool printed, such as a file's contents, can hold a secret in a
 * shape nothing here recognizes.
 */
export function redact(value: unknown): unknown {
  if (typeof value === "string")
    return SECRET_TEXT.reduce((result, pattern) => result.replace(pattern, REDACTED), clean(value))
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [clean(key), SECRET_KEY.test(key) && item ? REDACTED : redact(item)]),
    )
  return value
}

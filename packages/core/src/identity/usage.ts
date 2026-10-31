export * as IdentityUsage from "./usage.js"

import type { SQL } from "bun"

/** Longest span one report covers, so a request cannot scan the whole history. */
export const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1000

export type Totals = {
  readonly cost: number
  readonly tokensInput: number
  readonly tokensOutput: number
  readonly tokensReasoning: number
  readonly tokensCacheRead: number
  readonly tokensCacheWrite: number
  /** Model calls: assistant and compaction messages that carry a cost or token count. */
  readonly calls: number
  readonly sessions: number
  readonly users: number
}

export type Group = Totals & { readonly key: string; readonly label: string }
export type Day = { readonly day: string; readonly cost: number; readonly tokens: number; readonly calls: number }
export type Dimension = "user" | "model" | "project" | "session"

export type Query = {
  /** Milliseconds since the epoch; `from` is included, `to` is not. */
  readonly from: number
  readonly to: number
  readonly groupBy: Dimension
  readonly userID?: string
  readonly projectID?: string
  readonly model?: string
  /** Minutes the reader's day starts ahead of UTC, so days break where they expect. */
  readonly tzOffset?: number
  readonly limit?: number
}

export type Report = { readonly totals: Totals; readonly days: ReadonlyArray<Day>; readonly groups: ReadonlyArray<Group> }

export type SessionQuery = {
  readonly from: number
  readonly to: number
  readonly userID?: string
  readonly projectID?: string
  readonly search?: string
  readonly limit?: number
  readonly offset?: number
}

export type Session = {
  readonly id: string
  readonly title: string | null
  readonly project: string | null
  readonly holder: string | null
  readonly creator: string | null
  readonly cost: number
  readonly tokens: number
  readonly updated: number
  readonly archived: boolean
}

export type Message = {
  readonly seq: number
  readonly type: string
  readonly user: string | null
  readonly created: number
  readonly cost: number | null
  readonly tokens: number | null
  readonly model: string | null
  readonly data: unknown
}

export type Organization = Totals & { readonly id: string; readonly name: string }

// Each dimension is a fixed piece of SQL, chosen from this table by a validated name; nothing a caller sends is
// spliced into a query.
const dimensions = {
  user: {
    key: "m.user_id",
    label: "COALESCE(u.name || ' (' || u.employee_id || ')', u.employee_id, '')",
    join: "LEFT JOIN identity_user u ON u.id = m.user_id",
    group: "m.user_id, u.name, u.employee_id",
  },
  model: { key: "m.model", label: "COALESCE(m.model, '')", join: "", group: "m.model" },
  project: {
    key: "m.project_id",
    label: "COALESCE(p.name, p.worktree, m.project_id, '')",
    join: "LEFT JOIN session_sync_project p ON p.runtime_id = m.runtime_id AND p.project_id = m.project_id",
    group: "m.project_id, p.name, p.worktree",
  },
  session: {
    key: "m.session_id",
    label: "COALESCE(s.title, m.session_id)",
    join: "LEFT JOIN session_sync_session s ON s.session_id = m.session_id",
    group: "m.session_id, s.title",
  },
} as const satisfies Record<Dimension, { key: string; label: string; join: string; group: string }>

const SUMS = `
  COALESCE(sum(m.cost), 0)::float8 AS cost,
  COALESCE(sum(m.tokens_input), 0)::float8 AS tokens_input,
  COALESCE(sum(m.tokens_output), 0)::float8 AS tokens_output,
  COALESCE(sum(m.tokens_reasoning), 0)::float8 AS tokens_reasoning,
  COALESCE(sum(m.tokens_cache_read), 0)::float8 AS tokens_cache_read,
  COALESCE(sum(m.tokens_cache_write), 0)::float8 AS tokens_cache_write,
  count(*)::int AS calls,
  count(DISTINCT m.session_id)::int AS sessions,
  count(DISTINCT m.user_id)::int AS users`

// The calls of one organization in a range. The partial index session_sync_message_usage serves exactly this filter.
const CALLS = `
  m.organization_id = $1 AND m.time_created >= $2 AND m.time_created < $3
  AND (m.cost IS NOT NULL OR m.tokens_input IS NOT NULL)
  AND ($4::text IS NULL OR m.user_id = $4)
  AND ($5::text IS NULL OR m.project_id = $5)
  AND ($6::text IS NULL OR m.model = $6)`

type Row = Record<string, unknown>

const num = (value: unknown) => Number(value ?? 0)
const totals = (row: Row | undefined): Totals => ({
  cost: num(row?.cost),
  tokensInput: num(row?.tokens_input),
  tokensOutput: num(row?.tokens_output),
  tokensReasoning: num(row?.tokens_reasoning),
  tokensCacheRead: num(row?.tokens_cache_read),
  tokensCacheWrite: num(row?.tokens_cache_write),
  calls: num(row?.calls),
  sessions: num(row?.sessions),
  users: num(row?.users),
})

export const limitOf = (value: number | undefined, fallback: number, max: number) =>
  Math.min(Math.max(Math.trunc(value ?? fallback), 1), max)

/** Usage of one organization in a range: the total, by day, and by the chosen dimension. */
export async function report(sql: SQL, organizationID: string, query: Query): Promise<Report> {
  const params = [
    organizationID,
    query.from,
    query.to,
    query.userID ?? null,
    query.projectID ?? null,
    query.model ?? null,
  ]
  const by = dimensions[query.groupBy]
  const offset = Math.trunc(query.tzOffset ?? 0) * 60_000
  const [total, days, groups] = await Promise.all([
    sql.unsafe(`SELECT ${SUMS} FROM session_sync_message m WHERE ${CALLS}`, params) as Promise<Row[]>,
    sql.unsafe(
      `SELECT to_char(to_timestamp((m.time_created + ${offset}) / 1000.0) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
         COALESCE(sum(m.cost), 0)::float8 AS cost,
         COALESCE(sum(COALESCE(m.tokens_input, 0) + COALESCE(m.tokens_output, 0) + COALESCE(m.tokens_reasoning, 0)
           + COALESCE(m.tokens_cache_read, 0) + COALESCE(m.tokens_cache_write, 0)), 0)::float8 AS tokens,
         count(*)::int AS calls
       FROM session_sync_message m WHERE ${CALLS} GROUP BY 1 ORDER BY 1`,
      params,
    ) as Promise<Row[]>,
    sql.unsafe(
      `SELECT ${by.key} AS key, ${by.label} AS label, ${SUMS}
       FROM session_sync_message m ${by.join} WHERE ${CALLS}
       GROUP BY ${by.group} ORDER BY cost DESC, key LIMIT $7`,
      [...params, limitOf(query.limit, 50, 200)],
    ) as Promise<Row[]>,
  ])
  return {
    totals: totals(total[0]),
    days: days.map((row) => ({
      day: String(row.day),
      cost: num(row.cost),
      tokens: num(row.tokens),
      calls: num(row.calls),
    })),
    groups: groups.map((row) => ({ ...totals(row), key: String(row.key ?? ""), label: String(row.label ?? "") })),
  }
}

/** Sessions of one organization that changed in a range, newest first. Cost and tokens are the session's own totals. */
export async function sessions(sql: SQL, organizationID: string, query: SessionQuery) {
  const rows = (await sql.unsafe(
    `SELECT s.session_id AS id, s.title, COALESCE(p.name, p.worktree, s.project_id) AS project, h.employee_id AS holder,
       c.employee_id AS creator, s.cost, (s.tokens_input + s.tokens_output + s.tokens_reasoning + s.tokens_cache_read
       + s.tokens_cache_write)::float8 AS tokens, s.time_updated, s.time_archived IS NOT NULL AS archived,
       (count(*) OVER ())::int AS total
     FROM session_sync_session s
     LEFT JOIN session_sync_project p ON p.runtime_id = s.runtime_id AND p.project_id = s.project_id
     LEFT JOIN identity_user h ON h.id = s.holder_user_id
     LEFT JOIN identity_user c ON c.id = s.created_by_user_id
     WHERE s.organization_id = $1 AND s.time_updated >= $2 AND s.time_updated < $3
       AND ($4::text IS NULL OR s.holder_user_id = $4 OR s.created_by_user_id = $4)
       AND ($5::text IS NULL OR s.project_id = $5)
       AND ($6::text IS NULL OR position(lower($6) in lower(COALESCE(s.title, ''))) > 0)
     ORDER BY s.time_updated DESC, s.session_id LIMIT $7 OFFSET $8`,
    [
      organizationID,
      query.from,
      query.to,
      query.userID ?? null,
      query.projectID ?? null,
      query.search?.trim() || null,
      limitOf(query.limit, 50, 200),
      Math.max(Math.trunc(query.offset ?? 0), 0),
    ],
  )) as Row[]
  return {
    total: num(rows[0]?.total),
    items: rows.map(
      (row): Session => ({
        id: String(row.id),
        title: (row.title as string | null) ?? null,
        project: (row.project as string | null) ?? null,
        holder: (row.holder as string | null) ?? null,
        creator: (row.creator as string | null) ?? null,
        cost: num(row.cost),
        tokens: num(row.tokens),
        updated: num(row.time_updated),
        archived: row.archived === true,
      }),
    ),
  }
}

/** Whether a member may read a session's messages: they started it or hold it. */
export async function ownsSession(sql: SQL, organizationID: string, sessionID: string, userID: string) {
  const rows = (await sql.unsafe(
    `SELECT 1 FROM session_sync_session WHERE session_id = $1 AND organization_id = $2
       AND (holder_user_id = $3 OR created_by_user_id = $3)`,
    [sessionID, organizationID, userID],
  )) as Row[]
  return rows.length > 0
}

/** The copied messages of one session, in order. They were redacted when copied. */
export async function messages(
  sql: SQL,
  organizationID: string,
  sessionID: string,
  page: { readonly limit?: number; readonly offset?: number },
) {
  const rows = (await sql.unsafe(
    `SELECT m.seq, m.type, u.employee_id AS user, m.time_created, m.cost, m.model, m.data,
       CASE WHEN m.tokens_input IS NULL THEN NULL ELSE COALESCE(m.tokens_input, 0) + COALESCE(m.tokens_output, 0)
         + COALESCE(m.tokens_reasoning, 0) + COALESCE(m.tokens_cache_read, 0) + COALESCE(m.tokens_cache_write, 0) END AS tokens
     FROM session_sync_message m LEFT JOIN identity_user u ON u.id = m.user_id
     WHERE m.session_id = $1 AND m.organization_id = $2 ORDER BY m.seq LIMIT $3 OFFSET $4`,
    [sessionID, organizationID, limitOf(page.limit, 100, 200), Math.max(Math.trunc(page.offset ?? 0), 0)],
  )) as Row[]
  return rows.map(
    (row): Message => ({
      seq: num(row.seq),
      type: String(row.type),
      user: (row.user as string | null) ?? null,
      created: num(row.time_created),
      cost: row.cost === null || row.cost === undefined ? null : num(row.cost),
      tokens: row.tokens === null || row.tokens === undefined ? null : num(row.tokens),
      model: (row.model as string | null) ?? null,
      data: row.data,
    }),
  )
}

/** Usage of every organization in a range, biggest first. */
export async function organizations(sql: SQL, range: { readonly from: number; readonly to: number }) {
  const rows = (await sql.unsafe(
    `SELECT m.organization_id AS id, COALESCE(o.name, m.organization_id) AS name, ${SUMS}
     FROM session_sync_message m LEFT JOIN identity_organization o ON o.id = m.organization_id
     WHERE m.organization_id IS NOT NULL AND m.time_created >= $1 AND m.time_created < $2
       AND (m.cost IS NOT NULL OR m.tokens_input IS NOT NULL)
     GROUP BY m.organization_id, o.name ORDER BY cost DESC, id LIMIT 200`,
    [range.from, range.to],
  )) as Row[]
  return rows.map((row): Organization => ({ ...totals(row), id: String(row.id), name: String(row.name) }))
}

const REPAIR_BATCH = 2_000

// The columns `session-sync.ts` lifts out of a message, computed from its JSON for rows copied before they existed.
const FROM_DATA = `
  cost = CASE WHEN jsonb_typeof(data -> 'cost') = 'number' THEN (data ->> 'cost')::double precision END,
  tokens_input = CASE WHEN jsonb_typeof(data #> '{tokens,input}') = 'number' THEN round((data #>> '{tokens,input}')::numeric)::bigint END,
  tokens_output = CASE WHEN jsonb_typeof(data #> '{tokens,output}') = 'number' THEN round((data #>> '{tokens,output}')::numeric)::bigint END,
  tokens_reasoning = CASE WHEN jsonb_typeof(data #> '{tokens,reasoning}') = 'number' THEN round((data #>> '{tokens,reasoning}')::numeric)::bigint END,
  tokens_cache_read = CASE WHEN jsonb_typeof(data #> '{tokens,cache,read}') = 'number' THEN round((data #>> '{tokens,cache,read}')::numeric)::bigint END,
  tokens_cache_write = CASE WHEN jsonb_typeof(data #> '{tokens,cache,write}') = 'number' THEN round((data #>> '{tokens,cache,write}')::numeric)::bigint END,
  model = CASE WHEN jsonb_typeof(data #> '{model,id}') = 'string' THEN (data #>> '{model,providerID}') || '/' || (data #>> '{model,id}') END`

/**
 * Fills the usage columns of assistant and compaction messages that were copied without them: rows from before the
 * columns existed, and rows an older layer wrote during a rolling upgrade. Works in batches, each its own statement, so
 * no lock is held for long, and walks the primary key so a row whose JSON holds no usage cannot be picked up twice.
 * Only one layer repairs at a time (an advisory lock on a connection of its own); the others return 0 at once. Returns how many rows it visited.
 * `since` limits the scan to rows copied at or after that time; omit it for the whole table.
 */
export async function repair(sql: SQL, options?: { readonly since?: number; readonly batch?: number }) {
  const batch = options?.batch ?? REPAIR_BATCH
  const since = options?.since ?? 0
  const connection = await sql.reserve()
  try {
    const locked = (await connection`SELECT pg_try_advisory_lock(hashtext('opencode_usage_repair')) AS locked`)[0]
    if (!locked?.locked) return 0
    try {
      let repaired = 0
      let after: { session: string; seq: number } | undefined
      for (;;) {
        const rows = (await connection.unsafe(
          `SELECT session_id, seq FROM session_sync_message
           WHERE type IN ('assistant', 'compaction') AND cost IS NULL AND tokens_input IS NULL AND model IS NULL
             AND time_synced >= $1 AND ($2::text IS NULL OR (session_id, seq) > ($2::text, $3::bigint))
           ORDER BY session_id, seq LIMIT $4`,
          [since, after?.session ?? null, after?.seq ?? 0, batch],
        )) as Row[]
        const last = rows.at(-1)
        if (!last) return repaired
        await connection.unsafe(
          `UPDATE session_sync_message SET ${FROM_DATA}
           WHERE (session_id, seq) IN (SELECT * FROM unnest($1::text[], $2::bigint[]))`,
          [rows.map((row) => String(row.session_id)), rows.map((row) => Number(row.seq))],
        )
        repaired += rows.length
        after = { session: String(last.session_id), seq: Number(last.seq) }
        if (rows.length < batch) return repaired
      }
    } finally {
      await connection`SELECT pg_advisory_unlock(hashtext('opencode_usage_repair'))`
    }
  } finally {
    connection.release()
  }
}

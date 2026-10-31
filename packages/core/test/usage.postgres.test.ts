import path from "node:path"
import os from "node:os"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Database } from "@opencode/core/database/database"
import { Identity } from "@opencode/core/identity"
import { migrations } from "@opencode/core/identity/postgres"
import { IdentityUsage } from "@opencode/core/identity/usage"
import { Effect, Layer } from "effect"
import { Global } from "@opencode/util/global"
import { Postgres } from "@opencode/util/postgres"
import { afterAll, describe, expect, test } from "bun:test"
import { testEffect } from "./lib/effect"

const url = process.env.OPENCODE_TEST_POSTGRES_URL

delete process.env.OPENCODE_ADMIN_EMPLOYEE_ID
delete process.env.OPENCODE_ADMIN_PASSWORD
const tables =
  "session_sync_project, session_sync_session, session_sync_message, identity_audit, identity_join_request, identity_preference, identity_user_credential, identity_session, identity_membership, identity_organization, identity_user, auth_migration"
async function reset() {
  const sql = Postgres.connect(url!)
  await sql.unsafe(`DROP TABLE IF EXISTS ${tables}`)
  await sql.close()
}
if (url) {
  process.env.OPENCODE_IDENTITY_POSTGRES_URL = url
  await reset()
}
afterAll(async () => {
  if (url) await reset()
})

const data = path.join(os.tmpdir(), "opencode-ex-usage-postgres")
const database = Database.layerFromClient.pipe(
  Layer.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })),
  Layer.provide(Global.layerWith({ data })),
)
const it = testEffect(Identity.layer.pipe(Layer.provideMerge(database), Layer.provideMerge(Global.layerWith({ data }))))

const password = "password-1"
const DAY = 24 * 60 * 60 * 1000
// 2026-01-10 00:00 UTC, a day boundary the time zone tests move across.
const start = Date.UTC(2026, 0, 10)

describe.skipIf(!url)("usage report", () => {
  it.effect("sums calls by day, user, model, project and session, and each reader sees only what they may", () =>
    Effect.gen(function* () {
      const sql = Postgres.connect(url!)
      const identity = yield* Identity.Service
      yield* identity.ensureAdmin({ employeeID: "9300", password })
      const admin = (yield* identity.authenticate((yield* identity.login({ employeeID: "9300", password }))!.token))!
      const organization = yield* identity.createOrganization(admin.sessionID, "Usage Co")
      const other = yield* identity.createOrganization(admin.sessionID, "Other Co")
      yield* identity.createUser(admin.sessionID, { employeeID: "9301", password, organizationID: organization.id })
      yield* identity.createUser(admin.sessionID, { employeeID: "9302", password, organizationID: organization.id })
      yield* identity.createUser(admin.sessionID, { employeeID: "9303", password, organizationID: other.id })
      yield* identity.setMemberRole(admin.sessionID, organization.id, "9301", "admin")
      const signIn = (employeeID: string) =>
        Effect.gen(function* () {
          const login = yield* identity.login({ employeeID, password })
          return (yield* identity.authenticate(login!.token))!
        })
      const orgAdmin = yield* signIn("9301")
      const member = yield* signIn("9302")
      const stranger = yield* signIn("9303")
      const ids = yield* identity.employeeIDs([orgAdmin.userID, member.userID])
      const idOf = (employeeID: string) => [...ids].find(([, value]) => value === employeeID)![0]

      const org = organization.id
      yield* Effect.promise(async () => {
        const session = (id: string, holder: string, title: string, project: string) => sql`
          INSERT INTO session_sync_session (session_id, organization_id, runtime_id, project_id, title, cost, tokens_input,
            tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, holder_user_id, created_by_user_id,
            time_created, time_updated, time_synced)
          VALUES (${id}, ${org}, 'layer-a', ${project}, ${title}, 1, 0, 0, 0, 0, 0, ${holder}, ${holder},
            ${start}, ${start + 1000}, ${start})`
        await session("ses_a", idOf("9301"), "Plan the launch", "prj_1")
        await session("ses_b", idOf("9302"), "Fix the build", "prj_2")
        await sql`INSERT INTO session_sync_project (runtime_id, project_id, organization_id, name, worktree, time_created, time_updated, time_synced)
          VALUES ('layer-a', 'prj_1', ${org}, 'Launch', '/p1', ${start}, ${start}, ${start})`
        const call = (seq: number, sessionID: string, userID: string, project: string, model: string, cost: number, at: number) => sql`
          INSERT INTO session_sync_message (session_id, seq, id, organization_id, runtime_id, project_id, user_id, type, data,
            time_created, time_updated, time_synced, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read,
            tokens_cache_write, model)
          VALUES (${sessionID}, ${seq}, ${`msg_${sessionID}_${seq}`}, ${org}, 'layer-a', ${project}, ${userID}, 'assistant',
            ${{ type: "assistant", text: "answer" }}::jsonb, ${at}, ${at}, ${at}, ${cost}, 100, 50, 10, 5, 1, ${model})`
        // 23:30 on the 10th is already the 11th for someone eight hours east of UTC.
        await call(2, "ses_a", idOf("9301"), "prj_1", "openai/gpt", 0.5, start + 23.5 * 60 * 60 * 1000)
        await call(4, "ses_a", idOf("9301"), "prj_1", "anthropic/sonnet", 1.25, start + DAY + 1000)
        await call(2, "ses_b", idOf("9302"), "prj_2", "openai/gpt", 0.25, start + 2000)
        // A user message carries no cost and is not a call; another organization's call is not counted at all.
        await sql`INSERT INTO session_sync_message (session_id, seq, id, organization_id, runtime_id, project_id, user_id, type, data,
            time_created, time_updated, time_synced)
          VALUES ('ses_a', 1, 'msg_user', ${org}, 'layer-a', 'prj_1', ${idOf("9301")}, 'user', ${{ type: "user", text: "hello" }}::jsonb,
            ${start}, ${start}, ${start})`
        await sql`INSERT INTO session_sync_message (session_id, seq, id, organization_id, runtime_id, project_id, type, data,
            time_created, time_updated, time_synced, cost, tokens_input, model)
          VALUES ('ses_x', 1, 'msg_x', ${other.id}, 'layer-a', 'prj_x', 'assistant', ${{ type: "assistant" }}::jsonb, ${start}, ${start}, ${start}, 99, 1, 'openai/gpt')`
      })

      const range = { from: start, to: start + 3 * DAY, groupBy: "user" as const }

      // An admin sees the organization as a whole.
      const all = yield* identity.usage(admin.sessionID, org, range)
      expect(all.totals).toMatchObject({ cost: 2, calls: 3, sessions: 2, users: 2, tokensInput: 300, tokensOutput: 150 })
      expect(all.days).toEqual([
        { day: "2026-01-10", cost: 0.75, tokens: 332, calls: 2 },
        { day: "2026-01-11", cost: 1.25, tokens: 166, calls: 1 },
      ])
      expect(all.groups.map((group) => [group.label, group.cost])).toEqual([
        ["9301", 1.75],
        ["9302", 0.25],
      ])
      // Days break where the reader's day does.
      const east = yield* identity.usage(admin.sessionID, org, { ...range, tzOffset: 480 })
      expect(east.days.map((day) => [day.day, day.calls])).toEqual([
        ["2026-01-10", 1],
        ["2026-01-11", 2],
      ])

      const byModel = yield* identity.usage(admin.sessionID, org, { ...range, groupBy: "model" })
      expect(byModel.groups.map((group) => [group.key, group.cost])).toEqual([
        ["anthropic/sonnet", 1.25],
        ["openai/gpt", 0.75],
      ])
      const byProject = yield* identity.usage(admin.sessionID, org, { ...range, groupBy: "project" })
      expect(byProject.groups.map((group) => [group.key, group.label])).toEqual([
        ["prj_1", "Launch"],
        ["prj_2", "prj_2"],
      ])
      const bySession = yield* identity.usage(admin.sessionID, org, { ...range, groupBy: "session" })
      expect(bySession.groups.map((group) => [group.label, group.calls])).toEqual([
        ["Plan the launch", 2],
        ["Fix the build", 1],
      ])
      const filtered = yield* identity.usage(admin.sessionID, org, { ...range, model: "openai/gpt", userID: idOf("9302") })
      expect(filtered.totals).toMatchObject({ cost: 0.25, calls: 1 })
      // The range is half open.
      expect((yield* identity.usage(admin.sessionID, org, { ...range, to: start + 2000 })).totals.calls).toBe(0)
      expect((yield* identity.usage(admin.sessionID, org, { ...range, to: start + 2001 })).totals.calls).toBe(1)

      // An organization admin sees everyone; a member sees only themselves, whatever they ask for.
      expect((yield* identity.usage(orgAdmin.sessionID, org, range)).totals.calls).toBe(3)
      const own = yield* identity.usage(member.sessionID, org, { ...range, userID: idOf("9301") })
      expect(own.totals).toMatchObject({ cost: 0.25, calls: 1, users: 1 })
      expect(own.groups.map((group) => group.label)).toEqual(["9302"])

      // Someone outside the organization is refused, and so is a range that is empty or too long.
      expect((yield* identity.usage(stranger.sessionID, org, range).pipe(Effect.flip)).reason).toBe("forbidden")
      expect((yield* identity.usage(admin.sessionID, org, { ...range, to: range.from }).pipe(Effect.flip)).reason).toBe("invalid")
      expect((yield* identity.usage(admin.sessionID, org, { ...range, to: range.from + 400 * DAY }).pipe(Effect.flip)).reason).toBe("invalid")

      // Sessions: search by title, and a member sees only theirs.
      const found = yield* identity.usageSessions(admin.sessionID, org, { from: start, to: start + DAY, search: "BUILD" })
      expect(found.items.map((item) => [item.id, item.holder, item.project])).toEqual([["ses_b", "9302", "prj_2"]])
      expect((yield* identity.usageSessions(admin.sessionID, org, { from: start, to: start + DAY })).total).toBe(2)
      const mine = yield* identity.usageSessions(member.sessionID, org, { from: start, to: start + DAY })
      expect(mine.items.map((item) => item.id)).toEqual(["ses_b"])

      // Messages: in order, with the sender; a member cannot read a session that is not theirs.
      const messages = yield* identity.usageMessages(admin.sessionID, org, "ses_a", {})
      expect(messages.map((message) => [message.seq, message.type, message.user, message.cost])).toEqual([
        [1, "user", "9301", null],
        [2, "assistant", "9301", 0.5],
        [4, "assistant", "9301", 1.25],
      ])
      expect(messages[1]!.tokens).toBe(166)
      expect((yield* identity.usageMessages(member.sessionID, org, "ses_a", {}).pipe(Effect.flip)).reason).toBe("forbidden")
      expect((yield* identity.usageMessages(member.sessionID, org, "ses_b", {})).length).toBe(1)

      // Every organization at once is for platform admins only, and keeps organizations apart.
      const orgs = yield* identity.usageOrganizations(admin.sessionID, { from: start, to: start + 3 * DAY })
      expect(orgs.map((item) => [item.name, item.cost])).toEqual([
        ["Other Co", 99],
        ["Usage Co", 2],
      ])
      expect((yield* identity.usageOrganizations(orgAdmin.sessionID, { from: start, to: start + DAY }).pipe(Effect.flip)).reason).toBe("forbidden")
      yield* Effect.promise(() => sql.close())
    }),
  )
})

// The migration adds the columns without touching the rows; the repair fills those copied before they existed. It runs
// in a database of its own.
describe.skipIf(!url)("usage columns on existing rows", () => {
  test("are filled from the copied message", async () => {
    const base = Postgres.connect(url!)
    await base.unsafe("DROP DATABASE IF EXISTS opencode_usage_backfill")
    await base.unsafe("CREATE DATABASE opencode_usage_backfill")
    await base.close()
    const sql = Postgres.connect(url!.replace(/\/[^/?]*(\?.*)?$/, "/opencode_usage_backfill$1"))
    try {
      const before = migrations.findIndex((migration) => migration.id === "identity_010")
      await Postgres.migrate(sql, migrations.slice(0, before))
      const insert = (id: string, type: string, data: unknown) => sql`
        INSERT INTO session_sync_message (session_id, seq, id, organization_id, runtime_id, type, data, time_created, time_updated, time_synced)
        VALUES ('ses_1', ${Number(id.slice(-1))}, ${id}, 'org_1', 'layer-a', ${type}, ${data}::jsonb, 1, 1, 1)`
      await insert("msg_1", "assistant", {
        cost: 0.5,
        tokens: { input: 10, output: 20, reasoning: 3, cache: { read: 4, write: 5 } },
        model: { providerID: "openai", id: "gpt" },
      })
      await insert("msg_2", "compaction", { cost: 0.1, tokens: { input: 7, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } })
      await insert("msg_3", "user", { text: "hello", cost: "not a number" })

      await Postgres.migrate(sql, migrations)
      expect((await sql`SELECT count(*)::int AS filled FROM session_sync_message WHERE cost IS NOT NULL`)[0].filled).toBe(0)
      await IdentityUsage.repair(sql)
      const rows = await sql`SELECT id, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, model
        FROM session_sync_message ORDER BY id`
      expect(rows.map((row: Record<string, unknown>) => ({ ...row }))).toEqual([
        { id: "msg_1", cost: 0.5, tokens_input: "10", tokens_output: "20", tokens_reasoning: "3", tokens_cache_read: "4", tokens_cache_write: "5", model: "openai/gpt" },
        { id: "msg_2", cost: 0.1, tokens_input: "7", tokens_output: "1", tokens_reasoning: "0", tokens_cache_read: "0", tokens_cache_write: "0", model: null },
        { id: "msg_3", cost: null, tokens_input: null, tokens_output: null, tokens_reasoning: null, tokens_cache_read: null, tokens_cache_write: null, model: null },
      ])
    } finally {
      await sql.close()
    }
  })
})

describe.skipIf(!url)("usage repair", () => {
  test("fills the usage columns of rows copied without them, in batches, and only once", async () => {
    const sql = Postgres.connect(url!)
    await sql.unsafe(`DROP TABLE IF EXISTS ${tables}`)
    await Postgres.migrate(sql, migrations)
    const message = (seq: number, type: string, data: unknown, synced = 1_000) => sql`
      INSERT INTO session_sync_message (session_id, seq, id, organization_id, runtime_id, type, data, time_created, time_updated, time_synced)
      VALUES ('ses_repair', ${seq}, ${`msg_${seq}`}, 'org_x', 'layer-a', ${type}, ${data}::jsonb, 1, 1, ${synced})`
    const usage = { cost: 0.5, tokens: { input: 10, output: 20, reasoning: 1, cache: { read: 3, write: 4 } }, model: { providerID: "p", id: "m" } }
    for (let seq = 1; seq <= 5; seq++) await message(seq, "assistant", usage)
    await message(6, "compaction", usage)
    await message(7, "user", { text: "hi", cost: 99 })
    // An assistant message whose JSON holds no usage stays empty and must not make the pass loop.
    await message(8, "assistant", { text: "no usage here", cost: "free" })
    // Copied recently, so a later pass limited to recent rows still finds it.
    await message(9, "assistant", usage, 9_000)

    // Two rows per batch: the 8 candidates need several rounds, and the pass still ends.
    expect(await IdentityUsage.repair(sql, { since: 0, batch: 2 })).toBe(8)
    const rows = await sql`SELECT seq, cost, tokens_input, tokens_cache_write, model FROM session_sync_message ORDER BY seq`
    expect(rows.slice(0, 6).map((row: Record<string, unknown>) => [Number(row.cost), Number(row.tokens_input), Number(row.tokens_cache_write), row.model])).toEqual(
      Array(6).fill([0.5, 10, 4, "p/m"]),
    )
    expect([rows[6].cost, rows[6].model, rows[7].cost, rows[7].tokens_input]).toEqual([null, null, null, null])
    expect([Number(rows[8].cost), rows[8].model]).toEqual([0.5, "p/m"])

    // A second pass has nothing new to fill (rows without usage are visited again but stay as they are).
    const unchanged = await sql`SELECT count(*)::int AS filled FROM session_sync_message WHERE cost IS NOT NULL`
    expect(await IdentityUsage.repair(sql, { since: 0, batch: 2 })).toBe(1)
    expect((await sql`SELECT count(*)::int AS filled FROM session_sync_message WHERE cost IS NOT NULL`)[0].filled).toBe(unchanged[0].filled)

    // While another layer holds the lock, this one does nothing.
    const holder = await sql.reserve()
    await holder`SELECT pg_advisory_lock(hashtext('opencode_usage_repair'))`
    expect(await IdentityUsage.repair(sql)).toBe(0)
    await holder`SELECT pg_advisory_unlock(hashtext('opencode_usage_repair'))`
    holder.release()
    await sql.unsafe(`DROP TABLE IF EXISTS ${tables}`)
    await sql.close()
  })
})

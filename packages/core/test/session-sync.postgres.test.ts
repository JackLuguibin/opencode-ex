import path from "node:path"
import os from "node:os"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Database } from "@opencode/core/database/database"
import { migrations } from "@opencode/core/identity/postgres"
import { IdentityOrganizationTable, IdentityUserTable } from "@opencode/core/identity/sql"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionSync } from "@opencode/core/session-sync"
import { SessionSyncCursorTable } from "@opencode/core/session-sync/sql"
import { SessionMessageTable, SessionTable } from "@opencode/core/session/sql"
import { eq, sql as sqlTag } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Global } from "@opencode/util/global"
import { Postgres } from "@opencode/util/postgres"
import { afterAll, describe, expect, test } from "bun:test"
import { testEffect } from "./lib/effect"

const url = process.env.OPENCODE_TEST_POSTGRES_URL

describe("redact", () => {
  test("removes credentials but keeps token counts", () => {
    expect(
      SessionSync.redact({
        apiKey: "abc",
        headers: { Authorization: "Bearer abcdefghijklmnopqrstuvwx" },
        tokens: { input: 5, output: 7 },
        text: "key sk-abcdefghijklmnopqrstuv and ghp_abcdefghijklmnopqrstuv, plain text",
        list: [{ password: "hunter2" }, "AKIAABCDEFGHIJKLMNOP"],
        empty: { secret: "" },
      }),
    ).toEqual({
      apiKey: "[redacted]",
      headers: { Authorization: "[redacted]" },
      tokens: { input: 5, output: 7 },
      text: "key [redacted] and [redacted], plain text",
      list: [{ password: "[redacted]" }, "[redacted]"],
      empty: { secret: "" },
    })
  })
})

const tables = "session_sync_project, session_sync_session, session_sync_message, identity_audit, identity_join_request, identity_preference, identity_session, identity_membership, identity_organization, identity_user, auth_migration"
const sql = url ? Postgres.connect(url) : undefined
if (sql) await sql.unsafe(`DROP TABLE IF EXISTS ${tables}`)
afterAll(async () => {
  if (!sql) return
  await sql.unsafe(`DROP TABLE IF EXISTS ${tables}`)
  await sql.close()
})

const data = path.join(os.tmpdir(), "opencode-ex-session-sync")
const it = testEffect(
  Database.layerFromClient.pipe(
    Layer.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })),
    Layer.provide(Global.layerWith({ data })),
  ),
)

describe.skipIf(!url)("session sync", () => {
  it.effect("copies sessions and messages once, sends only what changed, and skips organizations that opted out", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* Effect.promise(() => Postgres.migrate(sql!, migrations))
      yield* Effect.promise(async () => {
        await sql!`INSERT INTO identity_organization (id, name, time_created, time_updated) VALUES ('org_on', 'On', 1, 1)`
        await sql!`INSERT INTO identity_organization (id, name, session_sync, time_created, time_updated) VALUES ('org_off', 'Off', false, 1, 1)`
      })
      yield* db.insert(IdentityOrganizationTable).values([{ id: "org_on", name: "On" }, { id: "org_off", name: "Off" }]).run()
      yield* db
        .insert(ProjectTable)
        .values([
          { id: "prj_on" as never, worktree: AbsolutePath.make("/tmp/sync-on"), sandboxes: [], organization_id: "org_on", time_updated: 1_000 },
          { id: "prj_off" as never, worktree: AbsolutePath.make("/tmp/sync-off"), sandboxes: [], organization_id: "org_off", time_updated: 1_000 },
        ])
        .run()
      const session = (id: string, project: string) => ({
        id: id as never,
        project_id: project as never,
        slug: id,
        directory: "/project" as never,
        title: id,
        version: "test",
        cost: 0.5,
        tokens_input: 10,
        time_created: 1_000,
        time_updated: 1_000,
      })
      yield* db.insert(SessionTable).values([session("ses_on", "prj_on"), session("ses_off", "prj_off")]).run()
      const message = (id: string, sessionID: string, text: string, updated: number) => ({
        id: id as never,
        session_id: sessionID as never,
        type: "user" as const,
        seq: 1,
        time_created: 1_000,
        time_updated: updated,
        data: { type: "user", text, apiKey: "secret-value", tokens: { input: 5 } } as never,
      })
      yield* db
        .insert(SessionMessageTable)
        .values([message("msg_on", "ses_on", "hello sk-abcdefghijklmnopqrstuv", 1_000), message("msg_off", "ses_off", "private", 1_000)])
        .run()

      const input = { db, sql: sql!, runtimeID: "layer-a" }
      expect(yield* SessionSync.run(input)).toEqual({ sessions: 1, messages: 1, more: false })
      const sessions = yield* Effect.promise(() => sql!`SELECT session_id, organization_id, runtime_id, cost, tokens_input::int AS tokens_input FROM session_sync_session`)
      expect(sessions.map((row: { session_id: string }) => row.session_id)).toEqual(["ses_on"])
      expect(sessions[0]).toMatchObject({ organization_id: "org_on", runtime_id: "layer-a", cost: 0.5, tokens_input: 10 })
      const copied = yield* Effect.promise(() => sql!`SELECT session_id, data FROM session_sync_message`)
      expect(copied.map((row: { session_id: string }) => row.session_id)).toEqual(["ses_on"])
      // Projects follow the same rule, keyed by layer, and messages carry their project.
      const projects = yield* Effect.promise(() => sql!`SELECT runtime_id, project_id, organization_id, worktree FROM session_sync_project`)
      expect(projects).toEqual([{ runtime_id: "layer-a", project_id: "prj_on", organization_id: "org_on", worktree: "/tmp/sync-on" }])
      expect((yield* Effect.promise(() => sql!`SELECT project_id FROM session_sync_message`))[0].project_id).toBe("prj_on")
      expect(copied[0].data).toEqual({ type: "user", text: "hello [redacted]", apiKey: "[redacted]", tokens: { input: 5 } })

      // Nothing changed, so nothing is sent.
      expect(yield* SessionSync.run(input)).toEqual({ sessions: 0, messages: 0, more: false })

      // A message that is updated in place is sent again and replaces its copy; its session goes with it, because a
      // session's cost and tokens change without its own stamp moving.
      yield* db
        .update(SessionMessageTable)
        .set({ time_updated: 2_000, data: { type: "user", text: "edited" } as never })
        .where(eq(SessionMessageTable.id, "msg_on" as never))
        .run()
      expect(yield* SessionSync.run(input)).toEqual({ sessions: 1, messages: 1, more: false })
      const after = yield* Effect.promise(() => sql!`SELECT data FROM session_sync_message WHERE session_id = 'ses_on'`)
      expect(after.map((row: { data: unknown }) => row.data)).toEqual([{ type: "user", text: "edited" }])
    }),
  )

  it.effect("copies who sent each message, and gives an answer the sender of the prompt before it", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* Effect.promise(() => Postgres.migrate(sql!, migrations))
      yield* Effect.promise(
        () => sql!`INSERT INTO identity_organization (id, name, time_created, time_updated) VALUES ('org_sender', 'On', 1, 1)`,
      )
      yield* db.insert(IdentityOrganizationTable).values({ id: "org_sender", name: "On" }).run()
      yield* db
        .insert(IdentityUserTable)
        .values([
          { id: "usr_a", employee_id: "a", password_hash: "x", admin: false },
          { id: "usr_b", employee_id: "b", password_hash: "x", admin: false },
        ])
        .run()
      yield* db
        .insert(ProjectTable)
        .values({ id: "prj_sender" as never, worktree: AbsolutePath.make("/tmp/sync-sender"), sandboxes: [], organization_id: "org_sender", time_updated: 1_000 })
        .run()
      yield* db
        .insert(SessionTable)
        .values({
          id: "ses_sender" as never,
          project_id: "prj_sender" as never,
          slug: "ses_sender",
          directory: "/project" as never,
          title: "ses_sender",
          version: "test",
          time_created: 1_000,
          time_updated: 1_000,
        })
        .run()
      const row = (seq: number, type: "user" | "assistant", userID: string | null) => ({
        id: `msg_sender_${seq}` as never,
        session_id: "ses_sender" as never,
        type,
        seq,
        user_id: userID,
        time_created: 1_000,
        time_updated: 1_000,
        data: { type } as never,
      })
      yield* db
        .insert(SessionMessageTable)
        .values([row(1, "user", "usr_a"), row(2, "assistant", null), row(3, "user", "usr_b"), row(4, "assistant", null), row(5, "user", null)])
        .run()

      yield* SessionSync.run({ db, sql: sql!, runtimeID: "layer-a" })
      const copied = yield* Effect.promise(() => sql!`SELECT seq, user_id FROM session_sync_message WHERE session_id = 'ses_sender' ORDER BY seq`)
      // A user message keeps its own sender, empty when it has none; an answer takes the prompt before it.
      expect(copied.map((r: { seq: number; user_id: string | null }) => [r.seq, r.user_id])).toEqual([
        [1, "usr_a"],
        [2, "usr_a"],
        [3, "usr_b"],
        [4, "usr_b"],
        [5, null],
      ])
    }),
  )

  it.effect("sends a session's new cost even though the session's own stamp did not move", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* reset(db)
      yield* seed(db, { session: "ses_cost", message: "msg_cost" })
      const input = { db, sql: sql!, runtimeID: "layer-a" }
      yield* SessionSync.run(input)
      // What the projector does when a step finishes: add to the totals, keep the stamp, and rewrite the message.
      yield* db
        .update(SessionTable)
        .set({ cost: 2.5, tokens_output: 40, time_updated: sqlSelf(SessionTable.time_updated) })
        .where(eq(SessionTable.id, "ses_cost" as never))
        .run()
      yield* db
        .update(SessionMessageTable)
        .set({ time_updated: 5_000, data: { type: "assistant", cost: 2.5 } as never })
        .where(eq(SessionMessageTable.id, "msg_cost" as never))
        .run()
      yield* SessionSync.run(input)
      const copied = yield* Effect.promise(() => sql!`SELECT cost, tokens_output::int AS tokens_output FROM session_sync_session WHERE session_id = 'ses_cost'`)
      expect(copied[0]).toEqual({ cost: 2.5, tokens_output: 40 })
    }),
  )

  it.effect("leaves rows written in the last moments for the next round, so none is passed over", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* reset(db)
      yield* seed(db, { session: "ses_fresh", message: "msg_fresh", stamp: Date.now() })
      const input = { db, sql: sql!, runtimeID: "layer-a" }
      expect(yield* SessionSync.run(input)).toEqual({ sessions: 0, messages: 0, more: false })
      yield* Effect.promise(() => Bun.sleep(2_200))
      expect(yield* SessionSync.run(input)).toEqual({ sessions: 1, messages: 1, more: false })
    }),
  )

  it.effect("stores text Postgres cannot hold, and a row it refuses does not stop the rows after it", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* reset(db)
      yield* Effect.promise(
        () => sql!.unsafe(`ALTER TABLE session_sync_message ADD CONSTRAINT poison CHECK (id <> 'msg_poison')`),
      )
      yield* seed(db, { session: "ses_mixed", message: "msg_nul", text: "a\u0000b \ud800 c" })
      yield* db
        .insert(SessionMessageTable)
        .values([
          { id: "msg_poison" as never, session_id: "ses_mixed" as never, type: "user", seq: 2, time_created: 1_000, time_updated: 1_001, data: { type: "user", text: "x" } as never },
          { id: "msg_after" as never, session_id: "ses_mixed" as never, type: "user", seq: 3, time_created: 1_000, time_updated: 1_002, data: { type: "user", text: "y" } as never },
        ])
        .run()
      const input = { db, sql: sql!, runtimeID: "layer-a" }
      expect(yield* SessionSync.run(input)).toMatchObject({ messages: 2 })
      const copied = yield* Effect.promise(() => sql!`SELECT id, data FROM session_sync_message ORDER BY seq`)
      expect(copied.map((row: { id: string }) => row.id)).toEqual(["msg_nul", "msg_after"])
      expect(copied[0].data.text).toBe("ab \ufffd c")
      // The refused row was passed over, so the next round has nothing left to send and does not retry it forever.
      expect(yield* SessionSync.run(input)).toMatchObject({ messages: 0 })
      yield* Effect.promise(() => sql!.unsafe(`ALTER TABLE session_sync_message DROP CONSTRAINT poison`))
    }),
  )

  it.effect("reports a backlog past one round's cap so the caller comes back soon", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* reset(db)
      yield* seed(db, { session: "ses_backlog", message: "msg_000000" })
      const rows = Array.from({ length: 5_200 }, (_, index) => ({
        id: `msg_b${String(index).padStart(6, "0")}` as never,
        session_id: "ses_backlog" as never,
        type: "user" as const,
        seq: index + 10,
        time_created: 1_000,
        time_updated: 1_001 + index,
        data: { type: "user", text: "x" } as never,
      }))
      for (let at = 0; at < rows.length; at += 500) yield* db.insert(SessionMessageTable).values(rows.slice(at, at + 500)).run()
      const input = { db, sql: sql!, runtimeID: "layer-a" }
      expect(yield* SessionSync.run(input)).toMatchObject({ messages: 5_000, more: true })
      expect(yield* SessionSync.run(input)).toMatchObject({ messages: 201, more: false })
    }),
  )

  it.effect("keeps the cursor where it was when Postgres cannot be reached", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* reset(db)
      yield* seed(db, { session: "ses_down", message: "msg_down" })
      const broken = Postgres.connect("postgres://opencode:opencode@127.0.0.1:1/none")
      const failed = yield* SessionSync.run({ db, sql: broken, runtimeID: "layer-a" }).pipe(Effect.exit)
      expect(failed._tag).toBe("Failure")
      yield* Effect.promise(() => broken.close().catch(() => undefined))
      expect(yield* SessionSync.run({ db, sql: sql!, runtimeID: "layer-a" })).toEqual({ sessions: 1, messages: 1, more: false })
    }),
  )
})

const sqlSelf = (column: typeof SessionTable.time_updated) => sqlTag`${column}`

// One organization that copies, one project and one session with one message.
const seed = (
  db: Database.Interface["db"],
  input: { session: string; message: string; stamp?: number; text?: string },
) =>
  Effect.gen(function* () {
    const stamp = input.stamp ?? 1_000
    yield* db
      .insert(ProjectTable)
      .values({ id: `prj_${input.session}` as never, worktree: AbsolutePath.make(`/tmp/${input.session}`), sandboxes: [], organization_id: "org_on" })
      .run()
    yield* db
      .insert(SessionTable)
      .values({ id: input.session as never, project_id: `prj_${input.session}` as never, slug: input.session, directory: "/project" as never, version: "test", time_created: stamp, time_updated: stamp })
      .run()
    yield* db
      .insert(SessionMessageTable)
      .values({ id: input.message as never, session_id: input.session as never, type: "user", seq: 1, time_created: stamp, time_updated: stamp, data: { type: "user", text: input.text ?? "hello" } as never })
      .run()
  })

// Empties both databases and leaves one organization that copies.
const reset = (db: Database.Interface["db"]) =>
  Effect.gen(function* () {
    yield* db.delete(SessionMessageTable).run()
    yield* db.delete(SessionTable).run()
    yield* db.delete(ProjectTable).run()
    yield* db.delete(SessionSyncCursorTable).run()
    yield* db.insert(IdentityOrganizationTable).values({ id: "org_on", name: "On" }).onConflictDoNothing().run()
    yield* Effect.promise(async () => {
      await sql!`DELETE FROM session_sync_message`
      await sql!`DELETE FROM session_sync_session`
      await sql!`DELETE FROM session_sync_project`
      await sql!`INSERT INTO identity_organization (id, name, time_created, time_updated) VALUES ('org_on', 'On', 1, 1) ON CONFLICT DO NOTHING`
    })
  })

export * as Postgres from "./postgres.js"

import { SQL } from "bun"

export type Migration = { readonly id: string; readonly sql: string }

export function connect(url: string) {
  return new SQL(url)
}

// Migrations run in id order, each in its own transaction. An advisory lock serializes concurrent starters so two Auth
// servers booting together apply every migration exactly once.
export async function migrate(db: SQL, migrations: readonly Migration[]) {
  await db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('opencode_auth_migration'))`
    await tx`CREATE TABLE IF NOT EXISTS auth_migration (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`
    const applied = new Set((await tx`SELECT id FROM auth_migration`).map((row: { id: string }) => row.id))
    for (const migration of [...migrations].sort((a, b) => a.id.localeCompare(b.id))) {
      if (applied.has(migration.id)) continue
      await tx.unsafe(migration.sql)
      await tx`INSERT INTO auth_migration (id) VALUES (${migration.id})`
    }
  })
}

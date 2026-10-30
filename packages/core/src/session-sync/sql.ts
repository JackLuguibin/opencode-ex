import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

/**
 * How far this execution layer has copied its sessions and messages to the shared Postgres: the last `(time, id)` it
 * sent, one row per kind (`session`, `message`). Kept beside the data it describes, so restoring an older database also
 * restores an older cursor and the missing rows are sent again.
 */
export const SessionSyncCursorTable = sqliteTable("session_sync_cursor", {
  kind: text().primaryKey(),
  time: integer().notNull(),
  id: text().notNull(),
})

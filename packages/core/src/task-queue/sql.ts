import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { TaskQueue } from "@opencode/schema/task-queue"
import { Timestamps } from "../database/schema.sql.js"
import type { SessionSchema } from "../session/schema.js"
import { SessionTable } from "../session/sql.js"

export const TaskQueueTable = sqliteTable("task_queue", {
  id: text().$type<TaskQueue.ID>().primaryKey(),
  name: text().notNull(),
  mode: text().$type<TaskQueue.Mode>().notNull(),
  /** The Session a `session` queue hands its items to. */
  session_id: text()
    .$type<SessionSchema.ID>()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  /** Where a `spawn` queue starts each new Session. */
  directory: text(),
  capacity: integer().notNull(),
  concurrency: integer().notNull(),
  status: text().$type<TaskQueue.Status>().notNull().default("active"),
  /** The member who made the queue. Sessions it spawns run as them. */
  user_id: text(),
  /** The organization the creator was working in. */
  organization_id: text(),
  ...Timestamps,
})

export const TaskQueueItemTable = sqliteTable(
  "task_queue_item",
  {
    id: text().$type<TaskQueue.ItemID>().primaryKey(),
    queue_id: text()
      .$type<TaskQueue.ID>()
      .notNull()
      .references(() => TaskQueueTable.id, { onDelete: "cascade" }),
    prompt: text().notNull(),
    status: text().$type<TaskQueue.ItemStatus>().notNull().default("pending"),
    /** The Session handling the item, set when it starts. */
    session_id: text().$type<SessionSchema.ID>(),
    error: text(),
    time_started: integer(),
    time_finished: integer(),
    ...Timestamps,
  },
  (table) => [index("task_queue_item_queue_status_idx").on(table.queue_id, table.status, table.time_created)],
)

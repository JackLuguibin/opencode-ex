import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261106171016_task_queue",
  up(tx) {
    return Effect.gen(function* () {
      // An earlier draft of this migration shipped under another id, and development databases that ran it keep its
      // empty tables (without `user_id`). Nothing else ever wrote to them, so replace rather than fail on them.
      yield* tx.run(`DROP TABLE IF EXISTS \`task_queue_item\`;`)
      yield* tx.run(`DROP TABLE IF EXISTS \`task_queue\`;`)
      yield* tx.run(`
        CREATE TABLE \`task_queue_item\` (
          \`id\` text PRIMARY KEY,
          \`queue_id\` text NOT NULL,
          \`prompt\` text NOT NULL,
          \`status\` text DEFAULT 'pending' NOT NULL,
          \`session_id\` text,
          \`error\` text,
          \`time_started\` integer,
          \`time_finished\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_task_queue_item_queue_id_task_queue_id_fk\` FOREIGN KEY (\`queue_id\`) REFERENCES \`task_queue\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`task_queue\` (
          \`id\` text PRIMARY KEY,
          \`name\` text NOT NULL,
          \`mode\` text NOT NULL,
          \`session_id\` text,
          \`directory\` text,
          \`capacity\` integer NOT NULL,
          \`concurrency\` integer NOT NULL,
          \`status\` text DEFAULT 'active' NOT NULL,
          \`user_id\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_task_queue_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`task_queue_item_queue_status_idx\` ON \`task_queue_item\` (\`queue_id\`,\`status\`,\`time_created\`);`,
      )
    })
  },
}

export default migration

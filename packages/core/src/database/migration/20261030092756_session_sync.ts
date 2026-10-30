import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261030092756_session_sync",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_sync_cursor\` (
          \`kind\` text PRIMARY KEY,
          \`time\` integer NOT NULL,
          \`id\` text NOT NULL
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`session_message_time_updated_idx\` ON \`session_message\` (\`time_updated\`,\`id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`session_v2_time_updated_idx\` ON \`session_v2\` (\`time_updated\`,\`id\`);`)
    })
  },
}

export default migration

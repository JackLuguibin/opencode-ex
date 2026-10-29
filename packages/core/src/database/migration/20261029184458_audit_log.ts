import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261029184458_audit_log",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`identity_audit\` (
          \`id\` text PRIMARY KEY,
          \`actor\` text NOT NULL,
          \`action\` text NOT NULL,
          \`target\` text,
          \`detail\` text,
          \`time_created\` integer NOT NULL
        );
      `)
    })
  },
}

export default migration

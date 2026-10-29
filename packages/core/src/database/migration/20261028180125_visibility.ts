import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261028180125_visibility",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`project\` ADD \`visibility\` text DEFAULT 'organization' NOT NULL;`)
      yield* tx.run(
        `ALTER TABLE \`session_user\` ADD \`created_by_user_id\` text REFERENCES identity_user(id) ON DELETE SET NULL;`,
      )
      yield* tx.run(`ALTER TABLE \`session_user\` ADD \`visibility\` text DEFAULT 'organization' NOT NULL;`)
    })
  },
}

export default migration

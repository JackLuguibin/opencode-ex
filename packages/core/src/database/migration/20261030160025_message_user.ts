import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261030160025_message_user",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        `ALTER TABLE \`session_inbox\` ADD \`user_id\` text REFERENCES identity_user(id) ON DELETE SET NULL;`,
      )
      yield* tx.run(
        `ALTER TABLE \`session_message\` ADD \`user_id\` text REFERENCES identity_user(id) ON DELETE SET NULL;`,
      )
    })
  },
}

export default migration

import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261028095339_membership_role",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`identity_membership\` ADD \`role\` text DEFAULT 'member' NOT NULL;`)
    })
  },
}

export default migration

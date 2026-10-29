import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261029180345_user_name",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`identity_user\` ADD \`name\` text;`)
    })
  },
}

export default migration

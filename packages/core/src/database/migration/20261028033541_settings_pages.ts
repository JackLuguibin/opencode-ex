import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261028033541_settings_pages",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`identity_organization\` ADD \`settings_pages\` text;`)
    })
  },
}

export default migration

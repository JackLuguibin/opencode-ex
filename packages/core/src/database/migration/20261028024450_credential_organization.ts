import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261028024450_credential_organization",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        `ALTER TABLE \`credential\` ADD \`organization_id\` text REFERENCES identity_organization(id) ON DELETE CASCADE;`,
      )
    })
  },
}

export default migration

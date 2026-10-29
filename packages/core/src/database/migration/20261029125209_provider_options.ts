import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261029125209_provider_options",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`custom_provider\` ADD \`headers\` text;`)
      yield* tx.run(`ALTER TABLE \`custom_provider\` ADD \`model_names\` text;`)
      yield* tx.run(`ALTER TABLE \`personal_provider\` ADD \`headers\` text;`)
      yield* tx.run(`ALTER TABLE \`personal_provider\` ADD \`model_names\` text;`)
    })
  },
}

export default migration

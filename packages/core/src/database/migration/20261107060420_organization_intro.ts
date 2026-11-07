import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261107060420_organization_intro",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`identity_organization\` ADD \`intro\` text;`)
    })
  },
}

export default migration

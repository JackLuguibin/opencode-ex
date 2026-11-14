import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261108164903_global_provider",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`global_provider\` (
          \`id\` text PRIMARY KEY,
          \`name\` text NOT NULL,
          \`base_url\` text NOT NULL,
          \`models\` text NOT NULL,
          \`headers\` text,
          \`model_names\` text,
          \`key\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
    })
  },
}

export default migration

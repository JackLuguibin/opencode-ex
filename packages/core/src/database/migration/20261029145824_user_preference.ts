import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261029145824_user_preference",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`identity_preference\` (
          \`user_id\` text NOT NULL,
          \`organization_id\` text NOT NULL,
          \`key\` text NOT NULL,
          \`value\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`identity_preference_pk\` PRIMARY KEY(\`user_id\`, \`organization_id\`, \`key\`),
          CONSTRAINT \`fk_identity_preference_user_id_identity_user_id_fk\` FOREIGN KEY (\`user_id\`) REFERENCES \`identity_user\`(\`id\`) ON DELETE CASCADE
        );
      `)
    })
  },
}

export default migration

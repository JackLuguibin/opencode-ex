import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261029181308_join_request",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`identity_join_request\` (
          \`id\` text PRIMARY KEY,
          \`user_id\` text NOT NULL,
          \`organization_id\` text NOT NULL,
          \`note\` text,
          \`status\` text NOT NULL,
          \`decided_by_user_id\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_identity_join_request_user_id_identity_user_id_fk\` FOREIGN KEY (\`user_id\`) REFERENCES \`identity_user\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_identity_join_request_organization_id_identity_organization_id_fk\` FOREIGN KEY (\`organization_id\`) REFERENCES \`identity_organization\`(\`id\`) ON DELETE CASCADE
        );
      `)
    })
  },
}

export default migration

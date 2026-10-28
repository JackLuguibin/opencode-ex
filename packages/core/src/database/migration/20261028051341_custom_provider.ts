import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261028051341_custom_provider",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`custom_provider\` (
          \`organization_id\` text NOT NULL,
          \`id\` text NOT NULL,
          \`name\` text NOT NULL,
          \`base_url\` text NOT NULL,
          \`models\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`custom_provider_pk\` PRIMARY KEY(\`organization_id\`, \`id\`),
          CONSTRAINT \`fk_custom_provider_organization_id_identity_organization_id_fk\` FOREIGN KEY (\`organization_id\`) REFERENCES \`identity_organization\`(\`id\`) ON DELETE CASCADE
        );
      `)
    })
  },
}

export default migration

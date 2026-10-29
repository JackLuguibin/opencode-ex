import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261029121327_personal_models",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`model_preference\` (
          \`user_id\` text NOT NULL,
          \`organization_id\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`provider_id\` text NOT NULL,
          \`model_id\` text NOT NULL,
          \`variant\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`model_preference_pk\` PRIMARY KEY(\`user_id\`, \`organization_id\`, \`kind\`, \`provider_id\`, \`model_id\`),
          CONSTRAINT \`fk_model_preference_user_id_identity_user_id_fk\` FOREIGN KEY (\`user_id\`) REFERENCES \`identity_user\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_model_preference_organization_id_identity_organization_id_fk\` FOREIGN KEY (\`organization_id\`) REFERENCES \`identity_organization\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`personal_provider\` (
          \`organization_id\` text NOT NULL,
          \`user_id\` text NOT NULL,
          \`id\` text NOT NULL,
          \`name\` text NOT NULL,
          \`base_url\` text NOT NULL,
          \`models\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`personal_provider_pk\` PRIMARY KEY(\`organization_id\`, \`user_id\`, \`id\`),
          CONSTRAINT \`fk_personal_provider_organization_id_identity_organization_id_fk\` FOREIGN KEY (\`organization_id\`) REFERENCES \`identity_organization\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_personal_provider_user_id_identity_user_id_fk\` FOREIGN KEY (\`user_id\`) REFERENCES \`identity_user\`(\`id\`) ON DELETE CASCADE
        );
      `)
    })
  },
}

export default migration

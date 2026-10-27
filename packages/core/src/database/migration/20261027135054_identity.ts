import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261027135054_identity",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`identity_membership\` (
          \`organization_id\` text NOT NULL,
          \`user_id\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`identity_membership_pk\` PRIMARY KEY(\`organization_id\`, \`user_id\`),
          CONSTRAINT \`fk_identity_membership_organization_id_identity_organization_id_fk\` FOREIGN KEY (\`organization_id\`) REFERENCES \`identity_organization\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_identity_membership_user_id_identity_user_id_fk\` FOREIGN KEY (\`user_id\`) REFERENCES \`identity_user\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`identity_organization\` (
          \`id\` text PRIMARY KEY,
          \`name\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`identity_session\` (
          \`id\` text PRIMARY KEY,
          \`token_hash\` text NOT NULL UNIQUE,
          \`user_id\` text NOT NULL,
          \`organization_id\` text,
          \`expires_at\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_identity_session_user_id_identity_user_id_fk\` FOREIGN KEY (\`user_id\`) REFERENCES \`identity_user\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_identity_session_organization_id_identity_organization_id_fk\` FOREIGN KEY (\`organization_id\`) REFERENCES \`identity_organization\`(\`id\`) ON DELETE SET NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`identity_user\` (
          \`id\` text PRIMARY KEY,
          \`employee_id\` text NOT NULL UNIQUE,
          \`password_hash\` text NOT NULL,
          \`admin\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(
        `ALTER TABLE \`project\` ADD \`organization_id\` text REFERENCES identity_organization(id) ON DELETE SET NULL;`,
      )
      yield* tx.run(
        `ALTER TABLE \`project\` ADD \`created_by_user_id\` text REFERENCES identity_user(id) ON DELETE SET NULL;`,
      )
    })
  },
}

export default migration

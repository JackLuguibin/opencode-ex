import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

// Model references kept before shared providers took the `organization.<organizationID>.<id>` and `global.<id>`
// catalog IDs: members' default, favorite, recent, hidden and shown models, and the model each session last used.
// An organization's own provider wins over a global one of the same old ID, as it did in the catalog.
const migration: DatabaseMigration.Migration = {
  id: "20261109100000_shared_provider_refs",
  up(tx) {
    return Effect.gen(function* () {
      // Preferences: a row that would collide with one already under the new ID is dropped.
      yield* tx.run(`
        UPDATE OR IGNORE \`model_preference\`
        SET \`provider_id\` = 'organization.' || \`organization_id\` || '.' || \`provider_id\`
        WHERE EXISTS (
          SELECT 1 FROM \`custom_provider\` AS cp
          WHERE cp.\`organization_id\` = \`model_preference\`.\`organization_id\` AND cp.\`id\` = \`model_preference\`.\`provider_id\`
        );
      `)
      yield* tx.run(`
        DELETE FROM \`model_preference\`
        WHERE EXISTS (
          SELECT 1 FROM \`custom_provider\` AS cp
          WHERE cp.\`organization_id\` = \`model_preference\`.\`organization_id\` AND cp.\`id\` = \`model_preference\`.\`provider_id\`
        );
      `)
      yield* tx.run(`
        UPDATE OR IGNORE \`model_preference\`
        SET \`provider_id\` = 'global.' || \`provider_id\`
        WHERE \`provider_id\` IN (SELECT \`id\` FROM \`global_provider\`);
      `)
      yield* tx.run(`
        DELETE FROM \`model_preference\` WHERE \`provider_id\` IN (SELECT \`id\` FROM \`global_provider\`);
      `)
      // Sessions: their organization is their project's.
      yield* tx.run(`
        UPDATE \`session_v2\`
        SET \`model\` = json_set(\`model\`, '$.providerID',
          'organization.' || (SELECT p.\`organization_id\` FROM \`project\` AS p WHERE p.\`id\` = \`session_v2\`.\`project_id\`)
            || '.' || json_extract(\`model\`, '$.providerID'))
        WHERE \`model\` IS NOT NULL AND EXISTS (
          SELECT 1 FROM \`project\` AS p
          JOIN \`custom_provider\` AS cp ON cp.\`organization_id\` = p.\`organization_id\`
          WHERE p.\`id\` = \`session_v2\`.\`project_id\` AND cp.\`id\` = json_extract(\`session_v2\`.\`model\`, '$.providerID')
        );
      `)
      yield* tx.run(`
        UPDATE \`session_v2\`
        SET \`model\` = json_set(\`model\`, '$.providerID', 'global.' || json_extract(\`model\`, '$.providerID'))
        WHERE \`model\` IS NOT NULL
          AND json_extract(\`model\`, '$.providerID') IN (SELECT \`id\` FROM \`global_provider\`);
      `)
    })
  },
}

export default migration

import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

// An organization's own providers moved to `organization.<organizationID>.<id>` in the catalog, so the keys stored for
// them (the organization's and members' own) follow under the same integration ID.
const migration: DatabaseMigration.Migration = {
  id: "20261109090000_shared_provider_ids",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        UPDATE \`credential\`
        SET \`integration_id\` = 'organization.' || \`organization_id\` || '.' || \`integration_id\`
        WHERE \`organization_id\` IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM \`custom_provider\`
            WHERE \`custom_provider\`.\`organization_id\` = \`credential\`.\`organization_id\`
              AND \`custom_provider\`.\`id\` = \`credential\`.\`integration_id\`
          );
      `)
    })
  },
}

export default migration

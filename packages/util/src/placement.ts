export * as Placement from "./placement.js"

import type { RedisClient, SQL } from "bun"
import type { Migration } from "./postgres.js"

// Which execution layer holds an organization's projects, sessions and files. It is a durable fact: losing it leaves
// the data on a layer nothing points to, so it lives in Postgres with the accounts instead of in Redis with the leases.
export const migrations: ReadonlyArray<Migration> = [
  {
    id: "placement_001",
    sql: `
      CREATE TABLE organization_placement (
        organization_id text PRIMARY KEY,
        runtime_id text NOT NULL,
        time_created bigint NOT NULL
      );
    `,
  },
]

export type Store = {
  /** The layer an organization was placed on, if it has been placed. */
  readonly get: (organizationID: string) => Promise<string | undefined>
  /** Places an organization on `runtimeID` unless it is already placed; returns the layer that holds it either way. */
  readonly claim: (organizationID: string, runtimeID: string) => Promise<string>
  /** How many organizations each layer holds. */
  readonly counts: () => Promise<Map<string, number>>
  /** Forgets where a deleted organization was placed. */
  readonly release: (organizationID: string) => Promise<void>
}

export function make(sql: SQL): Store {
  return {
    get: async (organizationID) =>
      (await sql`SELECT runtime_id FROM organization_placement WHERE organization_id = ${organizationID}`)[0]?.runtime_id,
    // Two gateways can race to place the same organization; the first insert wins and both read it back.
    claim: async (organizationID, runtimeID) => {
      await sql`
        INSERT INTO organization_placement (organization_id, runtime_id, time_created)
        VALUES (${organizationID}, ${runtimeID}, ${Date.now()})
        ON CONFLICT (organization_id) DO NOTHING`
      return (await sql`SELECT runtime_id FROM organization_placement WHERE organization_id = ${organizationID}`)[0]
        .runtime_id as string
    },
    counts: async () =>
      new Map(
        (await sql`SELECT runtime_id, count(*)::int AS held FROM organization_placement GROUP BY runtime_id`).map(
          (row: { runtime_id: string; held: number }) => [row.runtime_id, row.held] as const,
        ),
      ),
    release: async (organizationID) => {
      await sql`DELETE FROM organization_placement WHERE organization_id = ${organizationID}`
    },
  }
}

const LEGACY = "organization-runtime"

/**
 * Placements used to be a Redis hash. Copies them into Postgres once and sets the hash aside under another name, so a
 * later start cannot bring back an organization that was released after the copy. Returns how many were copied.
 */
export async function importLegacy(sql: SQL, redis: RedisClient) {
  if (!(await redis.exists(LEGACY))) return 0
  const legacy = (await redis.hgetall(LEGACY)) as Record<string, string> | null
  const entries = Object.entries(legacy ?? {})
  await sql.begin(async (tx) => {
    for (const [organizationID, runtimeID] of entries)
      await tx`
        INSERT INTO organization_placement (organization_id, runtime_id, time_created)
        VALUES (${organizationID}, ${runtimeID}, ${Date.now()})
        ON CONFLICT (organization_id) DO NOTHING`
  })
  await redis.rename(LEGACY, `${LEGACY}:imported`).catch(() => undefined)
  return entries.length
}

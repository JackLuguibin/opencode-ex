export * as Pgvector from "./pgvector.js"

import { SQL } from "bun"
import type { Interface } from "./store.js"

/** pgvector, one table per collection so each can have its own dimension and HNSW index. The `vector` extension must be installed. */
export function make(input: { readonly url: string }): Interface {
  const db = new SQL(input.url)
  const table = (collection: string) => `knowledge_vec_${collection.replaceAll(/[^A-Za-z0-9_]/g, "_").toLowerCase()}`
  const literal = (vec: Float32Array) => `[${Array.from(vec).join(",")}]`

  return {
    type: "pgvector",
    ensure: async (collection, { dim }) => {
      const name = table(collection)
      await db.unsafe("CREATE EXTENSION IF NOT EXISTS vector")
      await db.unsafe(`CREATE TABLE IF NOT EXISTS ${name} (id text PRIMARY KEY, embedding vector(${Math.trunc(dim)}) NOT NULL)`)
      await db.unsafe(`CREATE INDEX IF NOT EXISTS ${name}_hnsw ON ${name} USING hnsw (embedding vector_cosine_ops)`)
    },
    upsert: async (collection, items) => {
      const name = table(collection)
      await db.begin(async (tx) => {
        for (const item of items)
          await tx.unsafe(
            `INSERT INTO ${name} (id, embedding) VALUES ($1, $2::vector) ON CONFLICT (id) DO UPDATE SET embedding = EXCLUDED.embedding`,
            [item.id, literal(item.vec)],
          )
      })
    },
    remove: async (collection, ids) => {
      if (ids.length === 0) return
      await db.unsafe(`DELETE FROM ${table(collection)} WHERE id = ANY($1)`, [ids])
    },
    drop: async (collection) => {
      await db.unsafe(`DROP TABLE IF EXISTS ${table(collection)}`)
    },
    search: async (collection, vec, limit) => {
      const rows = (await db.unsafe(
        `SELECT id, 1 - (embedding <=> $1::vector) AS score FROM ${table(collection)} ORDER BY embedding <=> $1::vector LIMIT $2`,
        [literal(vec), limit],
      )) as ReadonlyArray<{ id: string; score: number }>
      return rows.map((row) => ({ id: row.id, score: Number(row.score) }))
    },
    health: async () => db.unsafe("SELECT 1").then(() => true, () => false),
  }
}

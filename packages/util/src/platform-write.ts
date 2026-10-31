export * as PlatformWrite from "./platform-write.js"

import type { SQL } from "bun"
import type { Migration } from "./postgres.js"

// Writes to platform settings (config, plugin updates, well-known integrations) go to every execution layer, but a layer
// that was offline or failed one is left behind. The gateway keeps each of them here, in order, so it can replay what a
// layer missed. Durable, like placements: Redis only holds each layer's position in it.
export const migrations: ReadonlyArray<Migration> = [
  {
    id: "platform_write_001",
    sql: `
      CREATE TABLE platform_write_log (
        seq bigserial PRIMARY KEY,
        method text NOT NULL,
        path text NOT NULL,
        search text NOT NULL,
        content_type text,
        body bytea NOT NULL,
        actor jsonb NOT NULL,
        accepted boolean NOT NULL DEFAULT false,
        time_created bigint NOT NULL
      );
    `,
  },
]

export type Entry = {
  readonly seq: number
  readonly method: string
  readonly path: string
  readonly search: string
  readonly contentType: string | undefined
  readonly body: Uint8Array
  readonly actor: unknown
}

/** Entries kept at least; older ones go once they are also older than `RETAIN_MS`. */
export const RETAIN = 1_000
export const RETAIN_MS = 30 * 24 * 60 * 60 * 1000

export type Store = {
  /** Writes the request down before it is sent, and returns its place in the log. */
  readonly append: (entry: Omit<Entry, "seq">) => Promise<number>
  /** Marks the write as one at least one layer took; a write every layer refused never counts. */
  readonly accept: (seq: number) => Promise<void>
  /** Forgets a write no layer took. */
  readonly discard: (seq: number) => Promise<void>
  /** The accepted write just before `seq`, or 0. */
  readonly before: (seq: number) => Promise<number>
  /** The newest accepted write, or 0. */
  readonly latest: () => Promise<number>
  /** Accepted writes after `seq`, oldest first. */
  readonly after: (seq: number, limit: number) => Promise<ReadonlyArray<Entry>>
  /** Drops the entries nothing needs any more; returns the newest seq dropped, or 0 when nothing went. */
  readonly trim: () => Promise<number>
}

export function make(sql: SQL): Store {
  return {
    append: async (entry) =>
      Number(
        (
          await sql`
            INSERT INTO platform_write_log (method, path, search, content_type, body, actor, time_created)
            VALUES (${entry.method}, ${entry.path}, ${entry.search}, ${entry.contentType ?? null}, ${Buffer.from(entry.body)},
              ${entry.actor}::jsonb, ${Date.now()})
            RETURNING seq`
        )[0].seq,
      ),
    accept: async (seq) => {
      await sql`UPDATE platform_write_log SET accepted = true WHERE seq = ${seq}`
    },
    discard: async (seq) => {
      await sql`DELETE FROM platform_write_log WHERE seq = ${seq}`
    },
    before: async (seq) =>
      Number((await sql`SELECT COALESCE(max(seq), 0) AS seq FROM platform_write_log WHERE accepted AND seq < ${seq}`)[0].seq),
    latest: async () => Number((await sql`SELECT COALESCE(max(seq), 0) AS seq FROM platform_write_log WHERE accepted`)[0].seq),
    after: async (seq, limit) =>
      (
        await sql`
          SELECT seq, method, path, search, content_type, body, actor FROM platform_write_log
          WHERE accepted AND seq > ${seq} ORDER BY seq LIMIT ${limit}`
      ).map((row: Record<string, unknown>) => ({
        seq: Number(row.seq),
        method: String(row.method),
        path: String(row.path),
        search: String(row.search),
        contentType: (row.content_type as string | null) ?? undefined,
        body: new Uint8Array(row.body as Buffer),
        actor: row.actor,
      })),
    trim: async () => {
      const cutoff = Date.now() - RETAIN_MS
      const dropped = await sql`
        DELETE FROM platform_write_log
        WHERE time_created < ${cutoff} AND seq <= COALESCE((SELECT seq FROM platform_write_log ORDER BY seq DESC OFFSET ${RETAIN} LIMIT 1), 0)
        RETURNING seq`
      return dropped.reduce((newest: number, row: { seq: unknown }) => Math.max(newest, Number(row.seq)), 0)
    },
  }
}

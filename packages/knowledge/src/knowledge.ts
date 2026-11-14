export * as Knowledge from "./knowledge.js"

import { Database } from "bun:sqlite"
import { randomBytes } from "node:crypto"
import { statements } from "./schema.js"
import { Settings } from "./settings.js"
import { Tokenize } from "./tokenize.js"
import { Builtin } from "./vector/builtin.js"
import { Pgvector } from "./vector/pgvector.js"
import { Qdrant } from "./vector/qdrant.js"
import { VectorStore } from "./vector/store.js"

/** Who is asking. The execution layer vouches for it; this service does not authenticate people. */
export type Context = {
  readonly userID: string
  readonly admin: boolean
  readonly organizationID: string | undefined
}

export type Base = {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly entries: number
  readonly drafts: number
  readonly organizations: ReadonlyArray<string>
  readonly time: { readonly created: number; readonly updated: number }
}

export type EntryInput = {
  readonly title: string
  readonly content: string
  readonly summary?: string
  readonly aliases?: ReadonlyArray<string>
  readonly questions?: ReadonlyArray<string>
  readonly keywords?: ReadonlyArray<string>
  readonly source?: string
  readonly hash?: string
  readonly status?: "draft" | "published"
  readonly vector?: { readonly model: string; readonly values: ReadonlyArray<number> }
}

export type Entry = {
  readonly id: string
  readonly base: string
  readonly title: string
  readonly content: string
  readonly summary: string
  readonly aliases: ReadonlyArray<string>
  readonly questions: ReadonlyArray<string>
  readonly keywords: ReadonlyArray<string>
  readonly source: string
  readonly status: "draft" | "published"
  readonly hash: string
  readonly vectorModel: string | undefined
  readonly time: { readonly created: number; readonly updated: number }
}

export type Hit = {
  readonly entry: string
  readonly base: string
  readonly baseName: string
  readonly title: string
  readonly summary: string
  readonly snippet: string
  readonly source: string
  readonly score: number
  readonly channels: { readonly keyword?: number; readonly vector?: number; readonly exact?: boolean }
}

export type SearchInput = {
  readonly query: string
  readonly vector?: ReadonlyArray<number>
  /** Query vectors by searchModels key, with model IDs accepted for older callers. */
  readonly vectors?: Readonly<Record<string, ReadonlyArray<number>>>
  readonly bases?: ReadonlyArray<string>
  readonly topK?: number
}

export type SearchResult = {
  readonly hits: ReadonlyArray<Hit>
  /** What could not be used, so the caller can say the answer came from keywords only. */
  readonly degraded: ReadonlyArray<"vector">
  readonly ms: number
}

export class Failure extends Error {
  constructor(
    readonly reason: "missing" | "invalid" | "forbidden" | "conflict",
    message: string,
  ) {
    super(message)
  }
}

type EntryFilter = { readonly q?: string; readonly status?: "draft" | "published" }
type BaseRow = { id: string; name: string; description: string; settings: string; time_created: number; time_updated: number }
type EntryRow = {
  id: string
  kb_id: string
  title: string
  content: string
  summary: string
  aliases: string
  questions: string
  keywords: string
  source: string
  status: "draft" | "published"
  hash: string
  time_created: number
  time_updated: number
}

const STALE_JOB_MS = 10 * 60_000

const id = (prefix: string) => `${prefix}${randomBytes(9).toString("base64url")}`
const list = (value: string) => JSON.parse(value) as string[]

export function open(path: string) {
  const db = new Database(path, { create: true })
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA foreign_keys = ON")
  db.exec("PRAGMA synchronous = NORMAL")
  statements.forEach((statement) => db.exec(statement))
  return make(db)
}

function make(db: Database) {
  const collectionBase = new Map<string, string>()
  const stores = new Map<string, VectorStore.Interface>()

  const builtin = Builtin.make((collection) => {
    const base = collectionBase.get(collection)
    if (!base) return []
    return indexable(base, effective(baseRow(base)))
  })

  // The published vectors of a base that belong in its index. After the embedding model changes, vectors of the old model
  // have another dimension and could not be compared with a query, so only those of the configured model are used.
  const indexable = (baseID: string, settings: Settings.Value) =>
    db
      .query<{ entry_id: string; vec: Uint8Array }, [string, string]>(
        `SELECT v.entry_id, v.vec FROM entry_vec v JOIN entry e ON e.id = v.entry_id
         WHERE e.kb_id = ?1 AND e.status = 'published' AND (?2 = '' OR v.model = ?2)`,
      )
      .all(baseID, settings.vector.model)
      .map((row) => ({ id: row.entry_id, vec: VectorStore.decode(row.vec) }))

  const platform = () => {
    const row = db.query<{ value: string }, []>(`SELECT value FROM platform_setting WHERE key = 'settings'`).get()
    return row ? (JSON.parse(row.value) as Settings.Patch) : {}
  }

  const platformSettings = () => {
    const applied = Settings.apply(Settings.defaults, platform())
    return "value" in applied ? applied.value : Settings.defaults
  }

  const baseRow = (baseID: string) => {
    const row = db.query<BaseRow, [string]>(`SELECT * FROM kb WHERE id = ?`).get(baseID)
    if (!row) throw new Failure("missing", "knowledge base not found")
    return row
  }

  const effective = (row: BaseRow) => {
    const applied = Settings.apply(platformSettings(), JSON.parse(row.settings))
    return "value" in applied ? applied.value : platformSettings()
  }

  const storeFor = (settings: Settings.Value) => {
    const config = settings.vector.store
    if (config.type === "builtin") return builtin
    const key = `${config.type}|${config.url}|${config.secret}`
    const existing = stores.get(key)
    if (existing) return existing
    const created =
      config.type === "qdrant"
        ? Qdrant.make({ url: config.url, secret: config.secret, timeoutMs: settings.vector.storeTimeoutMs })
        : Pgvector.make({ url: config.url })
    stores.set(key, created)
    return created
  }

  const collection = (baseID: string, settings: Settings.Value) => {
    const name = `${settings.vector.store.collectionPrefix}${baseID.replace(/^kb_/, "")}`
    collectionBase.set(name, baseID)
    return name
  }

  // Settings decide which vectors the builtin index holds (the embedding model), so it is reloaded after they change.
  const forgetBuiltin = () => [...collectionBase.keys()].forEach((name) => void builtin.drop(name))

  const termSet = (settings: Settings.Value) => new Set(settings.terms.map((term) => term.toLowerCase()))

  const toEntry = (row: EntryRow): Entry => {
    const vector = db.query<{ model: string }, [string]>(`SELECT model FROM entry_vec WHERE entry_id = ?`).get(row.id)
    return {
      id: row.id,
      base: row.kb_id,
      title: row.title,
      content: row.content,
      summary: row.summary,
      aliases: list(row.aliases),
      questions: list(row.questions),
      keywords: list(row.keywords),
      source: row.source,
      status: row.status,
      hash: row.hash,
      vectorModel: vector?.model,
      time: { created: row.time_created, updated: row.time_updated },
    }
  }

  const reindexText = (row: EntryRow, seq: number, settings: Settings.Value) => {
    const terms = termSet(settings)
    db.query(`DELETE FROM entry_fts WHERE rowid = ?`).run(seq)
    if (row.status !== "published") return
    db.query(`INSERT INTO entry_fts (rowid, kb_id, title, aliases, questions, content, keywords) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      seq,
      row.kb_id,
      Tokenize.index(row.title, terms),
      Tokenize.index(list(row.aliases).join(" "), terms),
      Tokenize.index(list(row.questions).join(" "), terms),
      Tokenize.index(`${row.summary}\n${row.content}`, terms),
      Tokenize.index(list(row.keywords).join(" "), terms),
    )
  }

  // Custom terms decide how text is cut into words, so the keyword index of a base is rebuilt when they change.
  const retokenize = (row: BaseRow) => {
    const settings = effective(row)
    db.transaction(() =>
      db
        .query<EntryRow & { seq: number }, [string]>(`SELECT * FROM entry WHERE kb_id = ?`)
        .all(row.id)
        .forEach((entry) => reindexText(entry, entry.seq, settings)),
    )()
  }

  // The index copy of a vector is best effort: the vector itself is already saved in `entry_vec`, so a store that is down
  // is brought level again by `reindex` instead of failing the write.
  const syncVectors = async (baseID: string, add: ReadonlyArray<VectorStore.Item>, remove: ReadonlyArray<string>) => {
    const settings = effective(baseRow(baseID))
    if (!settings.vector.enabled) return true
    const store = storeFor(settings)
    const name = collection(baseID, settings)
    // Like `indexable`, a vector of another embedding model is kept in the database but not put in the index.
    const current = add.filter((item) => {
      if (settings.vector.model === "") return true
      return db.query<{ model: string }, [string]>(`SELECT model FROM entry_vec WHERE entry_id = ?`).get(item.id)?.model === settings.vector.model
    })
    const stale = add.filter((item) => !current.includes(item)).map((item) => item.id)
    return Promise.resolve()
      .then(async () => {
        if (current.length > 0) await store.ensure(name, { dim: current[0].vec.length })
        await store.upsert(name, current)
        await store.remove(name, [...remove, ...stale])
        return true
      })
      .catch(() => false)
  }

  const requireBase = (context: Context, baseID: string) => {
    const row = baseRow(baseID)
    if (context.admin) return row
    const granted = db
      .query<{ n: number }, [string, string]>(`SELECT COUNT(*) AS n FROM kb_grant WHERE kb_id = ? AND organization_id = ?`)
      .get(baseID, context.organizationID ?? "")
    if (!granted || granted.n === 0) throw new Failure("missing", "knowledge base not found")
    return row
  }

  // Members only ever see published entries; the query matches title or content literally.
  const entryFilter = (context: Context, baseID: string, input: EntryFilter) => {
    requireBase(context, baseID)
    const status = context.admin ? input.status : "published"
    const like = input.q ? `%${input.q.replaceAll(/[\\%_]/g, (char) => `\\${char}`)}%` : null
    return {
      where: `kb_id = ?1 AND (?2 IS NULL OR status = ?2) AND (?3 IS NULL OR title LIKE ?3 ESCAPE '\\' OR content LIKE ?3 ESCAPE '\\')`,
      params: [baseID, status ?? null, like] as [string, string | null, string | null],
    }
  }

  const requireAdmin = (context: Context) => {
    if (!context.admin) throw new Failure("forbidden", "only a platform administrator can change knowledge")
  }

  const summarize = (row: BaseRow, context: Context): Base => {
    const counts = db
      .query<{ status: string; n: number }, [string]>(`SELECT status, COUNT(*) AS n FROM entry WHERE kb_id = ? GROUP BY status`)
      .all(row.id)
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      entries: counts.find((count) => count.status === "published")?.n ?? 0,
      drafts: context.admin ? (counts.find((count) => count.status === "draft")?.n ?? 0) : 0,
      organizations: context.admin
        ? db.query<{ organization_id: string }, [string]>(`SELECT organization_id FROM kb_grant WHERE kb_id = ? ORDER BY organization_id`).all(row.id).map((grant) => grant.organization_id)
        : [],
      time: { created: row.time_created, updated: row.time_updated },
    }
  }

  const validateEntry = (input: EntryInput) => {
    if (input.title.trim() === "") throw new Failure("invalid", "title is required")
    if (input.content.trim() === "") throw new Failure("invalid", "content is required")
  }

  const write = async (baseID: string, input: EntryInput, existing: EntryRow | undefined) => {
    validateEntry(input)
    const row = baseRow(baseID)
    const settings = effective(row)
    const now = Date.now()
    const entryID = existing?.id ?? id("ke_")
    const next: EntryRow = {
      id: entryID,
      kb_id: baseID,
      title: input.title.trim(),
      content: input.content,
      summary: input.summary ?? existing?.summary ?? "",
      aliases: JSON.stringify(input.aliases ?? (existing ? list(existing.aliases) : [])),
      questions: JSON.stringify(input.questions ?? (existing ? list(existing.questions) : [])),
      keywords: JSON.stringify(input.keywords ?? (existing ? list(existing.keywords) : [])),
      source: input.source ?? existing?.source ?? "",
      status: input.status ?? existing?.status ?? "published",
      hash: input.hash ?? existing?.hash ?? "",
      time_created: existing?.time_created ?? now,
      time_updated: now,
    }
    const vec = input.vector
      ? VectorStore.normalize(input.vector.values)
      : undefined
    const seq = db.transaction(() => {
      if (existing) {
        db.query(
          `UPDATE entry SET title=?, content=?, summary=?, aliases=?, questions=?, keywords=?, source=?, status=?, hash=?, time_updated=? WHERE id=?`,
        ).run(next.title, next.content, next.summary, next.aliases, next.questions, next.keywords, next.source, next.status, next.hash, now, entryID)
      } else {
        db.query(
          `INSERT INTO entry (id, kb_id, title, content, summary, aliases, questions, keywords, source, status, hash, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(entryID, baseID, next.title, next.content, next.summary, next.aliases, next.questions, next.keywords, next.source, next.status, next.hash, now, now)
      }
      const found = db.query<{ seq: number }, [string]>(`SELECT seq FROM entry WHERE id = ?`).get(entryID)!.seq
      // A rewritten entry no longer matches its old vector, so a vector the caller did not resend is dropped. A change that
      // leaves the title and content alone, such as publishing a draft, keeps it.
      const rewritten = existing && (existing.title !== next.title || existing.content !== next.content)
      if (vec && input.vector) {
        db.query(`INSERT OR REPLACE INTO entry_vec (entry_id, model, dim, vec) VALUES (?, ?, ?, ?)`).run(entryID, input.vector.model, vec.length, VectorStore.encode(vec))
      } else if (rewritten) db.query(`DELETE FROM entry_vec WHERE entry_id = ?`).run(entryID)
      reindexText(next, found, settings)
      return found
    })()
    void seq
    const stored = db.query<{ vec: Uint8Array }, [string]>(`SELECT vec FROM entry_vec WHERE entry_id = ?`).get(entryID)
    const indexed =
      next.status === "published" && stored
        ? await syncVectors(baseID, [{ id: entryID, vec: VectorStore.decode(stored.vec) }], [])
        : await syncVectors(baseID, [], [entryID])
    return { entry: toEntry(db.query<EntryRow, [string]>(`SELECT * FROM entry WHERE id = ?`).get(entryID)!), indexed }
  }

  const searchable = (context: Context, bases: ReadonlyArray<string> | undefined) =>
    (context.admin
      ? db.query<BaseRow, []>(`SELECT * FROM kb`).all()
      : db
          .query<BaseRow, [string]>(`SELECT kb.* FROM kb JOIN kb_grant g ON g.kb_id = kb.id WHERE g.organization_id = ?`)
          .all(context.organizationID ?? "")
    ).filter((row) => !bases || bases.includes(row.id) || bases.includes(row.name))

  const search = async (context: Context, input: SearchInput): Promise<SearchResult> => {
    const started = performance.now()
    const visible = searchable(context, input.bases)
    const degraded = new Set<"vector">()
    const groups = await Promise.all(
      visible.map(async (row) => {
        const settings = effective(row)
        const limit = Math.max(1, Math.min(input.topK ?? settings.search.topK, 50))
        const terms = termSet(settings)
        const keyword = keywordRanks(row.id, input.query, terms, settings)
        const exact = exactMatches(row.id, input.query)
        const query = input.vectors
          ? input.vectors[JSON.stringify([settings.vector.model, settings.vector.queryPrefix, settings.vector.queryTimeoutMs])] ?? input.vectors[settings.vector.model]
          : input.vector
        const vector = await vectorRanks(row, query, settings, () => degraded.add("vector"))
        return fuse(row, input.query, terms, settings, limit, keyword, vector, exact)
      }),
    )
    const hits = groups
      .flat()
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Math.min(input.topK ?? (visible.length === 1 ? effective(visible[0]) : platformSettings()).search.topK, 50)))
    return { hits, degraded: [...degraded], ms: Math.round((performance.now() - started) * 100) / 100 }
  }

  const keywordRanks = (baseID: string, query: string, terms: ReadonlySet<string>, settings: Settings.Value) => {
    const expression = Tokenize.match(query, terms)
    if (!expression) return [] as string[]
    const weight = settings.search.weights
    return db
      .query<{ id: string }, [number, number, number, number, number, string, string]>(
        `SELECT e.id AS id FROM entry_fts JOIN entry e ON e.seq = entry_fts.rowid
         WHERE entry_fts MATCH ?6 AND entry_fts.kb_id = ?7 AND e.status = 'published'
         ORDER BY bm25(entry_fts, 0, ?1, ?2, ?3, ?4, ?5) LIMIT 50`,
      )
      .all(weight.title, weight.aliases, weight.questions, weight.content, weight.aliases, expression, baseID)
      .map((row) => row.id)
  }

  const exactMatches = (baseID: string, query: string) =>
    new Set(
      db
        .query<{ id: string }, [string, string, string]>(
          `SELECT id FROM entry WHERE kb_id = ? AND status = 'published' AND (lower(title) = lower(?)
             OR EXISTS (SELECT 1 FROM json_each(entry.aliases) WHERE lower(value) = lower(?)))`,
        )
        .all(baseID, query.trim(), query.trim())
        .map((row) => row.id),
    )

  const vectorRanks = async (
    row: BaseRow,
    vector: ReadonlyArray<number> | undefined,
    settings: Settings.Value,
    degrade: () => void,
  ) => {
    if (!settings.vector.enabled || settings.search.vectorWeight === 0) return [] as { id: string; score: number }[]
    if (!vector) {
      // The base names an embedding model but no query vector of it came: the model failed or timed out.
      if (settings.vector.model !== "") degrade()
      return []
    }
    const store = storeFor(settings)
    const found = await Promise.race([
      store.search(collection(row.id, settings), VectorStore.normalize(vector), 50),
      Bun.sleep(settings.vector.storeTimeoutMs).then(() => {
        throw new Error("vector store timed out")
      }),
    ]).catch(() => undefined)
    if (!found) {
      degrade()
      return []
    }
    return found.filter((hit) => hit.score >= settings.search.minScore)
  }

  const fuse = (
    row: BaseRow,
    query: string,
    terms: ReadonlySet<string>,
    settings: Settings.Value,
    limit: number,
    keyword: ReadonlyArray<string>,
    vector: ReadonlyArray<{ id: string; score: number }>,
    exact: ReadonlySet<string>,
  ): Hit[] => {
    const scores = new Map<string, { score: number; keyword?: number; vector?: number; exact?: boolean }>()
    const add = (entry: string, amount: number, patch: { keyword?: number; vector?: number; exact?: boolean }) =>
      scores.set(entry, { ...scores.get(entry), ...patch, score: (scores.get(entry)?.score ?? 0) + amount })
    keyword.forEach((entry, rank) => add(entry, 1 / (settings.search.rrfK + rank + 1), { keyword: rank + 1 }))
    vector.forEach((hit, rank) => add(hit.id, settings.search.vectorWeight / (settings.search.rrfK + rank + 1), { vector: rank + 1 }))
    exact.forEach((entry) => add(entry, 1, { exact: true }))
    const ranked = [...scores.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, limit)
    if (ranked.length === 0) return []
    const rows = new Map(
      db
        .query<EntryRow, string[]>(`SELECT * FROM entry WHERE status = 'published' AND id IN (${ranked.map(() => "?").join(",")})`)
        .all(...ranked.map(([entry]) => entry))
        .map((entry) => [entry.id, entry]),
    )
    const words = [...new Set(Tokenize.words(query, terms))]
    return ranked.flatMap(([entry, score]) => {
      const found = rows.get(entry)
      if (!found) return []
      return [
        {
          entry,
          base: row.id,
          baseName: row.name,
          title: found.title,
          summary: found.summary,
          snippet: snippet(found.content, words, settings.search.snippetChars),
          source: found.source,
          score: Math.round(score.score * 10_000) / 10_000,
          channels: { keyword: score.keyword, vector: score.vector, exact: score.exact },
        },
      ]
    })
  }

  return {
    search,
    /** One query vector per model, prefix and deadline used by the searched bases. */
    searchModels: (context: Context, bases: ReadonlyArray<string> | undefined) => [
      ...new Map(
        searchable(context, bases)
          .map((row) => effective(row).vector)
          .filter((vector) => vector.enabled && vector.model !== "")
          .map((vector) => {
            const key = JSON.stringify([vector.model, vector.queryPrefix, vector.queryTimeoutMs])
            return [key, { key, model: vector.model, queryPrefix: vector.queryPrefix, queryTimeoutMs: vector.queryTimeoutMs }] as const
          }),
      ).values(),
    ],
    close: () => db.close(),

    settings: {
      platform: () => Settings.redact(platformSettings()),
      patchPlatform: (context: Context, patch: unknown) => {
        requireAdmin(context)
        const merged = overlay(platform(), Settings.withoutDerived(patch))
        const applied = Settings.apply(Settings.defaults, keepSecret(merged, platform()))
        if ("error" in applied) throw new Failure("invalid", applied.error)
        const before = new Map(db.query<BaseRow, []>(`SELECT * FROM kb`).all().map((row) => [row.id, effective(row).terms.join("\n")]))
        db.query(`INSERT OR REPLACE INTO platform_setting (key, value) VALUES ('settings', ?)`).run(JSON.stringify(keepSecret(merged, platform())))
        forgetBuiltin()
        db.query<BaseRow, []>(`SELECT * FROM kb`).all().forEach((row) => {
          if (effective(row).terms.join("\n") !== before.get(row.id)) retokenize(row)
        })
        return Settings.redact(platformSettings())
      },
      // Search takes a base's name as well as its id, so its settings (and so its embedding model) can be read by either.
      base: (context: Context, baseID: string) => {
        const named = db.query<{ id: string }, [string]>(`SELECT id FROM kb WHERE name = ? ORDER BY time_created LIMIT 1`).get(baseID)
        const row = requireBase(context, db.query(`SELECT 1 FROM kb WHERE id = ?`).get(baseID) || !named ? baseID : named.id)
        return { effective: Settings.redact(effective(row)), override: Settings.redactPatch(JSON.parse(row.settings)) }
      },
      patchBase: (context: Context, baseID: string, patch: unknown) => {
        requireAdmin(context)
        const row = baseRow(baseID)
        const merged = keepSecret(overlay(JSON.parse(row.settings), Settings.withoutDerived(patch)), JSON.parse(row.settings))
        const applied = Settings.apply(platformSettings(), merged)
        if ("error" in applied) throw new Failure("invalid", applied.error)
        db.query(`UPDATE kb SET settings = ?, time_updated = ? WHERE id = ?`).run(JSON.stringify(merged), Date.now(), baseID)
        forgetBuiltin()
        if (applied.value.terms.join("\n") !== effective(row).terms.join("\n")) retokenize(baseRow(baseID))
        return { effective: Settings.redact(applied.value), override: Settings.redactPatch(merged as Settings.Patch) }
      },
      /** The vector store a patch would use, for the admin page's connection test. */
      testStore: async (context: Context, patch: unknown) => {
        requireAdmin(context)
        const applied = Settings.apply(platformSettings(), Settings.withoutDerived(patch))
        if ("error" in applied) throw new Failure("invalid", applied.error)
        const started = performance.now()
        const ok = await storeFor(applied.value).health()
        return { ok, ms: Math.round(performance.now() - started) }
      },
    },

    bases: {
      list: (context: Context) =>
        (context.admin
          ? db.query<BaseRow, []>(`SELECT * FROM kb ORDER BY name`).all()
          : db
              .query<BaseRow, [string]>(`SELECT kb.* FROM kb JOIN kb_grant g ON g.kb_id = kb.id WHERE g.organization_id = ? ORDER BY kb.name`)
              .all(context.organizationID ?? "")
        ).map((row) => summarize(row, context)),
      get: (context: Context, baseID: string) => summarize(requireBase(context, baseID), context),
      create: (context: Context, input: { readonly name: string; readonly description?: string }) => {
        requireAdmin(context)
        if (input.name.trim() === "") throw new Failure("invalid", "name is required")
        const now = Date.now()
        const created = id("kb_")
        db.query(`INSERT INTO kb (id, name, description, settings, time_created, time_updated) VALUES (?, ?, ?, '{}', ?, ?)`).run(created, input.name.trim(), input.description ?? "", now, now)
        return summarize(baseRow(created), context)
      },
      update: (context: Context, baseID: string, input: { readonly name?: string; readonly description?: string }) => {
        requireAdmin(context)
        const row = baseRow(baseID)
        if (input.name !== undefined && input.name.trim() === "") throw new Failure("invalid", "name is required")
        db.query(`UPDATE kb SET name = ?, description = ?, time_updated = ? WHERE id = ?`).run(input.name?.trim() ?? row.name, input.description ?? row.description, Date.now(), baseID)
        return summarize(baseRow(baseID), context)
      },
      remove: async (context: Context, baseID: string) => {
        requireAdmin(context)
        const row = baseRow(baseID)
        const settings = effective(row)
        db.transaction(() => {
          db.query(`DELETE FROM entry_fts WHERE kb_id = ?`).run(baseID)
          db.query(`DELETE FROM kb WHERE id = ?`).run(baseID)
        })()
        await storeFor(settings).drop(collection(baseID, settings)).catch(() => undefined)
      },
      grant: (context: Context, baseID: string, organizations: ReadonlyArray<string>) => {
        requireAdmin(context)
        baseRow(baseID)
        db.transaction(() => {
          db.query(`DELETE FROM kb_grant WHERE kb_id = ?`).run(baseID)
          new Set(organizations).forEach((organization) => db.query(`INSERT INTO kb_grant (kb_id, organization_id) VALUES (?, ?)`).run(baseID, organization))
        })()
        return summarize(baseRow(baseID), context)
      },
      /** Removes an organization from every grant, for when the organization is deleted. */
      revoke: (context: Context, organizationID: string) => {
        requireAdmin(context)
        db.query(`DELETE FROM kb_grant WHERE organization_id = ?`).run(organizationID)
      },
      stats: (context: Context, baseID: string) => {
        requireAdmin(context)
        baseRow(baseID)
        const counts = db
          .query<{ published: number; drafts: number; vectors: number }, [string]>(
            `SELECT SUM(status = 'published') AS published, SUM(status = 'draft') AS drafts,
                    (SELECT COUNT(*) FROM entry_vec v JOIN entry e ON e.id = v.entry_id WHERE e.kb_id = ?1 AND e.status = 'published') AS vectors
             FROM entry WHERE kb_id = ?1`,
          )
          .get(baseID)!
        const models = db
          .query<{ model: string; n: number }, [string]>(`SELECT v.model AS model, COUNT(*) AS n FROM entry_vec v JOIN entry e ON e.id = v.entry_id WHERE e.kb_id = ? GROUP BY v.model`)
          .all(baseID)
        return { published: counts.published ?? 0, drafts: counts.drafts ?? 0, vectors: counts.vectors ?? 0, models }
      },
    },

    entries: {
      list: (context: Context, baseID: string, input: EntryFilter & { readonly limit?: number; readonly offset?: number }) => {
        const filter = entryFilter(context, baseID, input)
        return db
          .query<EntryRow, [string, string | null, string | null, number, number]>(
            `SELECT * FROM entry WHERE ${filter.where} ORDER BY time_updated DESC, seq DESC LIMIT ?4 OFFSET ?5`,
          )
          .all(...filter.params, Math.max(1, Math.min(input.limit || 50, 200)), Math.max(0, input.offset || 0))
          .map(toEntry)
      },
      /** How many entries `list` would page through with the same filter. */
      count: (context: Context, baseID: string, input: EntryFilter) => {
        const filter = entryFilter(context, baseID, input)
        const row = db
          .query<{ total: number }, [string, string | null, string | null]>(`SELECT COUNT(*) AS total FROM entry WHERE ${filter.where}`)
          .get(...filter.params)
        return { total: row?.total ?? 0 }
      },
      get: (context: Context, entryID: string) => {
        const row = db.query<EntryRow, [string]>(`SELECT * FROM entry WHERE id = ?`).get(entryID)
        if (!row) throw new Failure("missing", "entry not found")
        requireBase(context, row.kb_id)
        if (!context.admin && row.status !== "published") throw new Failure("missing", "entry not found")
        return toEntry(row)
      },
      create: async (context: Context, baseID: string, inputs: ReadonlyArray<EntryInput>) => {
        requireAdmin(context)
        baseRow(baseID)
        // Checked before anything is written, so a batch with one bad entry saves none instead of half of them.
        inputs.forEach(validateEntry)
        return inputs.reduce(
          async (done, input) => [...(await done), await write(baseID, input, undefined)],
          Promise.resolve([] as Awaited<ReturnType<typeof write>>[]),
        )
      },
      update: async (context: Context, entryID: string, input: Partial<EntryInput>) => {
        requireAdmin(context)
        const row = db.query<EntryRow, [string]>(`SELECT * FROM entry WHERE id = ?`).get(entryID)
        if (!row) throw new Failure("missing", "entry not found")
        // Fields the caller left out arrive as undefined and must not replace the stored title or content.
        const given = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))
        return write(row.kb_id, { title: row.title, content: row.content, ...given }, row)
      },
      remove: async (context: Context, entryID: string) => {
        requireAdmin(context)
        const row = db.query<{ seq: number; kb_id: string }, [string]>(`SELECT seq, kb_id FROM entry WHERE id = ?`).get(entryID)
        if (!row) throw new Failure("missing", "entry not found")
        db.transaction(() => {
          db.query(`DELETE FROM entry_fts WHERE rowid = ?`).run(row.seq)
          db.query(`DELETE FROM entry WHERE id = ?`).run(entryID)
        })()
        await syncVectors(row.kb_id, [], [entryID])
      },
      /** Moves drafts to published (or back), so they start or stop being found. */
      setStatus: async (context: Context, baseID: string, ids: ReadonlyArray<string> | undefined, status: "draft" | "published") => {
        requireAdmin(context)
        const settings = effective(baseRow(baseID))
        const rows = (ids
          ? db.query<EntryRow, string[]>(`SELECT * FROM entry WHERE kb_id = ? AND id IN (${ids.map(() => "?").join(",")})`).all(baseID, ...ids)
          : db.query<EntryRow, [string, string]>(`SELECT * FROM entry WHERE kb_id = ? AND status != ?`).all(baseID, status))
        db.transaction(() => {
          rows.forEach((row) => {
            db.query(`UPDATE entry SET status = ?, time_updated = ? WHERE id = ?`).run(status, Date.now(), row.id)
            reindexText({ ...row, status }, db.query<{ seq: number }, [string]>(`SELECT seq FROM entry WHERE id = ?`).get(row.id)!.seq, settings)
          })
        })()
        const vectors = rows.flatMap((row) => {
          const stored = db.query<{ vec: Uint8Array }, [string]>(`SELECT vec FROM entry_vec WHERE entry_id = ?`).get(row.id)
          return stored ? [{ id: row.id, vec: VectorStore.decode(stored.vec) }] : []
        })
        await (status === "published" ? syncVectors(baseID, vectors, []) : syncVectors(baseID, [], rows.map((row) => row.id)))
        return rows.length
      },
      /** The source hashes already imported, so a re-import skips sections that did not change. */
      hashes: (context: Context, baseID: string) => {
        requireAdmin(context)
        return db.query<{ hash: string }, [string]>(`SELECT DISTINCT hash FROM entry WHERE kb_id = ? AND hash != ''`).all(baseID).map((row) => row.hash)
      },
    },

    /** Rebuilds the vector store for a base from the vectors saved in the database, for a changed store or after an outage. */
    reindex: async (context: Context, baseID: string) => {
      requireAdmin(context)
      const settings = effective(baseRow(baseID))
      const store = storeFor(settings)
      const name = collection(baseID, settings)
      const items = indexable(baseID, settings)
      // Dropped even when nothing is left to index, so vectors of entries unpublished or deleted during an outage go too.
      await store.drop(name)
      if (items.length === 0) return { indexed: 0 }
      await store.ensure(name, { dim: items[0].vec.length })
      await Array.from({ length: Math.ceil(items.length / 500) }, (_, index) => items.slice(index * 500, index * 500 + 500)).reduce(
        (done, batch) => done.then(() => store.upsert(name, batch)),
        Promise.resolve(),
      )
      return { indexed: items.length }
    },

    jobs: {
      create: (context: Context, baseID: string, total: number) => {
        requireAdmin(context)
        baseRow(baseID)
        const now = Date.now()
        // Two imports at once would both convert the sections neither has written yet, and save them twice. A job that
        // has not moved for a while is taken to have died with its layer, so it does not block the base for good.
        const running = db
          .query<{ id: string }, [string, number]>(`SELECT id FROM import_job WHERE kb_id = ? AND status = 'running' AND time_updated > ?`)
          .get(baseID, now - STALE_JOB_MS)
        if (running) throw new Failure("conflict", "an import into this knowledge base is still running")
        const created = id("kj_")
        db.query(`INSERT INTO import_job (id, kb_id, status, total, done, error, time_created, time_updated) VALUES (?, ?, 'running', ?, 0, '', ?, ?)`).run(created, baseID, total, now, now)
        return created
      },
      update: (context: Context, jobID: string, patch: { readonly status?: "running" | "done" | "failed"; readonly done?: number; readonly total?: number; readonly error?: string }) => {
        requireAdmin(context)
        const row = db.query<{ id: string }, [string]>(`SELECT id FROM import_job WHERE id = ?`).get(jobID)
        if (!row) throw new Failure("missing", "job not found")
        db.query(
          `UPDATE import_job SET status = COALESCE(?, status), done = COALESCE(?, done), total = COALESCE(?, total), error = COALESCE(?, error), time_updated = ? WHERE id = ?`,
        ).run(patch.status ?? null, patch.done ?? null, patch.total ?? null, patch.error ?? null, Date.now(), jobID)
      },
      get: (context: Context, jobID: string) => {
        requireAdmin(context)
        const job = db
          .query<{ id: string; kb_id: string; status: string; total: number; done: number; error: string; time_updated: number }, [string]>(`SELECT * FROM import_job WHERE id = ?`)
          .get(jobID)
        if (!job) throw new Failure("missing", "job not found")
        return { id: job.id, base: job.kb_id, status: job.status, total: job.total, done: job.done, error: job.error, updated: job.time_updated }
      },
    },

    evaluation: {
      addCase: (context: Context, baseID: string, input: { readonly question: string; readonly expected: string }) => {
        requireAdmin(context)
        baseRow(baseID)
        if (input.question.trim() === "") throw new Failure("invalid", "question is required")
        const expected = db.query<{ id: string }, [string, string]>(`SELECT id FROM entry WHERE id = ? AND kb_id = ?`).get(input.expected, baseID)
        if (!expected) throw new Failure("invalid", "expected entry is not in this knowledge base")
        const created = id("kc_")
        db.query(`INSERT INTO eval_case (id, kb_id, question, expected_entry_id) VALUES (?, ?, ?, ?)`).run(created, baseID, input.question.trim(), input.expected)
        return created
      },
      removeCase: (context: Context, caseID: string) => {
        requireAdmin(context)
        db.query(`DELETE FROM eval_case WHERE id = ?`).run(caseID)
      },
      cases: (context: Context, baseID: string) => {
        requireAdmin(context)
        return db
          .query<{ id: string; question: string; expected_entry_id: string }, [string]>(`SELECT id, question, expected_entry_id FROM eval_case WHERE kb_id = ?`)
          .all(baseID)
          .map((row) => ({ id: row.id, question: row.question, expected: row.expected_entry_id }))
      },
      runs: (context: Context, baseID: string) => {
        requireAdmin(context)
        return db
          .query<{ id: string; cases: number; recall_at_5: number; p50_ms: number; time_created: number }, [string]>(
            `SELECT id, cases, recall_at_5, p50_ms, time_created FROM eval_run WHERE kb_id = ? ORDER BY time_created DESC LIMIT 20`,
          )
          .all(baseID)
          .map((row) => ({ id: row.id, cases: row.cases, recall: row.recall_at_5, p50: row.p50_ms, time: row.time_created }))
      },
      /** Runs every case through search; `vectors` holds each case's query vector when the caller could compute them. */
      run: async (context: Context, baseID: string, vectors: Readonly<Record<string, ReadonlyArray<number>>>) => {
        requireAdmin(context)
        const row = baseRow(baseID)
        const cases = db
          .query<{ id: string; question: string; expected_entry_id: string }, [string]>(`SELECT id, question, expected_entry_id FROM eval_case WHERE kb_id = ?`)
          .all(baseID)
        if (cases.length === 0) throw new Failure("invalid", "add at least one case first")
        const results = await cases.reduce(
          async (done, item) => {
            const found = await search(context, { query: item.question, vector: vectors[item.id], bases: [baseID], topK: 5 })
            return [...(await done), { hit: found.hits.some((hit) => hit.entry === item.expected_entry_id), ms: found.ms }]
          },
          Promise.resolve([] as { hit: boolean; ms: number }[]),
        )
        const recall = results.filter((result) => result.hit).length / results.length
        const times = results.map((result) => result.ms).sort((a, b) => a - b)
        const p50 = times[Math.floor(times.length / 2)]
        const runID = id("kr_")
        db.query(`INSERT INTO eval_run (id, kb_id, settings, cases, recall_at_5, p50_ms, time_created) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(runID, baseID, JSON.stringify(Settings.redact(effective(row))), results.length, recall, p50, Date.now())
        return { id: runID, cases: results.length, recall, p50 }
      },
    },
  }
}

export type Service = ReturnType<typeof make>

/** Deep-merges `patch` over `base`; a list or a value in `patch` replaces the one in `base`. */
function overlay(base: unknown, patch: unknown): Settings.Patch {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) return (patch ?? base) as Settings.Patch
  const left = (typeof base === "object" && base !== null && !Array.isArray(base) ? base : {}) as Record<string, unknown>
  const right = patch as Record<string, unknown>
  return Object.fromEntries(
    [...new Set([...Object.keys(left), ...Object.keys(right)])].map((key) => [
      key,
      key in right ? (typeof right[key] === "object" && right[key] !== null && !Array.isArray(right[key]) ? overlay(left[key], right[key]) : right[key]) : left[key],
    ]),
  )
}

// A patch that leaves the secret out keeps the one already stored.
function keepSecret(merged: unknown, previous: unknown) {
  const secret = (previous as { vector?: { store?: { secret?: string } } })?.vector?.store?.secret
  const target = merged as { vector?: { store?: { secret?: string } } }
  if (secret === undefined || target.vector?.store === undefined || target.vector.store.secret !== undefined) return merged
  return { ...target, vector: { ...target.vector, store: { ...target.vector.store, secret } } }
}

// A window of the text around the first query word it contains, so the answer shows where the match is.
function snippet(content: string, words: ReadonlyArray<string>, limit: number) {
  if (content.length <= limit) return content
  const lower = content.toLowerCase()
  const at = words.map((word) => lower.indexOf(word)).filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? 0
  const start = Math.max(0, Math.min(at - Math.floor(limit / 4), content.length - limit))
  return `${start > 0 ? "…" : ""}${content.slice(start, start + limit)}${start + limit < content.length ? "…" : ""}`
}

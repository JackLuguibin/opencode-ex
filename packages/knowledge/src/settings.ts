export * as Settings from "./settings.js"

export type Store = {
  readonly type: "builtin" | "pgvector" | "qdrant"
  readonly url: string
  readonly collectionPrefix: string
  readonly secret: string
}

export type Value = {
  readonly vector: {
    readonly enabled: boolean
    readonly model: string
    /** Text some embedding models want before a question or a document, such as `query: ` and `passage: `. */
    readonly queryPrefix: string
    readonly documentPrefix: string
    readonly store: Store
    readonly queryTimeoutMs: number
    readonly storeTimeoutMs: number
  }
  readonly search: {
    readonly topK: number
    readonly snippetChars: number
    readonly weights: { readonly title: number; readonly aliases: number; readonly questions: number; readonly content: number }
    readonly vectorWeight: number
    readonly rrfK: number
    readonly minScore: number
  }
  readonly enhance: { readonly expand: boolean; readonly rerank: boolean; readonly cacheSeconds: number }
  readonly import: {
    readonly model: string
    readonly chunkChars: number
    readonly overlap: number
    readonly concurrency: number
    readonly aliases: boolean
    readonly questions: boolean
    readonly summary: boolean
    readonly review: boolean
  }
  readonly terms: ReadonlyArray<string>
}

export const defaults: Value = {
  vector: {
    enabled: true,
    model: "",
    queryPrefix: "",
    documentPrefix: "",
    store: { type: "builtin", url: "", collectionPrefix: "kb_", secret: "" },
    queryTimeoutMs: 1500,
    storeTimeoutMs: 800,
  },
  search: {
    topK: 5,
    snippetChars: 1500,
    weights: { title: 10, aliases: 6, questions: 4, content: 1 },
    vectorWeight: 1,
    rrfK: 60,
    minScore: 0,
  },
  enhance: { expand: false, rerank: false, cacheSeconds: 0 },
  import: { model: "", chunkChars: 3000, overlap: 200, concurrency: 3, aliases: true, questions: true, summary: true, review: true },
  terms: [],
}

type Rule = { readonly min: number; readonly max: number; readonly integer?: boolean }

// Every number a caller can set, with the range it must stay in; anything outside is refused rather than clamped.
const ranges: Record<string, Rule> = {
  "vector.queryTimeoutMs": { min: 100, max: 30_000, integer: true },
  "vector.storeTimeoutMs": { min: 100, max: 30_000, integer: true },
  "search.topK": { min: 1, max: 50, integer: true },
  "search.snippetChars": { min: 100, max: 8_000, integer: true },
  "search.weights.title": { min: 0, max: 100 },
  "search.weights.aliases": { min: 0, max: 100 },
  "search.weights.questions": { min: 0, max: 100 },
  "search.weights.content": { min: 0, max: 100 },
  "search.vectorWeight": { min: 0, max: 10 },
  "search.rrfK": { min: 1, max: 1_000, integer: true },
  "search.minScore": { min: -1, max: 1 },
  "enhance.cacheSeconds": { min: 0, max: 86_400, integer: true },
  "import.chunkChars": { min: 500, max: 20_000, integer: true },
  "import.overlap": { min: 0, max: 2_000, integer: true },
  "import.concurrency": { min: 1, max: 16, integer: true },
}

const storeTypes = new Set(["builtin", "pgvector", "qdrant"])

export type Patch = { readonly [key: string]: unknown }

/** Overlays `patch` on `base`, refusing unknown keys, wrong types and numbers outside their range. */
export function apply(base: Value, patch: unknown): { readonly value: Value } | { readonly error: string } {
  const errors: string[] = []
  const merged = merge(base, patch, "", errors) as Value
  if (errors.length > 0) return { error: errors[0] }
  if (!storeTypes.has(merged.vector.store.type)) return { error: "vector.store.type is not supported" }
  if (merged.import.overlap >= merged.import.chunkChars) return { error: "import.overlap must be smaller than import.chunkChars" }
  return { value: merged }
}

function merge(base: unknown, patch: unknown, path: string, errors: string[]): unknown {
  if (patch === undefined) return base
  if (Array.isArray(base)) {
    if (!Array.isArray(patch) || patch.some((item) => typeof item !== "string")) return fail(errors, path, "must be a list of text")
    return patch.map((item: string) => item.trim()).filter((item) => item.length > 0)
  }
  if (typeof base === "object" && base !== null) {
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) return fail(errors, path, "must be an object", base)
    const input = patch as Record<string, unknown>
    const known = new Set(Object.keys(base))
    Object.keys(input).forEach((key) => {
      if (!known.has(key)) errors.push(`${path ? `${path}.` : ""}${key} is not a setting`)
    })
    return Object.fromEntries(
      Object.entries(base).map(([key, current]) => [key, merge(current, input[key], path ? `${path}.${key}` : key, errors)]),
    )
  }
  if (typeof base === "number") {
    if (typeof patch !== "number" || !Number.isFinite(patch)) return fail(errors, path, "must be a number", base)
    const rule = ranges[path]
    if (rule && (patch < rule.min || patch > rule.max)) return fail(errors, path, `must be between ${rule.min} and ${rule.max}`, base)
    if (rule?.integer && !Number.isInteger(patch)) return fail(errors, path, "must be a whole number", base)
    return patch
  }
  if (typeof patch !== typeof base) return fail(errors, path, `must be ${typeof base}`, base)
  return patch
}

function fail(errors: string[], path: string, message: string, keep?: unknown) {
  errors.push(`${path} ${message}`)
  return keep
}

/** The settings as the admin page may see them: the secret is replaced by whether one is set. */
export function redact(value: Value) {
  const { secret, ...store } = value.vector.store
  return { ...value, vector: { ...value.vector, store: { ...store, hasSecret: secret.length > 0 } } }
}

/**
 * Clears secrets from a patch that came back from `redact`: `hasSecret` is not a setting, and an empty or missing `secret`
 * keeps the stored one.
 */
export function withoutDerived(patch: unknown): unknown {
  if (typeof patch !== "object" || patch === null) return patch
  const vector = (patch as { vector?: { store?: Record<string, unknown> } }).vector
  if (!vector?.store) return patch
  const { hasSecret: _ignored, ...store } = vector.store
  if (store.secret === "" || store.secret === undefined) delete store.secret
  return { ...patch, vector: { ...vector, store } }
}

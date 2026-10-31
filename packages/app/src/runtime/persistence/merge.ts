type Json = unknown

const isRecord = (value: Json): value is Record<string, Json> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function same(a: Json, b: Json): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => same(item, b[index]))
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a)
    return keys.length === Object.keys(b).length && keys.every((key) => key in b && same(a[key], b[key]))
  }
  return false
}

function mergeValue(base: Json, mine: Json, theirs: Json): Json {
  // Whoever did not change it takes the other's value; when both did, objects are merged key by key and anything else
  // (a primitive, an array) is the writer's own.
  if (same(mine, base)) return theirs
  if (same(theirs, base) || same(mine, theirs)) return mine
  if (!isRecord(mine) || !isRecord(theirs)) return mine
  const original = isRecord(base) ? base : {}
  return Object.fromEntries(
    [...new Set([...Object.keys(original), ...Object.keys(mine), ...Object.keys(theirs)])].flatMap((key) => {
      const merged = mergeValue(original[key], mine[key], theirs[key])
      return merged === undefined ? [] : [[key, merged] as const]
    }),
  )
}

/**
 * Folds this client's change into what another client saved meanwhile. `base` is the value this client last read or
 * saved, `mine` its new value, `theirs` what is stored now. Fields only one side changed keep that change; a field both
 * changed takes this client's value. Values that are not JSON cannot be merged, so this client's value stands.
 */
export function mergePreference(base: string | null, mine: string, theirs: string | null) {
  if (theirs === null) return mine
  const parsed = [base, mine, theirs].map((value) => {
    if (value === null) return { value: undefined }
    try {
      return { value: JSON.parse(value) as Json }
    } catch {
      return undefined
    }
  })
  if (parsed.some((item) => item === undefined)) return mine
  const [b, m, t] = parsed.map((item) => item!.value)
  const merged = mergeValue(b, m, t)
  return merged === undefined ? mine : JSON.stringify(merged)
}

/**
 * Saves `mine` so it lands on top of what the server holds. `seen` is the value this client's own copy is derived from
 * and `server` what the server last held as far as it knows; when they differ, another browser's change is folded in
 * first. A save the server refuses because it moved on is merged again against the value it reports, up to `attempts`
 * times. `value` is what was sent, which is what the server holds once `saved`.
 */
export async function savePreference(input: {
  readonly seen: string | null
  readonly server: string | null
  readonly mine: string
  readonly attempts: number
  readonly put: (value: string, base: string | null) => Promise<{ saved: boolean; current: string | null }>
}) {
  let server = input.server
  for (let attempt = 0; attempt < input.attempts; attempt++) {
    const value = server === input.seen ? input.mine : mergePreference(input.seen, input.mine, server)
    const result = await input.put(value, server)
    if (result.saved) return { saved: true as const, value, server: value }
    server = result.current
  }
  return { saved: false as const, server }
}

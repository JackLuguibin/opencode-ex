export * as ReplayGuard from "./replay-guard"

export interface Interface {
  /** True when this id was seen before; otherwise remembers it until `exp` (seconds since the epoch). */
  readonly seen: (id: string, exp: number, now?: number) => boolean
}

/**
 * Remembers recently accepted gateway headers. Headers live for 60 seconds, so entries expire quickly and the table
 * stays small; the capacity only bounds memory if something floods the layer, dropping the oldest first.
 */
export function make(capacity = 100_000): Interface {
  const entries = new Map<string, number>()
  return {
    seen(id, exp, now = Date.now()) {
      // Insertion order is expiry order because every header has the same lifetime.
      for (const [key, expires] of entries) {
        if (expires * 1000 > now) break
        entries.delete(key)
      }
      if (entries.has(id)) return true
      entries.set(id, exp)
      if (entries.size > capacity) entries.delete(entries.keys().next().value!)
      return false
    },
  }
}

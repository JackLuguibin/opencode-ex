export * as Builtin from "./builtin.js"

import type { Hit, Interface, Item } from "./store.js"

type Collection = { dim: number; ids: string[]; rows: Int8Array[]; slot: Map<string, number> }

const SCALE = 127

/**
 * Exact search over every vector of a collection held in memory as int8 (a quarter of the size of float32, and close
 * enough in ranking that scores stay within about a percent). `load` fills a collection the first time it is used.
 */
export function make(load: (collection: string) => Iterable<Item>): Interface {
  const collections = new Map<string, Collection>()

  const open = (name: string) => {
    const existing = collections.get(name)
    if (existing) return existing
    const created: Collection = { dim: 0, ids: [], rows: [], slot: new Map() }
    collections.set(name, created)
    for (const item of load(name)) put(created, item)
    return created
  }

  return {
    type: "builtin",
    ensure: async (collection, input) => {
      const target = open(collection)
      if (target.dim !== 0 && target.dim !== input.dim) throw new Error(`collection ${collection} holds ${target.dim}-dimensional vectors`)
      target.dim = input.dim
    },
    upsert: async (collection, items) => {
      const target = open(collection)
      items.forEach((item) => put(target, item))
    },
    remove: async (collection, ids) => {
      const target = open(collection)
      ids.forEach((id) => take(target, id))
    },
    drop: async (collection) => {
      collections.delete(collection)
    },
    search: async (collection, vec, limit) => {
      const target = open(collection)
      if (target.rows.length === 0 || vec.length !== target.dim) return []
      const query = quantize(vec)
      const scores = target.rows.map((row, index) => ({ index, score: dot(query, row) / (SCALE * SCALE) }))
      return scores
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((hit): Hit => ({ id: target.ids[hit.index], score: hit.score }))
    },
    health: async () => true,
  }
}

function put(target: Collection, item: Item) {
  if (target.dim === 0) target.dim = item.vec.length
  if (item.vec.length !== target.dim) throw new Error(`expected ${target.dim} dimensions, got ${item.vec.length}`)
  const row = quantize(item.vec)
  const at = target.slot.get(item.id)
  if (at !== undefined) return void (target.rows[at] = row)
  target.slot.set(item.id, target.ids.length)
  target.ids.push(item.id)
  target.rows.push(row)
}

// Swaps the last row into the freed slot so removal stays constant time.
function take(target: Collection, id: string) {
  const at = target.slot.get(id)
  if (at === undefined) return
  const last = target.ids.length - 1
  if (at !== last) {
    target.ids[at] = target.ids[last]
    target.rows[at] = target.rows[last]
    target.slot.set(target.ids[at], at)
  }
  target.ids.pop()
  target.rows.pop()
  target.slot.delete(id)
}

function quantize(vec: Float32Array) {
  return Int8Array.from(vec, (value) => Math.max(-SCALE, Math.min(SCALE, Math.round(value * SCALE))))
}

function dot(a: Int8Array, b: Int8Array) {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i]
  return sum
}

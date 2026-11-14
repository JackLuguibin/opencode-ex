export * as Qdrant from "./qdrant.js"

import { createHash } from "node:crypto"
import type { Interface } from "./store.js"

/** Qdrant over its REST API. Point ids must be numbers or UUIDs, so an entry id is mapped to a stable UUID. */
export function make(input: { readonly url: string; readonly secret: string; readonly timeoutMs: number }): Interface {
  const base = input.url.replace(/\/+$/, "")
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(input.secret ? { "api-key": input.secret } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(input.timeoutMs),
    })
    if (response.status === 404) return undefined
    if (!response.ok) throw new Error(`Qdrant answered ${response.status}`)
    return (await response.json()) as { result?: unknown }
  }
  const point = (id: string) => {
    const hex = createHash("sha1").update(id).digest("hex")
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
  }

  return {
    type: "qdrant",
    ensure: async (collection, { dim }) => {
      const found = (await call("GET", `/collections/${encodeURIComponent(collection)}`))?.result as
        | { config?: { params?: { vectors?: { size?: number } } } }
        | undefined
      const size = found?.config?.params?.vectors?.size
      if (size !== undefined && size !== dim) throw new Error(`collection ${collection} holds ${size}-dimensional vectors`)
      if (found) return
      await call("PUT", `/collections/${encodeURIComponent(collection)}`, { vectors: { size: dim, distance: "Cosine" } })
    },
    upsert: async (collection, items) => {
      if (items.length === 0) return
      await call("PUT", `/collections/${encodeURIComponent(collection)}/points?wait=true`, {
        points: items.map((item) => ({ id: point(item.id), vector: Array.from(item.vec), payload: { entry: item.id } })),
      })
    },
    remove: async (collection, ids) => {
      if (ids.length === 0) return
      await call("POST", `/collections/${encodeURIComponent(collection)}/points/delete?wait=true`, { points: ids.map(point) })
    },
    drop: async (collection) => {
      await call("DELETE", `/collections/${encodeURIComponent(collection)}`)
    },
    search: async (collection, vec, limit) => {
      const found = (await call("POST", `/collections/${encodeURIComponent(collection)}/points/search`, {
        vector: Array.from(vec),
        limit,
        with_payload: true,
      }))?.result as ReadonlyArray<{ score: number; payload?: { entry?: string } }> | undefined
      return (found ?? []).flatMap((hit) => (hit.payload?.entry ? [{ id: hit.payload.entry, score: hit.score }] : []))
    },
    health: async () => (await call("GET", "/collections").then(() => true, () => false)),
  }
}

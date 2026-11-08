export * as VectorStore from "./store.js"

export type Hit = { readonly id: string; readonly score: number }
export type Item = { readonly id: string; readonly vec: Float32Array }

/**
 * Where entry vectors are searched. Vectors are always kept in the knowledge database as well, so an implementation is
 * an index that can be rebuilt from there; `upsert` must be idempotent by id.
 */
export interface Interface {
  readonly type: string
  ensure(collection: string, input: { readonly dim: number }): Promise<void>
  upsert(collection: string, items: ReadonlyArray<Item>): Promise<void>
  remove(collection: string, ids: ReadonlyArray<string>): Promise<void>
  drop(collection: string): Promise<void>
  search(collection: string, vec: Float32Array, limit: number): Promise<ReadonlyArray<Hit>>
  health(): Promise<boolean>
}

/** Scales a vector to unit length so a dot product is its cosine similarity. */
export function normalize(vec: ArrayLike<number>) {
  const out = Float32Array.from(vec)
  const length = Math.hypot(...out)
  return length === 0 ? out : out.map((value) => value / length)
}

export function encode(vec: Float32Array) {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength)
}

export function decode(blob: Uint8Array) {
  return new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength))
}

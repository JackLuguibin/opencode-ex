import { describe, expect, test } from "bun:test"
import { Builtin } from "../src/vector/builtin.js"
import { Pgvector } from "../src/vector/pgvector.js"
import { Qdrant } from "../src/vector/qdrant.js"
import { VectorStore } from "../src/vector/store.js"

const vec = (...values: number[]) => VectorStore.normalize(values)

// Every adapter must pass the same contract, so a new one only has to pass this to be usable.
function contract(name: string, make: () => VectorStore.Interface, run: typeof test = test) {
  describe(`vector store: ${name}`, () => {
    run("ranks by similarity and keeps upsert idempotent", async () => {
      const store = make()
      const collection = `contract_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
      await store.ensure(collection, { dim: 3 })
      await store.upsert(collection, [
        { id: "a", vec: vec(1, 0, 0) },
        { id: "b", vec: vec(0, 1, 0) },
      ])
      await store.upsert(collection, [{ id: "a", vec: vec(1, 0, 0) }])
      const hits = await store.search(collection, vec(0.9, 0.1, 0), 5)
      expect(hits.map((hit) => hit.id)).toEqual(["a", "b"])
      expect(hits[0].score).toBeGreaterThan(hits[1].score)
      await store.remove(collection, ["a"])
      expect((await store.search(collection, vec(1, 0, 0), 5)).map((hit) => hit.id)).toEqual(["b"])
      await store.drop(collection)
    })

    run("refuses a different dimension", async () => {
      const store = make()
      const collection = `contract_dim_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
      await store.ensure(collection, { dim: 3 })
      await store.upsert(collection, [{ id: "a", vec: vec(1, 0, 0) }])
      await expect(store.upsert(collection, [{ id: "b", vec: vec(1, 0) }])).rejects.toThrow()
      await store.drop(collection)
    })
  })
}

contract("builtin", () => Builtin.make(() => []))

const qdrant = process.env.OPENCODE_TEST_QDRANT_URL
contract("qdrant", () => Qdrant.make({ url: qdrant!, secret: "", timeoutMs: 5000 }), qdrant ? test : test.skip)

const postgres = process.env.OPENCODE_TEST_VECTOR_POSTGRES_URL
contract("pgvector", () => Pgvector.make({ url: postgres! }), postgres ? test : test.skip)

describe("builtin int8 search", () => {
  test("loads a collection lazily and finds the nearest of many", async () => {
    const rows = Array.from({ length: 2000 }, (_, index) => ({ id: `e${index}`, vec: VectorStore.normalize([Math.cos(index), Math.sin(index), (index % 7) / 7]) }))
    const store = Builtin.make(() => rows)
    const target = rows[1234]
    const hits = await store.search("any", target.vec, 3)
    expect(hits[0].id).toBe("e1234")
  })

  test("encodes and decodes a vector without loss", () => {
    const original = vec(0.3, -0.4, 0.5)
    expect(Array.from(VectorStore.decode(VectorStore.encode(original)))).toEqual(Array.from(original))
  })
})

import { afterAll, describe, expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { Embedding } from "@opencode/core/embedding"
import { Integration } from "@opencode/core/integration"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { testEffect } from "./lib/effect"

const providerID = Provider.ID.make("embed-test")
let delayMs = 0
let status = 200
const batches: string[][] = []
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as { model: string; input: string[] }
    batches.push(body.input)
    if (delayMs > 0) await Bun.sleep(delayMs)
    if (status !== 200) return Response.json({}, { status })
    if (body.model === "api-malformed") return Response.json({ nope: true })
    return Response.json({ data: body.input.map((text, index) => ({ index, embedding: [3 * text.length, 4 * text.length] })) })
  },
})
afterAll(() => server.stop(true))

const embeddingModel = (id: string, modelID = id) =>
  Model.Info.make({
    ...Model.Info.default(providerID, Model.ID.make(id)),
    modelID: Model.ID.make(modelID),
    type: "embedding",
    settings: { baseURL: `http://localhost:${server.port}/v1` },
  })
const catalog = [embeddingModel("embed"), embeddingModel("malformed", "api-malformed")]

const unused = () => Effect.die("unused")
const dependencies = Layer.mergeAll(
  Layer.mock(Provider.Service, { get: () => Effect.succeed(undefined) }),
  Layer.mock(Model.Service, { available: () => Effect.succeed(catalog) }),
  Layer.mock(Integration.Service, {
    revision: () => 0,
    connection: {
      active: () => Effect.succeed(undefined),
      resolve: unused,
      key: unused,
      external: unused,
      activate: unused,
      update: unused,
      remove: unused,
      status: unused,
    },
    oauth: { connect: unused, status: unused, complete: unused, cancel: unused },
    command: { connect: unused, status: unused, cancel: unused },
  }),
)
const it = testEffect(Embedding.layer.pipe(Layer.provide(dependencies), Layer.provide(FetchHttpClient.layer)))

const ref = (id: string) => Model.Ref.make({ providerID, id: Model.ID.make(id) })
const settings = (id = "embed", timeoutMs?: number) => ({ model: ref(id), timeoutMs })

describe("Embedding", () => {
  it.live("splits large inputs into batches of 64 and normalizes every vector", () =>
    Effect.gen(function* () {
      batches.length = 0
      const embedding = yield* Embedding.Service
      const texts = Array.from({ length: 130 }, (_, index) => "t".repeat(index + 1))
      const vectors = yield* embedding.embed(texts, settings())
      expect(batches.map((batch) => batch.length)).toEqual([64, 64, 2])
      expect(vectors).toHaveLength(130)
      expect(vectors.every((vector) => Math.abs(Math.hypot(...vector) - 1) < 1e-9)).toBe(true)
      expect(vectors[0]).toEqual([0.6, 0.8])
    }),
  )

  it.live("caches embedQuery by model and text", () =>
    Effect.gen(function* () {
      batches.length = 0
      const embedding = yield* Embedding.Service
      const first = yield* embedding.embedQuery("cached", settings())
      const second = yield* embedding.embedQuery("cached", settings())
      expect(second).toEqual(first)
      expect(batches).toEqual([["cached"]])
    }),
  )

  it.live("fails embedQuery with Unavailable when the provider exceeds the timeout", () =>
    Effect.gen(function* () {
      delayMs = 300
      const exit = yield* Embedding.Service.use((embedding) => embedding.embedQuery("slow", settings("embed", 50))).pipe(
        Effect.exit,
        Effect.ensuring(Effect.sync(() => (delayMs = 0))),
      )
      expect(Exit.isFailure(exit) && String(exit.cause)).toContain("Embedding.Unavailable")
      expect(Exit.isFailure(exit) && String(exit.cause)).toContain("exceeded 50ms")
    }),
  )

  it.live("fails with Unavailable on provider errors, malformed responses and unknown models", () =>
    Effect.gen(function* () {
      const embedding = yield* Embedding.Service
      const malformed = yield* embedding.embedQuery("x", settings("malformed")).pipe(Effect.flip)
      const missing = yield* embedding.embedQuery("x", settings("absent")).pipe(Effect.flip)
      status = 500
      const failed = yield* embedding.embedQuery("uncached", settings()).pipe(Effect.flip, Effect.ensuring(Effect.sync(() => (status = 200))))
      expect([malformed.reason, missing.reason, failed.reason]).toEqual(["provider", "model", "provider"])
      expect(malformed.message).toContain("Malformed")
    }),
  )
})

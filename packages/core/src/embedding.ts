export * as Embedding from "./embedding.js"

import { EmbeddingClient } from "@opencode/ai"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { Integration } from "./integration.js"
import { Model } from "./model.js"
import type { Ref } from "./model.js"
import { Provider } from "./provider.js"

/** Embedding could not be produced: no usable model, a provider failure, or the deadline passed. Callers fall back to keyword search. */
export class Unavailable extends Schema.TaggedError<Unavailable>()("Embedding.Unavailable", {
  reason: Schema.Literals(["model", "provider", "timeout"]),
  message: Schema.String,
}) {}
export { Unavailable as EmbeddingUnavailable }

export interface Settings {
  /** Catalog embedding model to use. */
  readonly model: Ref
  /** Deadline for `embedQuery`; defaults to 1500ms. */
  readonly timeoutMs?: number
}

export interface Interface {
  /** L2-normalized vectors, one per text in input order; batches of 64 go to the provider sequentially. */
  readonly embed: (
    texts: ReadonlyArray<string>,
    settings: Settings,
  ) => Effect.Effect<ReadonlyArray<ReadonlyArray<number>>, Unavailable>
  /** One normalized vector, cached per model and text, failing with `Unavailable` after `timeoutMs`. */
  readonly embedQuery: (text: string, settings: Settings) => Effect.Effect<ReadonlyArray<number>, Unavailable>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Embedding") {}

const BATCH_SIZE = 64
const CACHE_SIZE = 256
const DEFAULT_TIMEOUT_MS = 1500

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const providers = yield* Provider.Service
    const models = yield* Model.Service
    const integrations = yield* Integration.Service
    const http = yield* HttpClient.HttpClient
    // Map iteration order is insertion order, so deleting and re-inserting on a hit keeps the oldest entry first.
    const cache = new Map<string, ReadonlyArray<number>>()

    const unavailable = (reason: Unavailable["reason"], message: string) => new Unavailable({ reason, message })

    // Runs in the caller's fiber so `Credential.Actor` selects the acting member's personal credentials.
    const embedBatches = Effect.fn("Embedding.embed")(function* (texts: ReadonlyArray<string>, settings: Settings) {
      // Providers set up by hand list every model as chat, so an embedding model from them is found among those.
      const info =
        (yield* models.available(["embedding"])).find(
          (item) => item.providerID === settings.model.providerID && item.id === settings.model.id,
        ) ?? (yield* models.get(settings.model.providerID, settings.model.id))
      if (!info?.enabled)
        return yield* unavailable(
          "model",
          `Embedding model ${settings.model.providerID}/${settings.model.id} not found`,
        )
      const provider = yield* providers.get(info.providerID)
      const connection = yield* integrations.connection.active(
        provider?.integrationID ?? Integration.ID.make(info.providerID),
      )
      const credential = connection
        ? yield* integrations.connection
            .resolve(connection)
            .pipe(Effect.mapError((error) => unavailable("model", error.message)))
        : undefined
      const configured = { ...provider?.settings, ...info.settings, ...credential?.metadata }
      if (typeof configured.baseURL !== "string" || configured.baseURL === "")
        return yield* unavailable("model", `Provider ${info.providerID} has no baseURL for embeddings`)
      const apiKey = credential?.type === "key" ? credential.key : configured.apiKey
      const batches = Array.from({ length: Math.ceil(texts.length / BATCH_SIZE) }, (_, index) =>
        texts.slice(index * BATCH_SIZE, (index + 1) * BATCH_SIZE),
      )
      const results = yield* Effect.forEach(batches, (input) =>
        EmbeddingClient.embed({
          baseURL: configured.baseURL as string,
          model: info.modelID ?? info.id,
          input,
          apiKey: typeof apiKey === "string" && apiKey !== "" ? apiKey : undefined,
          headers: info.headers,
        }).pipe(Effect.provideService(HttpClient.HttpClient, http)),
      ).pipe(Effect.mapError((error) => unavailable("provider", error.message)))
      return results.flatMap((result) => result.embeddings.map(normalize))
    })

    return Service.of({
      embed: (texts, settings) => (texts.length === 0 ? Effect.succeed([]) : embedBatches(texts, settings)),
      embedQuery: Effect.fn("Embedding.embedQuery")(function* (text, settings) {
        const key = `${settings.model.providerID}/${settings.model.id}\u0000${text}`
        const hit = cache.get(key)
        if (hit) {
          cache.delete(key)
          cache.set(key, hit)
          return hit
        }
        const timeoutMs = settings.timeoutMs ?? DEFAULT_TIMEOUT_MS
        const result = yield* embedBatches([text], settings).pipe(Effect.timeoutOption(timeoutMs))
        if (Option.isNone(result)) return yield* unavailable("timeout", `Embedding query exceeded ${timeoutMs}ms`)
        const vector = result.value[0]
        if (!vector) return yield* unavailable("provider", "Provider returned no embedding")
        cache.set(key, vector)
        if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string)
        return vector
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(FetchHttpClient.layer))

export const node = makeLocationNode({
  service: Service,
  layer: defaultLayer,
  deps: [Provider.node, Model.node, Integration.node],
})

/** Scales a vector to unit length; a zero vector is returned unchanged. */
function normalize(vector: ReadonlyArray<number>) {
  const norm = Math.hypot(...vector)
  return norm === 0 ? vector : vector.map((value) => value / norm)
}

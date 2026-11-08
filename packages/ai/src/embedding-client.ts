import { Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"

/** The provider could not be reached, answered with a non-2xx status, or the request body could not be sent. */
export class EmbeddingTransportError extends Schema.TaggedError<EmbeddingTransportError>()(
  "AI.Embedding.TransportError",
  {
    message: Schema.String,
    status: Schema.optional(Schema.Number),
  },
) {}

/** The provider answered 2xx but the body is not a usable embeddings response for this request. */
export class EmbeddingResponseError extends Schema.TaggedError<EmbeddingResponseError>()(
  "AI.Embedding.ResponseError",
  { message: Schema.String },
) {}

export type EmbeddingError = EmbeddingTransportError | EmbeddingResponseError

export interface EmbeddingRequest {
  /** Provider base URL without the `/embeddings` suffix. */
  readonly baseURL: string
  readonly model: string
  /** Texts to embed in one call; callers keep this at 64 or fewer. */
  readonly input: ReadonlyArray<string>
  readonly apiKey?: string
  readonly headers?: Readonly<Record<string, string>>
}

export interface EmbeddingResponse {
  /** One vector per input, in input order. */
  readonly embeddings: ReadonlyArray<ReadonlyArray<number>>
  readonly usage: { readonly promptTokens: number; readonly totalTokens: number }
}

const Body = Schema.Struct({
  data: Schema.Array(Schema.Struct({ index: Schema.Number, embedding: Schema.Array(Schema.Number) })),
  usage: Schema.optional(
    Schema.Struct({
      prompt_tokens: Schema.optional(Schema.Number),
      total_tokens: Schema.optional(Schema.Number),
    }),
  ),
})

/** Calls an OpenAI-compatible `POST {baseURL}/embeddings` and returns the vectors in input order. */
export const embed = Effect.fn("EmbeddingClient.embed")(function* (request: EmbeddingRequest) {
  const http = yield* HttpClient.HttpClient
  const response = yield* HttpClientRequest.post(`${request.baseURL.replace(/\/+$/, "")}/embeddings`).pipe(
    HttpClientRequest.setHeaders(request.headers ?? {}),
    request.apiKey === undefined ? (value) => value : HttpClientRequest.bearerToken(request.apiKey),
    HttpClientRequest.bodyJson({ model: request.model, input: request.input }),
    Effect.flatMap(http.execute),
    Effect.mapError((cause) => new EmbeddingTransportError({ message: cause.message })),
  )
  if (response.status < 200 || response.status >= 300)
    return yield* new EmbeddingTransportError({
      message: `Embeddings request failed with status ${response.status}`,
      status: response.status,
    })
  const body = yield* response.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Body)),
    Effect.mapError((cause) => new EmbeddingResponseError({ message: `Malformed embeddings response: ${cause.message}` })),
  )
  const sorted = body.data.toSorted((a, b) => a.index - b.index)
  if (sorted.length !== request.input.length)
    return yield* new EmbeddingResponseError({
      message: `Expected ${request.input.length} embeddings, received ${sorted.length}`,
    })
  const dimensions = sorted[0]?.embedding.length ?? 0
  if (sorted.some((item) => item.embedding.length === 0 || item.embedding.length !== dimensions))
    return yield* new EmbeddingResponseError({ message: "Embeddings are empty or differ in dimension" })
  return {
    embeddings: sorted.map((item) => item.embedding),
    usage: {
      promptTokens: body.usage?.prompt_tokens ?? 0,
      totalTokens: body.usage?.total_tokens ?? body.usage?.prompt_tokens ?? 0,
    },
  } satisfies EmbeddingResponse
})

export const EmbeddingClient = { embed } as const

import { afterAll, describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { FetchHttpClient } from "effect/http"
import { EmbeddingClient, EmbeddingResponseError, EmbeddingTransportError } from "../src/embedding-client.js"

const requests: Array<{ url: string; auth: string | null; body: { model: string; input: string[] } }> = []
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    const body = (await request.json()) as { model: string; input: string[] }
    requests.push({ url: url.pathname, auth: request.headers.get("authorization"), body })
    if (url.pathname.startsWith("/fail")) return new Response("nope", { status: 429 })
    if (url.pathname.startsWith("/malformed")) return Response.json({ data: [{ index: 0, embedding: "x" }] })
    if (url.pathname.startsWith("/short")) return Response.json({ data: [] })
    // Reversed order proves the client sorts by `index`.
    const data = body.input.map((text, index) => ({ index, embedding: [text.length, index] })).reverse()
    return Response.json({ data, usage: { prompt_tokens: 7, total_tokens: 9 } })
  },
})
afterAll(() => server.stop(true))

const base = (path: string) => `http://localhost:${server.port}${path}`
const run = <A, E>(effect: Effect.Effect<A, E, import("effect/http").HttpClient.HttpClient>) =>
  Effect.runPromiseExit(effect.pipe(Effect.provide(FetchHttpClient.layer)))

describe("EmbeddingClient", () => {
  test("posts model and input with a bearer token and returns vectors in input order", async () => {
    const exit = await run(
      EmbeddingClient.embed({ baseURL: base("/v1/"), model: "m", input: ["a", "bbb"], apiKey: "k" }),
    )
    expect(Exit.isSuccess(exit) && exit.value).toEqual({
      embeddings: [
        [1, 0],
        [3, 1],
      ],
      usage: { promptTokens: 7, totalTokens: 9 },
    })
    expect(requests.at(-1)).toEqual({ url: "/v1/embeddings", auth: "Bearer k", body: { model: "m", input: ["a", "bbb"] } })
  })

  test("sends a full batch of 64 texts in one request", async () => {
    const input = Array.from({ length: 64 }, (_, index) => "x".repeat(index + 1))
    const exit = await run(EmbeddingClient.embed({ baseURL: base("/v1"), model: "m", input }))
    expect(Exit.isSuccess(exit) && exit.value.embeddings).toHaveLength(64)
    expect(requests.at(-1)?.body.input).toHaveLength(64)
  })

  test("maps a non-2xx status to a transport error", async () => {
    const exit = await run(EmbeddingClient.embed({ baseURL: base("/fail"), model: "m", input: ["a"] }))
    expect(Exit.isFailure(exit) && String(exit.cause)).toContain("AI.Embedding.TransportError")
    expect(new EmbeddingTransportError({ message: "x", status: 429 }).status).toBe(429)
  })

  test("maps a malformed body or wrong vector count to a response error", async () => {
    const malformed = await run(EmbeddingClient.embed({ baseURL: base("/malformed"), model: "m", input: ["a"] }))
    const short = await run(EmbeddingClient.embed({ baseURL: base("/short"), model: "m", input: ["a"] }))
    expect(Exit.isFailure(malformed) && String(malformed.cause)).toContain("AI.Embedding.ResponseError")
    expect(Exit.isFailure(short) && String(short.cause)).toContain("Expected 1 embeddings")
    expect(new EmbeddingResponseError({ message: "x" })._tag).toBe("AI.Embedding.ResponseError")
  })
})

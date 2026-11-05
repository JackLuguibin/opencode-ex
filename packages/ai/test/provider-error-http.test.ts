import { expect } from "bun:test"
import { Effect } from "effect"
import { FetchHttpClient } from "effect/http"
import { LLM } from "../src/effect.js"
import { LLMClient } from "../src/route/client.js"
import { OpenAICompatible } from "../src/providers/openai-compatible.js"
import { isContextOverflowFailure } from "../src/provider-error.js"
import { testEffect } from "./lib/effect.js"
import { runtimeLayer } from "./lib/http.js"

const throttle =
  '{"message":"Tokens per minute limit exceeded - too many tokens processed.","type":"too_many_tokens_error","param":"quota","code":"token_quota_exceeded"}'
const litellm =
  '{"error":{"message":"litellm.ContextWindowExceededError: litellm.BadRequestError: litellm._pre_call_checks: Context Window exceeded for given call. No models have a context window large enough.","type":null,"param":null,"code":"400"}}'

// Errors a provider returns over real HTTP, through the real client, must be told apart: a token throttle is a retryable
// rate limit, and only a genuine context overflow triggers compaction.
testEffect(runtimeLayer(FetchHttpClient.layer)).live("classifies provider failures received over HTTP", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch: (request) =>
            new URL(request.url).pathname.endsWith("/throttle/chat/completions")
              ? new Response(throttle, { status: 429, headers: { "content-type": "application/json" } })
              : new Response(litellm, { status: 400, headers: { "content-type": "application/json" } }),
        }),
      ),
      (server) => Effect.sync(() => server.stop(true)),
    )
    const request = (path: string) =>
      LLM.request({
        model: OpenAICompatible.model("fixture", { apiKey: "fixture", baseURL: `http://127.0.0.1:${server.port}/${path}` }),
        prompt: "hello",
      })
    const limited = yield* Effect.flip(LLMClient.generate(request("throttle")))
    expect(limited.reason._tag).toBe("RateLimit")
    expect(isContextOverflowFailure(limited)).toBe(false)
    const overflow = yield* Effect.flip(LLMClient.generate(request("overflow")))
    expect(isContextOverflowFailure(overflow)).toBe(true)
  }),
)

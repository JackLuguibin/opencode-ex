export * as KnowledgeTools from "./knowledge.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { ToolFailure } from "@opencode/ai/effect"
import { eq } from "drizzle-orm"
import { Model } from "@opencode/schema/model"
import { Effect, Schema } from "effect"
import { Database } from "../../database/database.js"
import { Embedding } from "../../embedding.js"
import { Knowledge } from "../../knowledge.js"
import { Location } from "../../location.js"
import { Permission } from "../../permission.js"
import { ProjectTable } from "../../project/sql.js"
import { Tool } from "../../tool.js"

const MAX_RESULTS = 20

const ListInput = Schema.Struct({})

const SearchInput = Schema.Struct({
  query: Schema.String.annotate({ description: "What to look up, in the words of the topic" }),
  base: Schema.optional(Schema.String).annotate({
    description: "A knowledge base name or id from knowledge_list; leave out to search every base you can use",
  }),
  limit: Schema.optional(Schema.Number).annotate({ description: `How many results to return (default 5, at most ${MAX_RESULTS})` }),
})

const GetInput = Schema.Struct({ id: Schema.String.annotate({ description: "An entry id from knowledge_search" }) })

const Unknown = Schema.Unknown

export const Plugin = {
  id: "opencode.tool.knowledge",
  effect: Effect.fn("KnowledgeTools.Plugin")(function* (ctx: Context) {
    const permission = yield* Permission.Service
    const knowledge = yield* Knowledge.Service
    const database = yield* Database.Service
    const location = yield* Location.Service
    const embedding = yield* Embedding.Service

    // The organization the project belongs to decides which knowledge bases are open. A project outside every organization
    // (the local TUI) is its own operator and sees all of them.
    const actor = Effect.gen(function* () {
      const row = yield* database.db
        .select({ organization_id: ProjectTable.organization_id })
        .from(ProjectTable)
        .where(eq(ProjectTable.id, location.project.id))
        .get()
        .pipe(Effect.orDie)
      return { userID: "agent", admin: !row?.organization_id, organizationID: row?.organization_id ?? undefined }
    })

    // A query vector for each embedding configuration, including distinct prefixes for the same model.
    // A model that fails is left out and its bases are searched by keywords only.
    const queryVectors = (base: string | undefined, query: string) =>
      Effect.gen(function* () {
        const answer = yield* knowledge.call(yield* actor, {
          method: "POST",
          path: "/v1/search/models",
          body: { bases: base ? [base] : undefined },
        })
        if (answer.status >= 400) return undefined
        const needed = answer.body as { key: string; model: string; queryPrefix: string; queryTimeoutMs: number }[]
        const made = yield* Effect.forEach(
          needed,
          (item) =>
            Effect.suspend(() =>
              embedding.embedQuery(`${item.queryPrefix}${query}`, {
                model: Model.Ref.parse(item.model),
                timeoutMs: item.queryTimeoutMs,
              }),
            ).pipe(
              Effect.map((values) => [[item.key, values] as const]),
              Effect.catchCause(() => Effect.succeed([])),
            ),
          { concurrency: "unbounded" },
        )
        return made.length > 0 ? Object.fromEntries(made.flat()) : undefined
      }).pipe(Effect.catchCause(() => Effect.succeed(undefined)))

    const ask = (
      action: string,
      resource: string,
      input: Record<string, unknown>,
      context: Tool.Context,
      request: { readonly method: string; readonly path: string; readonly body?: unknown },
      prepare?: Effect.Effect<{ readonly body?: unknown }>,
    ) =>
      Effect.gen(function* () {
        yield* permission.assert({
          action,
          resources: [resource],
          save: ["*"],
          metadata: input,
          sessionID: context.sessionID,
          agent: context.agent,
          source: { type: "tool", messageID: context.messageID, id: context.id },
        })
        const answer = yield* knowledge.call(yield* actor, prepare ? { ...request, ...(yield* prepare) } : request)
        if (answer.status >= 400) return yield* new ToolFailure({ message: answer.message || "The knowledge service failed" })
        return { output: answer.body }
      }).pipe(
        Effect.mapError((error) =>
          error instanceof ToolFailure ? error : new ToolFailure({ message: `Unable to use ${action}` }),
        ),
      )

    yield* ctx.tool.transform((editor) => {
      editor.add({
        name: "knowledge_list",
        options: { codemode: false },
        description:
          "List the knowledge bases you can look things up in, with what each one covers. Call this first when a task needs specialist knowledge, then use knowledge_search on the base that fits.",
        input: ListInput,
        output: Unknown,
        execute: (input, context) => ask("knowledge_list", "*", input, context, { method: "GET", path: "/v1/bases" }),
      })
      editor.add({
        name: "knowledge_search",
        options: { codemode: false },
        description:
          "Search the knowledge bases for specialist knowledge. Answer from what it returns and name the entry you used. If nothing relevant comes back, say the knowledge base has nothing on it rather than guessing.",
        input: SearchInput,
        output: Unknown,
        execute: (input, context) =>
          ask(
            "knowledge_search",
            input.base ?? "*",
            input,
            context,
            { method: "POST", path: "/v1/search" },
            // Embedded only after permission is granted, so a refused call costs no provider request.
            queryVectors(input.base, input.query).pipe(
              Effect.map((vectors) => ({
                body: {
                  query: input.query,
                  vectors,
                  bases: input.base ? [input.base] : undefined,
                  topK: Math.min(Math.max(Math.trunc(Number.isFinite(input.limit) ? input.limit! : 5), 1), MAX_RESULTS),
                },
              })),
            ),
          ),
      })
      editor.add({
        name: "knowledge_get",
        options: { codemode: false },
        description: "Read one knowledge entry in full, using an id from knowledge_search.",
        input: GetInput,
        output: Unknown,
        execute: (input, context) =>
          ask("knowledge_get", input.id, input, context, { method: "GET", path: `/v1/entries/${encodeURIComponent(input.id)}` }),
      })
    })
  }),
}

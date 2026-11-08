import { Embedding } from "@opencode/core/embedding"
import { Generate } from "@opencode/core/generate"
import { Identity } from "@opencode/core/identity"
import { Knowledge } from "@opencode/core/knowledge"
import { KnowledgeImport } from "@opencode/core/knowledge-import"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-services"
import { AbsolutePath } from "@opencode/core/schema"
import { Model } from "@opencode/schema/model"
import { Global } from "@opencode/util/global"
import { ForbiddenError, InvalidRequestError, ServiceUnavailableError, UnauthorizedError } from "@opencode/protocol/errors"
import { Effect } from "effect"
import { HttpServerRequest } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { accessFor } from "../access"
import { Api } from "../api"
import { ServerAuth } from "../auth"
import { awaitPlugins, locationErrors } from "../location"

export const KnowledgeHandler = HttpApiBuilder.group(Api, "server.knowledge", (handlers) =>
  Effect.gen(function* () {
    const identity = yield* Identity.Service
    const knowledge = yield* Knowledge.Service
    const config = yield* ServerAuth.Config
    const global = yield* Global.Service
    const locations = yield* LocationServiceMap.Service
    // Conversion uses the server's base configuration and its default model, like the stateless generate routes.
    const services = locations.get(Location.Ref.make({ directory: AbsolutePath.make(global.config) }))

    // Who is asking, as the knowledge service needs it. A bare operator (the local TUI) is a platform admin.
    const who = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const access = yield* accessFor(request, config, identity)
      if (access.kind === "unset") return yield* new UnauthorizedError({ message: "Authentication required" })
      return access.kind === "operator"
        ? { userID: "operator", admin: true, organizationID: undefined }
        : { userID: access.userID, admin: access.admin, organizationID: access.organizationID }
    })

    // Forwards one call and turns what the service answers into this API's errors.
    const forward = (method: string, path: string, input?: { readonly query?: Knowledge.Query; readonly body?: unknown }) =>
      Effect.gen(function* () {
        const context = yield* who
        const answer = yield* knowledge.call(context, { method, path, query: input?.query, body: input?.body })
        if (answer.status === 503) return yield* new ServiceUnavailableError({ message: answer.message, service: "knowledge" })
        if (answer.status === 403) return yield* new ForbiddenError({ message: answer.message })
        if (answer.status >= 400)
          return yield* new InvalidRequestError({ message: answer.message, kind: answer.status === 404 ? "not_found" : undefined })
        return answer.body
      })

    type ImportSettings = {
      readonly import: {
        readonly model: string
        readonly chunkChars: number
        readonly overlap: number
        readonly concurrency: number
        readonly aliases: boolean
        readonly questions: boolean
        readonly summary: boolean
        readonly review: boolean
      }
    }

    type VectorSettings = {
      readonly vector: {
        readonly enabled: boolean
        readonly model: string
        readonly queryPrefix: string
        readonly documentPrefix: string
        readonly queryTimeoutMs: number
      }
    }
    type Draft = {
      readonly title?: string
      readonly content?: string
      readonly summary?: string
      readonly aliases?: ReadonlyArray<string>
      readonly questions?: ReadonlyArray<string>
      readonly [key: string]: unknown
    }

    // The embedding model a base is set to use, or nothing when vectors are off or no model is chosen.
    const embeddingFor = (baseID: string | undefined) =>
      Effect.gen(function* () {
        const found = yield* forward("GET", baseID ? `/v1/bases/${encodeURIComponent(baseID)}/settings` : "/v1/settings")
        const settings = (baseID ? (found as { effective: VectorSettings }).effective : (found as VectorSettings)).vector
        if (!settings.enabled || !settings.model) return undefined
        const model = yield* Effect.try(() => Model.Ref.parse(settings.model))
        return {
          name: settings.model,
          settings: { model, timeoutMs: settings.queryTimeoutMs },
          prefix: { query: settings.queryPrefix, document: settings.documentPrefix },
        }
      })

    // Vectors are a help, never a requirement: whatever goes wrong here leaves the caller with keyword search only.
    const embedTexts = (baseID: string | undefined, texts: ReadonlyArray<string>, kind: "document" | "query" = "document") =>
      Effect.gen(function* () {
        const config = yield* embeddingFor(baseID)
        if (!config || texts.length === 0) return undefined
        yield* awaitPlugins
        const embedding = yield* Embedding.Service
        return { model: config.name, vectors: yield* embedding.embed(texts.map((text) => `${config.prefix[kind]}${text}`), config.settings) }
      }).pipe(
        Effect.provide(services),
        Effect.catch((error) => Effect.logWarning("knowledge embedding unavailable", { error }).pipe(Effect.as(undefined))),
      )

    const queryVector = (baseID: string | undefined, query: string) =>
      Effect.gen(function* () {
        const config = yield* embeddingFor(baseID)
        if (!config) return undefined
        yield* awaitPlugins
        const embedding = yield* Embedding.Service
        return yield* embedding.embedQuery(`${config.prefix.query}${query}`, config.settings)
      }).pipe(
        Effect.provide(services),
        Effect.catch((error) => Effect.logWarning("knowledge query embedding unavailable", { error }).pipe(Effect.as(undefined))),
      )

    // What a vector stands for: the words a person might use, then the start of the text itself.
    const vectorText = (entry: Draft) =>
      [entry.title, entry.aliases?.join(" "), entry.questions?.join(" "), entry.summary, entry.content?.slice(0, 1500)]
        .filter(Boolean)
        .join("\n")

    const withVectors = Effect.fnUntraced(function* (baseID: string, entries: ReadonlyArray<Draft>) {
      const embedded = yield* embedTexts(baseID, entries.map(vectorText))
      return embedded ? entries.map((entry, index) => ({ ...entry, vector: { model: embedded.model, values: embedded.vectors[index] } })) : entries
    })

    const admin = Effect.gen(function* () {
      const context = yield* who
      if (!context.admin) return yield* new ForbiddenError({ message: "Only a platform admin can import knowledge" })
      return context
    })

    // Converts the sections one model call at a time (a few in parallel) and writes what comes back, reporting progress on the job.
    const convert = Effect.fnUntraced(function* (input: {
      readonly context: Knowledge.Actor
      readonly base: string
      readonly job: string
      readonly name: string
      readonly sections: ReadonlyArray<KnowledgeImport.Section>
      readonly settings: ImportSettings["import"]
    }) {
      const generate = yield* Generate.Service
      const model = input.settings.model ? Model.Ref.parse(input.settings.model) : undefined
      const ask = (prompt: string) => generate.text({ prompt, model })
      const progress = { done: 0, failed: 0, error: "" }
      const patch = (body: unknown) => knowledge.call(input.context, { method: "PATCH", path: `/v1/jobs/${input.job}`, body })
      yield* Effect.forEach(
        input.sections,
        (section) =>
          Effect.gen(function* () {
            const prompt = KnowledgeImport.prompt(section, input.settings)
            const first = KnowledgeImport.parse(yield* ask(prompt))
            const converted =
              first ??
              KnowledgeImport.parse(yield* ask(`${prompt}\n\nYour previous reply was not the JSON asked for. Reply with that JSON only.`))
            if (!converted) {
              progress.failed++
              progress.error ||= "The model did not return entries in the expected format"
              return
            }
            if (converted.length === 0) return
            const entries = yield* withVectors(input.base, converted)
            const written = yield* knowledge.call(input.context, {
              method: "POST",
              path: `/v1/bases/${encodeURIComponent(input.base)}/entries`,
              body: {
                entries: entries.map((entry) => ({
                  ...entry,
                  hash: section.hash,
                  source: `import:${input.name}${section.path.length > 0 ? `#${section.path.join(" > ")}` : ""}`,
                  status: input.settings.review ? "draft" : "published",
                })),
              },
            })
            if (written.status >= 400) {
              progress.failed++
              progress.error ||= written.message
            }
          }).pipe(
            Effect.catch((error) =>
              Effect.sync(() => {
                progress.failed++
                progress.error ||= error instanceof Error ? error.message : String(error)
              }),
            ),
            Effect.ensuring(
              Effect.suspend(() => {
                progress.done++
                return patch({ done: progress.done })
              }),
            ),
          ),
        { concurrency: input.settings.concurrency, discard: true },
      )
      yield* patch({
        status: progress.failed === input.sections.length ? "failed" : "done",
        error: progress.failed > 0 ? `${progress.failed} of ${input.sections.length} sections failed: ${progress.error}` : "",
      })
    })

    const startImport = Effect.fn("server.knowledge.import")(function* (args: {
      readonly params: { readonly baseID: string }
      readonly payload: unknown
    }) {
      const context = yield* admin
      const body = (args.payload ?? {}) as { markdown?: unknown; name?: unknown }
      if (typeof body.markdown !== "string" || body.markdown.trim() === "")
        return yield* new InvalidRequestError({ message: "Send the Markdown text to convert", field: "markdown" })
      const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "document"
      const baseID = encodeURIComponent(args.params.baseID)
      const settings = ((yield* forward("GET", `/v1/bases/${baseID}/settings`)) as { effective: ImportSettings }).effective.import
      const known = new Set((yield* forward("GET", `/v1/bases/${baseID}/hashes`)) as string[])
      const sections = KnowledgeImport.split(body.markdown, settings)
      const todo = sections.filter((section) => !known.has(section.hash))
      const job = ((yield* forward("POST", `/v1/bases/${baseID}/jobs`, { body: { total: todo.length } })) as { id: string }).id
      if (todo.length === 0) {
        yield* forward("PATCH", `/v1/jobs/${job}`, { body: { status: "done" } })
        return { job, sections: sections.length, skipped: sections.length, total: 0 }
      }
      yield* awaitPlugins.pipe(
        Effect.andThen(convert({ context, base: args.params.baseID, job, name, sections: todo, settings })),
        Effect.catch((error) =>
          knowledge.call(context, {
            method: "PATCH",
            path: `/v1/jobs/${job}`,
            body: { status: "failed", error: error instanceof Error ? error.message : "The conversion stopped" },
          }),
        ),
        Effect.provide(services),
        Effect.forkDetach,
      )
      return { job, sections: sections.length, skipped: sections.length - todo.length, total: todo.length }
    }, locationErrors)

    return handlers
      .handle("knowledge.bases.list", (_) => forward("GET", `/v1/bases`))
      .handle("knowledge.bases.create", (args) => forward("POST", `/v1/bases`, { body: args.payload }))
      .handle("knowledge.bases.get", (args) => forward("GET", `/v1/bases/${args.params.baseID}`))
      .handle("knowledge.bases.update", (args) => forward("PATCH", `/v1/bases/${args.params.baseID}`, { body: args.payload }))
      .handle("knowledge.bases.delete", (args) => Effect.asVoid(forward("DELETE", `/v1/bases/${args.params.baseID}`)))
      .handle("knowledge.bases.grant", (args) => forward("PUT", `/v1/bases/${args.params.baseID}/grants`, { body: args.payload }))
      .handle("knowledge.bases.stats", (args) => forward("GET", `/v1/bases/${args.params.baseID}/stats`))
      .handle("knowledge.bases.reindex", (args) => forward("POST", `/v1/bases/${args.params.baseID}/reindex`))
      .handle("knowledge.bases.settings.get", (args) => forward("GET", `/v1/bases/${args.params.baseID}/settings`))
      .handle("knowledge.bases.settings.update", (args) => forward("PATCH", `/v1/bases/${args.params.baseID}/settings`, { body: args.payload }))
      .handle("knowledge.entries.list", (args) => forward("GET", `/v1/bases/${args.params.baseID}/entries`, { query: args.query }))
      .handle("knowledge.entries.create", (args) =>
        Effect.gen(function* () {
          const body = (args.payload ?? {}) as { entries?: Draft[] }
          const entries = Array.isArray(body.entries) ? yield* withVectors(args.params.baseID, body.entries) : body.entries
          return yield* forward("POST", `/v1/bases/${encodeURIComponent(args.params.baseID)}/entries`, { body: { ...body, entries } })
        }),
      )
      .handle("knowledge.entries.status", (args) => forward("POST", `/v1/bases/${args.params.baseID}/status`, { body: args.payload }))
      .handle("knowledge.entries.get", (args) => forward("GET", `/v1/entries/${args.params.entryID}`))
      .handle("knowledge.entries.update", (args) =>
        Effect.gen(function* () {
          const path = `/v1/entries/${encodeURIComponent(args.params.entryID)}`
          // A rewritten entry needs a new vector, which is made from the whole entry as it will be, not only the changed fields.
          const current = (yield* forward("GET", path)) as Draft & { base: string }
          const next = { ...current, ...((args.payload ?? {}) as Draft) }
          const embedded = yield* embedTexts(current.base, [vectorText(next)])
          const body = embedded ? { ...(args.payload as object), vector: { model: embedded.model, values: embedded.vectors[0] } } : args.payload
          return yield* forward("PATCH", path, { body })
        }),
      )
      .handle("knowledge.entries.delete", (args) => Effect.asVoid(forward("DELETE", `/v1/entries/${args.params.entryID}`)))
      .handle("knowledge.search", (args) =>
        Effect.gen(function* () {
          const body = (args.payload ?? {}) as { query?: unknown; bases?: unknown }
          // One named base is searched with its own settings; several (or none) use the platform's.
          const only = Array.isArray(body.bases) && body.bases.length === 1 && typeof body.bases[0] === "string" ? body.bases[0] : undefined
          const vector = typeof body.query === "string" ? yield* queryVector(only, body.query) : undefined
          return yield* forward("POST", `/v1/search`, { body: vector ? { ...body, vector } : body })
        }),
      )
      .handle("knowledge.settings.get", (_) => forward("GET", `/v1/settings`))
      .handle("knowledge.settings.update", (args) => forward("PATCH", `/v1/settings`, { body: args.payload }))
      .handle("knowledge.vectorStore.test", (args) => forward("POST", `/v1/vector-store/test`, { body: args.payload }))
      .handle("knowledge.import.start", (args) => startImport(args))
      .handle("knowledge.import.job", (args) => forward("GET", `/v1/jobs/${args.params.jobID}`))
      .handle("knowledge.eval.cases", (args) => forward("GET", `/v1/bases/${args.params.baseID}/eval/cases`))
      .handle("knowledge.eval.addCase", (args) => forward("POST", `/v1/bases/${args.params.baseID}/eval/cases`, { body: args.payload }))
      .handle("knowledge.eval.removeCase", (args) => Effect.asVoid(forward("DELETE", `/v1/eval/cases/${args.params.caseID}`)))
      .handle("knowledge.eval.runs", (args) => forward("GET", `/v1/bases/${args.params.baseID}/eval/runs`))
      .handle("knowledge.eval.run", (args) =>
        Effect.gen(function* () {
          const base = encodeURIComponent(args.params.baseID)
          const cases = (yield* forward("GET", `/v1/bases/${base}/eval/cases`)) as { id: string; question: string }[]
          const embedded = yield* embedTexts(args.params.baseID, cases.map((item) => item.question), "query")
          const vectors = embedded ? Object.fromEntries(cases.map((item, index) => [item.id, embedded.vectors[index]])) : {}
          return yield* forward("POST", `/v1/bases/${base}/eval/run`, { body: { vectors } })
        }),
      )
  }),
)

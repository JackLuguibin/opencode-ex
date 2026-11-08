export * as Server from "./server.js"

import { Context } from "./context.js"
import { Knowledge } from "./knowledge.js"

type Call = {
  readonly context: Knowledge.Context
  readonly params: ReadonlyArray<string>
  readonly url: URL
  readonly body: () => Promise<Record<string, unknown>>
}

type Route = readonly [method: string, pattern: RegExp, handler: (call: Call) => unknown]

const MAX_ENTRIES = 200

/** The service's HTTP surface. Every route except health needs a context header an execution layer signed with `secret`. */
export function make(input: { readonly service: Knowledge.Service; readonly secrets: ReadonlyArray<string> }) {
  const service = input.service
  const text = (body: Record<string, unknown>, key: string) => {
    const value = body[key]
    if (typeof value !== "string") throw new Knowledge.Failure("invalid", `${key} must be text`)
    return value
  }
  const optional = (body: Record<string, unknown>, key: string) => (typeof body[key] === "string" ? (body[key] as string) : undefined)
  const strings = (value: unknown, key: string) => {
    if (value === undefined) return undefined
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Knowledge.Failure("invalid", `${key} must be a list of text`)
    return value as string[]
  }
  const vector = (value: unknown) => {
    if (value === undefined) return undefined
    if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "number" || !Number.isFinite(item)))
      throw new Knowledge.Failure("invalid", "vector must be a list of numbers")
    return value as number[]
  }
  const status = (value: unknown) => {
    if (value === undefined) return undefined
    if (value !== "draft" && value !== "published") throw new Knowledge.Failure("invalid", "status must be draft or published")
    return value
  }
  const entry = (raw: unknown): Knowledge.EntryInput => {
    if (typeof raw !== "object" || raw === null) throw new Knowledge.Failure("invalid", "entry must be an object")
    const body = raw as Record<string, unknown>
    const embedded = body.vector as { model?: unknown; values?: unknown } | undefined
    return {
      title: text(body, "title"),
      content: text(body, "content"),
      summary: optional(body, "summary"),
      aliases: strings(body.aliases, "aliases"),
      questions: strings(body.questions, "questions"),
      keywords: strings(body.keywords, "keywords"),
      source: optional(body, "source"),
      hash: optional(body, "hash"),
      status: status(body.status),
      vector: embedded ? { model: text(embedded as Record<string, unknown>, "model"), values: vector(embedded.values)! } : undefined,
    }
  }
  const partialEntry = (body: Record<string, unknown>): Partial<Knowledge.EntryInput> => ({
    title: optional(body, "title"),
    content: optional(body, "content"),
    summary: optional(body, "summary"),
    aliases: strings(body.aliases, "aliases"),
    questions: strings(body.questions, "questions"),
    keywords: strings(body.keywords, "keywords"),
    source: optional(body, "source"),
    status: status(body.status),
    vector: body.vector ? entry({ title: "x", content: "x", vector: body.vector }).vector : undefined,
  })
  const number = (value: string | null) => (value === null ? undefined : Number(value))

  const routes: ReadonlyArray<Route> = [
    ["GET", /^\/v1\/bases$/, (c) => service.bases.list(c.context)],
    ["POST", /^\/v1\/bases$/, async (c) => {
      const body = await c.body()
      return service.bases.create(c.context, { name: text(body, "name"), description: optional(body, "description") })
    }],
    ["GET", /^\/v1\/bases\/([^/]+)$/, (c) => service.bases.get(c.context, c.params[0])],
    ["PATCH", /^\/v1\/bases\/([^/]+)$/, async (c) => {
      const body = await c.body()
      return service.bases.update(c.context, c.params[0], { name: optional(body, "name"), description: optional(body, "description") })
    }],
    ["DELETE", /^\/v1\/bases\/([^/]+)$/, async (c) => service.bases.remove(c.context, c.params[0])],
    ["PUT", /^\/v1\/bases\/([^/]+)\/grants$/, async (c) =>
      service.bases.grant(c.context, c.params[0], strings((await c.body()).organizations, "organizations") ?? [])],
    ["DELETE", /^\/v1\/organizations\/([^/]+)\/grants$/, (c) => service.bases.revoke(c.context, c.params[0])],
    ["GET", /^\/v1\/bases\/([^/]+)\/stats$/, (c) => service.bases.stats(c.context, c.params[0])],
    ["GET", /^\/v1\/bases\/([^/]+)\/entries$/, (c) =>
      service.entries.list(c.context, c.params[0], {
        q: c.url.searchParams.get("q") ?? undefined,
        status: status(c.url.searchParams.get("status") ?? undefined),
        limit: number(c.url.searchParams.get("limit")),
        offset: number(c.url.searchParams.get("offset")),
      })],
    ["POST", /^\/v1\/bases\/([^/]+)\/entries$/, async (c) => {
      const raw = (await c.body()).entries
      if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_ENTRIES) throw new Knowledge.Failure("invalid", `send between 1 and ${MAX_ENTRIES} entries`)
      return service.entries.create(c.context, c.params[0], raw.map(entry))
    }],
    ["GET", /^\/v1\/entries\/([^/]+)$/, (c) => service.entries.get(c.context, c.params[0])],
    ["PATCH", /^\/v1\/entries\/([^/]+)$/, async (c) => service.entries.update(c.context, c.params[0], partialEntry(await c.body()))],
    ["DELETE", /^\/v1\/entries\/([^/]+)$/, (c) => service.entries.remove(c.context, c.params[0])],
    ["POST", /^\/v1\/bases\/([^/]+)\/status$/, async (c) => {
      const body = await c.body()
      return { changed: await service.entries.setStatus(c.context, c.params[0], strings(body.ids, "ids"), status(body.status) ?? "published") }
    }],
    ["GET", /^\/v1\/bases\/([^/]+)\/hashes$/, (c) => service.entries.hashes(c.context, c.params[0])],
    ["POST", /^\/v1\/bases\/([^/]+)\/reindex$/, (c) => service.reindex(c.context, c.params[0])],
    ["POST", /^\/v1\/search$/, async (c) => {
      const body = await c.body()
      return service.search(c.context, {
        query: text(body, "query"),
        vector: vector(body.vector),
        bases: strings(body.bases, "bases"),
        topK: typeof body.topK === "number" && Number.isFinite(body.topK) ? Math.trunc(body.topK) : undefined,
      })
    }],
    ["GET", /^\/v1\/settings$/, () => service.settings.platform()],
    ["PATCH", /^\/v1\/settings$/, async (c) => service.settings.patchPlatform(c.context, await c.body())],
    ["GET", /^\/v1\/bases\/([^/]+)\/settings$/, (c) => service.settings.base(c.context, c.params[0])],
    ["PATCH", /^\/v1\/bases\/([^/]+)\/settings$/, async (c) => service.settings.patchBase(c.context, c.params[0], await c.body())],
    ["POST", /^\/v1\/vector-store\/test$/, async (c) => service.settings.testStore(c.context, await c.body())],
    ["POST", /^\/v1\/bases\/([^/]+)\/jobs$/, async (c) => {
      const body = await c.body()
      return { id: service.jobs.create(c.context, c.params[0], typeof body.total === "number" ? body.total : 0) }
    }],
    ["PATCH", /^\/v1\/jobs\/([^/]+)$/, async (c) => {
      const body = await c.body()
      const state = body.status
      if (state !== undefined && state !== "running" && state !== "done" && state !== "failed") throw new Knowledge.Failure("invalid", "status is not valid")
      service.jobs.update(c.context, c.params[0], {
        status: state,
        done: typeof body.done === "number" ? body.done : undefined,
        total: typeof body.total === "number" ? body.total : undefined,
        error: optional(body, "error"),
      })
      return {}
    }],
    ["GET", /^\/v1\/jobs\/([^/]+)$/, (c) => service.jobs.get(c.context, c.params[0])],
    ["GET", /^\/v1\/bases\/([^/]+)\/eval\/cases$/, (c) => service.evaluation.cases(c.context, c.params[0])],
    ["POST", /^\/v1\/bases\/([^/]+)\/eval\/cases$/, async (c) => {
      const body = await c.body()
      return { id: service.evaluation.addCase(c.context, c.params[0], { question: text(body, "question"), expected: text(body, "expected") }) }
    }],
    ["DELETE", /^\/v1\/eval\/cases\/([^/]+)$/, (c) => service.evaluation.removeCase(c.context, c.params[0])],
    ["GET", /^\/v1\/bases\/([^/]+)\/eval\/runs$/, (c) => service.evaluation.runs(c.context, c.params[0])],
    ["POST", /^\/v1\/bases\/([^/]+)\/eval\/run$/, async (c) => {
      const raw = (await c.body()).vectors
      const vectors = typeof raw === "object" && raw !== null ? Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, vector(value)!])) : {}
      return service.evaluation.run(c.context, c.params[0], vectors)
    }],
  ]

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    if (request.method === "GET" && url.pathname === "/v1/health") return Response.json({ ok: true })
    const header = request.headers.get(Context.HEADER)
    const context = header ? Context.verify(input.secrets, header) : undefined
    if (!context) return Response.json({ message: "unauthorized" }, { status: 401 })
    const route = routes.flatMap(([method, pattern, handler]) => {
      const match = method === request.method ? pattern.exec(url.pathname) : null
      return match ? [{ handler, params: match.slice(1).map(decodeURIComponent) }] : []
    })[0]
    if (!route) return Response.json({ message: "not found" }, { status: 404 })
    return Promise.resolve()
      .then(() =>
        route.handler({
          context,
          params: route.params,
          url,
          body: async () => {
            const parsed = await request.json().catch(() => undefined)
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Knowledge.Failure("invalid", "send a JSON object")
            return parsed as Record<string, unknown>
          },
        }),
      )
      .then((result) => (result === undefined ? new Response(null, { status: 204 }) : Response.json(result)))
      .catch((error: unknown) => {
        if (error instanceof Knowledge.Failure)
          return Response.json({ message: error.message }, { status: error.reason === "missing" ? 404 : error.reason === "forbidden" ? 403 : 400 })
        console.error(`knowledge ${request.method} ${url.pathname} failed: ${error instanceof Error ? error.message : String(error)}`)
        return Response.json({ message: "internal error" }, { status: 500 })
      })
  }
}

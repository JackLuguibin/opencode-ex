import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { OpenCode } from "@opencode/client"
import { Embedding } from "@opencode/core/embedding"
import { Generate } from "@opencode/core/generate"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Global } from "@opencode/util/global"
import { Effect, Layer } from "effect"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

// Stands in for the model: every section converts to the same single entry, titled after its first words.
const generate = makeLocationNode({
  service: Generate.Service,
  layer: Layer.succeed(
    Generate.Service,
    Generate.Service.of({
      text: (input) => {
        const fragment = input.prompt.split("Fragment:\n")[1] ?? ""
        return Effect.succeed(
          JSON.stringify({
            entries: [{ title: fragment.split("\n")[0].replace(/^#+\s*/, ""), content: fragment, aliases: ["alias"], questions: ["what is it"] }],
          }),
        )
      },
      image: () => Effect.die("unused"),
      decisions: () => Effect.die("unused"),
    }),
  ),
  deps: [],
})

// Stands in for the embedding model: a text is "about zebras" when it says zebra or striped, "about apples" when it says apple.
const vectorOf = (text: string) => {
  const lower = text.toLowerCase()
  const values = [/zebra|striped/.test(lower) ? 1 : 0, /apple/.test(lower) ? 1 : 0, 0.1]
  const length = Math.hypot(...values)
  return values.map((value) => value / length)
}
const embedding = makeLocationNode({
  service: Embedding.Service,
  layer: Layer.succeed(
    Embedding.Service,
    Embedding.Service.of({
      embed: (texts) => Effect.succeed(texts.map(vectorOf)),
      embedQuery: (text) => Effect.succeed(vectorOf(text)),
    }),
  ),
  deps: [],
})

const client = (handler: (request: Request) => Promise<Response>) =>
  OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: Object.assign((input: string | URL | Request, init?: RequestInit) => handler(new Request(input, init)), {
      preconnect: fetch.preconnect,
    }),
  })

it.live("manages knowledge bases and searches them through the API", () =>
  Effect.gen(function* () {
    const dir = (yield* tmpdirScoped("opencode-knowledge-api-")).path
    const global = path.join(dir, "global")
    yield* Effect.promise(() => fs.mkdir(global, { recursive: true }))
    const handler = yield* ServerFetch.make({
      app: { version: "test" },
      database: { path: path.join(dir, "opencode.db") },
      config: { directory: global, project: true, claude: false },
      models: { fetch: false },
      fs: { filewatcher: false },
    }, { overrides: [Global.node.replace(Global.layerWith({ data: path.join(dir, "data"), config: global }))] })
    const knowledge = client(handler)["server.knowledge"]

    yield* Effect.promise(async () => {
      const base = (await knowledge.bases.create({ payload: { name: "arm64", description: "ARM64 reference" } })) as { id: string }
      await knowledge.entries.create({ baseID: base.id, payload: { entries: [{ title: "LC_MAIN", content: "the entry point of a Mach-O program" }] } })
      const found = (await knowledge.search({ payload: { query: "entry point", bases: [base.id] } })) as { hits: { title: string }[] }
      expect(found.hits.map((hit) => hit.title)).toEqual(["LC_MAIN"])
      expect(((await knowledge.bases.list()) as { entries: number }[])[0].entries).toBe(1)
      await expect(knowledge.settings.update({ payload: { search: { topK: 0 } } })).rejects.toMatchObject({ _tag: "InvalidRequestError" })
      await knowledge.bases.delete({ baseID: base.id })
      expect(await knowledge.bases.list()).toEqual([])
    })
  }),
)

it.live("converts Markdown into draft entries, skips what was already imported, and publishes", () =>
  Effect.gen(function* () {
    const dir = (yield* tmpdirScoped("opencode-knowledge-import-")).path
    const global = path.join(dir, "global")
    yield* Effect.promise(() => fs.mkdir(global, { recursive: true }))
    const handler = yield* ServerFetch.make(
      {
        app: { version: "test" },
        database: { path: path.join(dir, "opencode.db") },
        config: { directory: global, project: true, claude: false },
        models: { fetch: false },
        fs: { filewatcher: false },
      },
      { overrides: [Global.node.replace(Global.layerWith({ data: path.join(dir, "data"), config: global })), Generate.node.replace(generate)] },
    )
    const knowledge = client(handler)["server.knowledge"]

    yield* Effect.promise(async () => {
      const base = (await knowledge.bases.create({ payload: { name: "docs" } })) as { id: string }
      const markdown = `# Alpha\n\n${"a".repeat(1200)}\n\n# Beta\n\n${"b".repeat(1200)}`
      const started = (await knowledge.import.start({ baseID: base.id, payload: { markdown, name: "guide.md" } })) as { job: string; total: number }
      expect(started.total).toBe(2)
      const finished = await waitFor(async () => {
        const job = (await knowledge.import.job({ jobID: started.job })) as { status: string; done: number }
        return job.status === "running" ? undefined : job
      })
      expect(finished).toMatchObject({ status: "done", done: 2 })

      // Conversions wait as drafts: nothing is found until an admin publishes them.
      const entries = (await knowledge.entries.list({ baseID: base.id })) as { id: string; status: string; aliases: string[]; source: string }[]
      expect(entries).toHaveLength(2)
      expect(entries.every((entry) => entry.status === "draft" && entry.aliases[0] === "alias")).toBe(true)
      expect(entries[0].source).toContain("import:guide.md")
      expect(((await knowledge.search({ payload: { query: "Alpha", bases: [base.id] } })) as { hits: unknown[] }).hits).toHaveLength(0)

      // The same document again has nothing new to convert.
      const again = (await knowledge.import.start({ baseID: base.id, payload: { markdown, name: "guide.md" } })) as { skipped: number; total: number }
      expect(again).toMatchObject({ skipped: 2, total: 0 })

      await knowledge.entries.status({ baseID: base.id, payload: { status: "published" } })
      expect(((await knowledge.search({ payload: { query: "Alpha", bases: [base.id] } })) as { hits: { title: string }[] }).hits[0].title).toBe("Alpha")
    })
  }),
)

async function waitFor<T>(poll: () => Promise<T | undefined>) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await poll()
    if (value !== undefined) return value
    await Bun.sleep(50)
  }
  throw new Error("timed out waiting for the import")
}

it.live("finds an entry by meaning when no word matches, and falls back to keywords without a model", () =>
  Effect.gen(function* () {
    const dir = (yield* tmpdirScoped("opencode-knowledge-vector-")).path
    const global = path.join(dir, "global")
    yield* Effect.promise(() => fs.mkdir(global, { recursive: true }))
    const handler = yield* ServerFetch.make(
      {
        app: { version: "test" },
        database: { path: path.join(dir, "opencode.db") },
        config: { directory: global, project: true, claude: false },
        models: { fetch: false },
        fs: { filewatcher: false },
      },
      { overrides: [Global.node.replace(Global.layerWith({ data: path.join(dir, "data"), config: global })), Generate.node.replace(generate), Embedding.node.replace(embedding)] },
    )
    const knowledge = client(handler)["server.knowledge"]

    yield* Effect.promise(async () => {
      const base = (await knowledge.bases.create({ payload: { name: "animals" } })) as { id: string }
      type Found = { hits: { title: string; channels: { vector?: number; keyword?: number } }[]; degraded: string[] }
      const search = async (query: string) => (await knowledge.search({ payload: { query, bases: [base.id] } })) as Found

      // No embedding model is chosen yet, so entries have no vectors and a query only has its words.
      await knowledge.entries.create({
        baseID: base.id,
        payload: { entries: [{ title: "Equids", content: "All about the zebra" }, { title: "Fruit", content: "All about the apple" }] },
      })
      expect((await search("striped horse")).hits).toHaveLength(0)

      await knowledge.settings.update({ payload: { vector: { model: "fake/embed" } } })
      await knowledge.entries.create({ baseID: base.id, payload: { entries: [{ title: "Savanna", content: "The zebra grazes on the plain" }] } })
      const found = await search("striped horse")
      expect(found.hits.map((hit) => hit.title)).toEqual(["Savanna"])
      expect(found.hits[0].channels.vector).toBe(1)
      expect(found.hits[0].channels.keyword).toBeUndefined()
      expect((await knowledge.bases.stats({ baseID: base.id })) as { vectors: number }).toMatchObject({ vectors: 1 })

      // A base named rather than given by id is searched with its own embedding model too.
      const named = (await knowledge.search({ payload: { query: "striped horse", bases: ["animals"] } })) as Found
      expect(named.hits.map((hit) => hit.title)).toEqual(["Savanna"])
    })
  }),
)

// Stands in for a model that never answers with the JSON asked for.
const garbage = makeLocationNode({
  service: Generate.Service,
  layer: Layer.succeed(
    Generate.Service,
    Generate.Service.of({
      text: () => Effect.succeed("I cannot help with that."),
      image: () => Effect.die("unused"),
      decisions: () => Effect.die("unused"),
    }),
  ),
  deps: [],
})

it.live("an import whose every section the model fails to convert ends as failed with the reason", () =>
  Effect.gen(function* () {
    const dir = (yield* tmpdirScoped("opencode-knowledge-import-fail-")).path
    const global = path.join(dir, "global")
    yield* Effect.promise(() => fs.mkdir(global, { recursive: true }))
    const handler = yield* ServerFetch.make(
      {
        app: { version: "test" },
        database: { path: path.join(dir, "opencode.db") },
        config: { directory: global, project: true, claude: false },
        models: { fetch: false },
        fs: { filewatcher: false },
      },
      { overrides: [Global.node.replace(Global.layerWith({ data: path.join(dir, "data"), config: global })), Generate.node.replace(garbage)] },
    )
    const knowledge = client(handler)["server.knowledge"]

    yield* Effect.promise(async () => {
      const base = (await knowledge.bases.create({ payload: { name: "docs" } })) as { id: string }
      await expect(knowledge.import.start({ baseID: base.id, payload: { markdown: "   " } })).rejects.toMatchObject({ _tag: "InvalidRequestError" })
      const started = (await knowledge.import.start({ baseID: base.id, payload: { markdown: "# Only\n\nsome text" } })) as { job: string }
      const finished = await waitFor(async () => {
        const job = (await knowledge.import.job({ jobID: started.job })) as { status: string; error: string }
        return job.status === "running" ? undefined : job
      })
      expect(finished.status).toBe("failed")
      expect(finished.error).toContain("expected format")
      expect(await knowledge.entries.list({ baseID: base.id })).toEqual([])
    })
  }),
)

// Like `embedding`, but model "two" points every meaning the other way, so with a query of the wrong model the least
// related entry ranks first.
const perModel = makeLocationNode({
  service: Embedding.Service,
  layer: Layer.succeed(
    Embedding.Service,
    Embedding.Service.of({
      embed: (texts, settings) => Effect.succeed(texts.map((text) => inSpaceOf(settings.model, text))),
      embedQuery: (text, settings) => Effect.succeed(inSpaceOf(settings.model, text)),
    }),
  ),
  deps: [],
})
const inSpaceOf = (model: unknown, text: string) =>
  JSON.stringify(model).includes("two") || text.startsWith("question: ") ? vectorOf(text).map((value) => -value) : vectorOf(text)

it.live("searches bases with different embedding models and prefixes using their own query vectors", () =>
  Effect.gen(function* () {
    const dir = (yield* tmpdirScoped("opencode-knowledge-models-")).path
    const global = path.join(dir, "global")
    yield* Effect.promise(() => fs.mkdir(global, { recursive: true }))
    const handler = yield* ServerFetch.make(
      {
        app: { version: "test" },
        database: { path: path.join(dir, "opencode.db") },
        config: { directory: global, project: true, claude: false },
        models: { fetch: false },
        fs: { filewatcher: false },
      },
      { overrides: [Global.node.replace(Global.layerWith({ data: path.join(dir, "data"), config: global })), Embedding.node.replace(perModel)] },
    )
    const knowledge = client(handler)["server.knowledge"]

    yield* Effect.promise(async () => {
      // The platform has no model; each base chooses its own.
      const first = (await knowledge.bases.create({ payload: { name: "zoo" } })) as { id: string }
      const second = (await knowledge.bases.create({ payload: { name: "farm" } })) as { id: string }
      const third = (await knowledge.bases.create({ payload: { name: "reserve" } })) as { id: string }
      await knowledge.bases.settings.update({ baseID: first.id, payload: { vector: { model: "fake/one" } } })
      await knowledge.bases.settings.update({ baseID: second.id, payload: { vector: { model: "fake/two" } } })
      await knowledge.bases.settings.update({ baseID: third.id, payload: { vector: { model: "fake/one", queryPrefix: "question: ", documentPrefix: "question: " } } })
      await knowledge.entries.create({ baseID: first.id, payload: { entries: [{ title: "Savanna", content: "The zebra grazes" }] } })
      await knowledge.entries.create({
        baseID: second.id,
        payload: { entries: [{ title: "Paddock", content: "A zebra foal" }, { title: "Orchard", content: "Apple trees" }] },
      })
      await knowledge.entries.create({ baseID: third.id, payload: { entries: [{ title: "Grassland", content: "A zebra herd" }, { title: "Garden", content: "Apple trees" }] } })
      const found = (await knowledge.search({ payload: { query: "striped horse", bases: ["zoo", "farm", "reserve"] } })) as { hits: { title: string; channels: { vector?: number } }[] }
      const best = found.hits.filter((hit) => hit.channels.vector === 1).map((hit) => hit.title)
      expect(best.sort()).toEqual(["Grassland", "Paddock", "Savanna"])
    })
  }),
)

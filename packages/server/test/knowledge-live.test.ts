import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { OpenCode } from "@opencode/client"
import { Effect } from "effect"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

// Runs the real thing against a local LM Studio: a real chat model converts Markdown and a real embedding model makes the
// vectors. Needs `lms server start` with the models below loaded (the embedding model with `lms load <id> -c 1024`);
// skipped unless OPENCODE_TEST_LMSTUDIO is set.
const live = process.env.OPENCODE_TEST_LMSTUDIO ? it.live : it.live.skip
const EMBED = process.env.OPENCODE_TEST_EMBED_MODEL ?? "text-embedding-qwen3-embedding-0.6b"
const CHAT = process.env.OPENCODE_TEST_CHAT_MODEL ?? "google/gemma-4-12b"

const client = (handler: (request: Request) => Promise<Response>) =>
  OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: Object.assign((input: string | URL | Request, init?: RequestInit) => handler(new Request(input, init)), {
      preconnect: fetch.preconnect,
    }),
  })

const document = `# Mach-O 加载命令

Mach-O 文件头之后是一组加载命令(load command)。LC_MAIN 指定程序入口点的文件偏移,dyld 会从这里开始执行主程序。
LC_LOAD_DYLIB 列出程序依赖的动态库,例如 libSystem.B.dylib。

# Electron 应用的代码打包

Electron 应用通常把 JavaScript 打包进 app.asar 归档文件,位于 Resources 目录下。使用 asar extract 可以把它解开,
解开后能看到 main.js 与 package.json,逆向时先从 package.json 的 main 字段找到入口。`

const configured = (global: string) =>
  fs.writeFile(
    path.join(global, "opencode.json"),
    JSON.stringify({
      model: `lmstudio/${CHAT}`,
      providers: {
        "lmstudio-embed": {
          name: "LM Studio embeddings",
          settings: { baseURL: "http://127.0.0.1:1234/v1" },
          models: { [EMBED]: { name: "nomic", type: "embedding" } },
        },
      },
    }),
  )

// Quick check that the embedding model is found and used, without waiting for a chat model to convert anything.
live("embeds entries and finds one by meaning", () =>
  Effect.gen(function* () {
    const dir = (yield* tmpdirScoped("opencode-knowledge-embed-")).path
    const global = path.join(dir, "global")
    yield* Effect.promise(() => fs.mkdir(global, { recursive: true }))
    yield* Effect.promise(() => configured(global))
    const handler = yield* ServerFetch.make({
      app: { version: "test" },
      database: { path: path.join(dir, "opencode.db") },
      config: { directory: global, project: true, claude: false },
      models: { fetch: false },
      fs: { filewatcher: false },
    })
    const knowledge = client(handler)["server.knowledge"]
    yield* Effect.promise(async () => {
      await knowledge.settings.update({ payload: { vector: { model: `lmstudio-embed/${EMBED}` } } })
      const base = (await knowledge.bases.create({ payload: { name: "re" } })) as { id: string }
      await knowledge.entries.create({
        baseID: base.id,
        payload: {
          entries: [
            { title: "Mach-O 加载命令", content: "LC_MAIN 指定程序入口点的文件偏移,dyld 从这里开始执行主程序。" },
            { title: "Electron 打包", content: "Electron 应用把 JavaScript 打包进 app.asar,用 asar extract 解开。" },
            { title: "水果", content: "苹果和香蕉富含维生素。" },
          ],
        },
      })
      const stats = (await knowledge.bases.stats({ baseID: base.id })) as { published: number; vectors: number }
      console.log("stats:", JSON.stringify(stats))
      expect(stats.vectors).toBe(3)
      const found = (await knowledge.search({ payload: { query: "程序是从哪里开始跑起来的", bases: [base.id], topK: 3 } })) as { hits: { title: string; channels: object }[]; degraded: string[]; ms: number }
      console.log(found.hits.map((hit) => `${hit.title} ${JSON.stringify(hit.channels)}`), found.degraded, `${found.ms}ms`)
      expect(found.hits[0].title).toBe("Mach-O 加载命令")

      // No word of this question is in the entry it should find, so only the vector can.
      const unpack = (await knowledge.search({ payload: { query: "怎么把桌面应用的前端代码解包出来", bases: [base.id], topK: 3 } })) as { hits: { title: string; channels: { vector?: number; keyword?: number } }[] }
      console.log(unpack.hits.map((hit) => `${hit.title} ${JSON.stringify(hit.channels)}`))
      expect(unpack.hits[0].title).toBe("Electron 打包")
      expect(unpack.hits[0].channels.vector).toBe(1)
    })
  }),
  120_000,
)

live("converts a real document with a real model and finds it by meaning", () =>
  Effect.gen(function* () {
    const dir = (yield* tmpdirScoped("opencode-knowledge-live-")).path
    const global = path.join(dir, "global")
    yield* Effect.promise(() => fs.mkdir(global, { recursive: true }))
    yield* Effect.promise(() => configured(global))
    const handler = yield* ServerFetch.make({
      app: { version: "test" },
      database: { path: path.join(dir, "opencode.db") },
      config: { directory: global, project: true, claude: false },
      models: { fetch: false },
      fs: { filewatcher: false },
    })
    const knowledge = client(handler)["server.knowledge"]

    yield* Effect.promise(async () => {
      await knowledge.settings.update({ payload: { vector: { model: `lmstudio-embed/${EMBED}` }, import: { model: `lmstudio/${CHAT}`, chunkChars: 600, overlap: 50 } } })
      const base = (await knowledge.bases.create({ payload: { name: "re", description: "逆向工程资料" } })) as { id: string }
      const started = (await knowledge.import.start({ baseID: base.id, payload: { markdown: document, name: "re.md" } })) as { job: string; total: number }
      console.log("sections to convert:", started.total)
      let job = (await knowledge.import.job({ jobID: started.job })) as { status: string; done: number; error: string }
      for (let attempt = 0; job.status === "running" && attempt < 600; attempt++) {
        await Bun.sleep(1000)
        job = (await knowledge.import.job({ jobID: started.job })) as typeof job
      }
      console.log("job:", JSON.stringify(job))
      expect(job.status).toBe("done")

      const drafts = (await knowledge.entries.list({ baseID: base.id })) as { title: string; summary: string; aliases: string[]; questions: string[]; status: string }[]
      console.log(JSON.stringify(drafts.map((entry) => ({ title: entry.title, aliases: entry.aliases, questions: entry.questions })), null, 1))
      expect(drafts.length).toBeGreaterThan(1)
      expect(drafts.every((entry) => entry.status === "draft" && entry.questions.length > 0)).toBe(true)
      await knowledge.entries.status({ baseID: base.id, payload: { status: "published" } })

      const stats = (await knowledge.bases.stats({ baseID: base.id })) as { published: number; vectors: number }
      console.log("stats:", JSON.stringify(stats))

      // Questions that share no wording with the text still have to find it.
      const ask = async (query: string) => {
        const found = (await knowledge.search({ payload: { query, bases: [base.id], topK: 3 } })) as { hits: { title: string; channels: object }[]; degraded: string[]; ms: number }
        console.log(query, "=>", found.hits.map((hit) => `${hit.title} ${JSON.stringify(hit.channels)}`), found.degraded, `${found.ms}ms`)
        return found
      }
      expect(stats.vectors).toBe(stats.published)
      const entry = await ask("程序是从哪里开始跑起来的")
      expect(entry.degraded).toEqual([])
      expect(entry.hits[0].title).toMatch(/LC_MAIN|入口|Mach/i)
      const unpack = await ask("怎么把桌面应用的前端代码解包出来")
      expect(unpack.hits[0].title).toMatch(/asar|Electron|打包|解/i)
    })
  }),
  600_000,
)

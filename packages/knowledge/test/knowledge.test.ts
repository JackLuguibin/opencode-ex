import { describe, expect, setSystemTime, test } from "bun:test"
import { Knowledge } from "../src/knowledge.js"
import { Tokenize } from "../src/tokenize.js"

const admin = { userID: "u1", admin: true, organizationID: undefined }
const member = (organizationID: string) => ({ userID: "u2", admin: false, organizationID })

const fresh = () => Knowledge.open(":memory:")

describe("tokenize", () => {
  test("cuts Chinese into words and keeps identifiers whole", () => {
    expect(Tokenize.words("逆向工程的专业知识库检索")).toEqual(["逆向", "工程", "的", "专业", "知识", "库", "检索"])
    expect(Tokenize.words("LC_MAIN 0xFEEDFACF")).toEqual(["lc_main", "0xfeedfacf"])
  })

  test("a custom term is emitted next to its parts", () => {
    expect(Tokenize.words("知识库", new Set(["知识库"]))).toContain("知识库")
  })
})

describe("knowledge", () => {
  test("a member only sees bases granted to their organization", async () => {
    const service = fresh()
    const base = service.bases.create(admin, { name: "arm64" })
    await service.entries.create(admin, base.id, [{ title: "B instruction", content: "unconditional branch" }])
    expect(service.bases.list(member("org_a"))).toHaveLength(0)
    service.bases.grant(admin, base.id, ["org_a"])
    expect(service.bases.list(member("org_a"))).toHaveLength(1)
    expect(service.bases.list(member("org_b"))).toHaveLength(0)
    expect((await service.search(member("org_b"), { query: "branch" })).hits).toHaveLength(0)
    expect((await service.search(member("org_a"), { query: "branch" })).hits).toHaveLength(1)
  })

  test("only a platform administrator can write", async () => {
    const service = fresh()
    expect(() => service.bases.create(member("org_a"), { name: "x" })).toThrow("only a platform administrator")
  })

  test("finds Chinese two-character words, identifiers and exact titles", async () => {
    const service = fresh()
    const base = service.bases.create(admin, { name: "re" })
    service.bases.grant(admin, base.id, ["org_a"])
    await service.entries.create(admin, base.id, [
      { title: "知识库检索", content: "通过关键词和向量混合检索知识。" },
      { title: "Mach-O 加载命令", content: "LC_MAIN 指定程序入口,0xFEEDFACF 是 64 位魔数。" },
      { title: "无关内容", content: "今天天气很好" },
    ])
    const find = async (query: string) => (await service.search(member("org_a"), { query })).hits.map((hit) => hit.title)
    expect(await find("检索")).toEqual(["知识库检索"])
    expect(await find("LC_MAIN")).toEqual(["Mach-O 加载命令"])
    expect(await find("0xFEEDFACF")).toEqual(["Mach-O 加载命令"])
    expect((await service.search(member("org_a"), { query: "知识库检索" })).hits[0].channels.exact).toBe(true)
  })

  test("aliases and questions make different wording match", async () => {
    const service = fresh()
    const base = service.bases.create(admin, { name: "re" })
    await service.entries.create(admin, base.id, [
      { title: "程序入口", content: "由加载命令指定。", aliases: ["entry point"], questions: ["程序从哪里开始执行"] },
    ])
    expect((await service.search(admin, { query: "entry point" })).hits).toHaveLength(1)
    expect((await service.search(admin, { query: "程序从哪里开始执行" })).hits).toHaveLength(1)
  })

  test("drafts are not found until published", async () => {
    const service = fresh()
    const base = service.bases.create(admin, { name: "re" })
    service.bases.grant(admin, base.id, ["org_a"])
    const [created] = await service.entries.create(admin, base.id, [{ title: "草稿条目", content: "内容", status: "draft" }])
    expect((await service.search(member("org_a"), { query: "草稿" })).hits).toHaveLength(0)
    expect(() => service.entries.get(member("org_a"), created.entry.id)).toThrow("not found")
    await service.entries.setStatus(admin, base.id, [created.entry.id], "published")
    expect((await service.search(member("org_a"), { query: "草稿" })).hits).toHaveLength(1)
  })

  test("update re-indexes and delete removes", async () => {
    const service = fresh()
    const base = service.bases.create(admin, { name: "re" })
    const [created] = await service.entries.create(admin, base.id, [{ title: "alpha", content: "first text" }])
    await service.entries.update(admin, created.entry.id, { title: "beta", content: "second text" })
    expect((await service.search(admin, { query: "alpha" })).hits).toHaveLength(0)
    expect((await service.search(admin, { query: "beta" })).hits).toHaveLength(1)
    await service.entries.remove(admin, created.entry.id)
    expect((await service.search(admin, { query: "beta" })).hits).toHaveLength(0)
  })

  test("vectors rank by similarity and are fused with keywords", async () => {
    const service = fresh()
    const base = service.bases.create(admin, { name: "v" })
    await service.entries.create(admin, base.id, [
      { title: "甲", content: "完全不同的文字", vector: { model: "m", values: [1, 0, 0] } },
      { title: "乙", content: "另一段文字", vector: { model: "m", values: [0, 1, 0] } },
    ])
    const found = await service.search(admin, { query: "没有关键词命中", vector: [0.9, 0.1, 0] })
    expect(found.hits[0].title).toBe("甲")
    expect(found.hits[0].channels.vector).toBe(1)
    expect(found.degraded).toEqual([])
  })

  test("an unreachable vector store degrades to keywords instead of failing", async () => {
    const service = fresh()
    const base = service.bases.create(admin, { name: "v" })
    await service.entries.create(admin, base.id, [{ title: "关键词条目", content: "内容" }])
    service.settings.patchBase(admin, base.id, { vector: { store: { type: "qdrant", url: "http://127.0.0.1:1" }, storeTimeoutMs: 200 } })
    const found = await service.search(admin, { query: "关键词", vector: [1, 0, 0] })
    expect(found.hits).toHaveLength(1)
    expect(found.degraded).toEqual(["vector"])
  })

  test("settings reject out-of-range values and never return the secret", async () => {
    const service = fresh()
    expect(() => service.settings.patchPlatform(admin, { search: { topK: 0 } })).toThrow("search.topK")
    expect(() => service.settings.patchPlatform(admin, { nope: 1 })).toThrow("not a setting")
    const saved = service.settings.patchPlatform(admin, { vector: { store: { type: "qdrant", url: "http://q", secret: "s3cret" } } })
    expect(JSON.stringify(saved)).not.toContain("s3cret")
    expect(saved.vector.store.hasSecret).toBe(true)
    const kept = service.settings.patchPlatform(admin, { vector: { store: { url: "http://q2" } } })
    expect(kept.vector.store.hasSecret).toBe(true)
  })

  test("a base overrides the platform default", async () => {
    const service = fresh()
    const base = service.bases.create(admin, { name: "re" })
    service.settings.patchPlatform(admin, { search: { topK: 3 } })
    expect(service.settings.base(admin, base.id).effective.search.topK).toBe(3)
    service.settings.patchBase(admin, base.id, { search: { topK: 9 } })
    expect(service.settings.base(admin, base.id).effective.search.topK).toBe(9)
  })

  test("revoking an organization removes every grant", async () => {
    const service = fresh()
    const base = service.bases.create(admin, { name: "re" })
    service.bases.grant(admin, base.id, ["org_a", "org_b"])
    service.bases.revoke(admin, "org_a")
    expect(service.bases.get(admin, base.id).organizations).toEqual(["org_b"])
  })

  test("evaluation reports recall at 5", async () => {
    const service = fresh()
    const base = service.bases.create(admin, { name: "re" })
    const [created] = await service.entries.create(admin, base.id, [{ title: "程序入口", content: "由 LC_MAIN 指定" }])
    service.evaluation.addCase(admin, base.id, { question: "LC_MAIN", expected: created.entry.id })
    service.evaluation.addCase(admin, base.id, { question: "完全无关的问题", expected: created.entry.id })
    const run = await service.evaluation.run(admin, base.id, {})
    expect(run.recall).toBe(0.5)
  })

  test("a partial update keeps the fields and vector it leaves out", async () => {
    const service = fresh()
    const base = service.bases.create(admin, { name: "partial" })
    const [created] = await service.entries.create(admin, base.id, [
      { title: "LC_MAIN", content: "entry point", vector: { model: "m", values: [1, 0] } },
    ])
    const drafted = await service.entries.update(admin, created.entry.id, { title: undefined, content: undefined, status: "draft" })
    expect(drafted.entry.title).toBe("LC_MAIN")
    expect(drafted.entry.status).toBe("draft")
    expect(drafted.entry.vectorModel).toBe("m")
    const rewritten = await service.entries.update(admin, created.entry.id, { content: "something else" })
    expect(rewritten.entry.vectorModel).toBeUndefined()
  })

  test("vectors of a previous embedding model do not break search after the model changes", async () => {
    const service = fresh()
    const base = service.bases.create(admin, { name: "models" })
    service.settings.patchBase(admin, base.id, { vector: { model: "old" } })
    await service.entries.create(admin, base.id, [{ title: "old entry", content: "x", vector: { model: "old", values: [1, 0] } }])
    expect((await service.search(admin, { query: "zzz", vector: [1, 0], bases: [base.id] })).hits).toHaveLength(1)
    service.settings.patchBase(admin, base.id, { vector: { model: "new" } })
    const [fresh3] = await service.entries.create(admin, base.id, [
      { title: "new entry", content: "y", vector: { model: "new", values: [0, 0, 1] } },
    ])
    expect(fresh3.indexed).toBe(true)
    const found = await service.search(admin, { query: "zzz", vector: [0, 0, 1], bases: [base.id] })
    expect(found.degraded).toEqual([])
    expect(found.hits.map((hit) => hit.title)).toEqual(["new entry"])
    expect(await service.reindex(admin, base.id)).toEqual({ indexed: 1 })
  })
  test("a batch with one invalid entry writes none of them", async () => {
    const service = fresh()
    const base = service.bases.create(admin, { name: "b" })
    await expect(
      service.entries.create(admin, base.id, [{ title: "kept?", content: "x" }, { title: " ", content: "y" }]),
    ).rejects.toThrow("title is required")
    expect(service.entries.list(admin, base.id, {})).toHaveLength(0)
  })

  test("a vector written with another model than the configured one stays out of the index", async () => {
    const service = fresh()
    const base = service.bases.create(admin, { name: "b" })
    service.settings.patchBase(admin, base.id, { vector: { model: "p/new" } })
    await service.entries.create(admin, base.id, [
      { title: "current", content: "c", vector: { model: "p/new", values: [1, 0] } },
      { title: "stale", content: "c", vector: { model: "p/old", values: [0, 1] } },
    ])
    const found = await service.search(admin, { query: "zzz", vector: [0, 1], bases: [base.id] })
    expect(found.hits.map((hit) => hit.title)).toEqual(["current"])
  })

  test("publishing a draft with a stale vector keeps it out of the index", async () => {
    const service = fresh()
    const base = service.bases.create(admin, { name: "b" })
    service.settings.patchBase(admin, base.id, { vector: { model: "p/new" } })
    const [draft] = await service.entries.create(admin, base.id, [
      { title: "draft", content: "c", status: "draft", vector: { model: "p/old", values: [0, 1] } },
    ])
    await service.entries.setStatus(admin, base.id, [draft.entry.id], "published")
    expect((await service.search(admin, { query: "zzz", vector: [0, 1], bases: [base.id] })).hits).toHaveLength(0)
  })

  test("settings of a base can be read by its name, as search accepts", () => {
    const service = fresh()
    const base = service.bases.create(admin, { name: "arm64" })
    service.settings.patchBase(admin, base.id, { vector: { model: "p/e" } })
    service.bases.grant(admin, base.id, ["org_a"])
    expect(service.settings.base(member("org_a"), "arm64").effective.vector.model).toBe("p/e")
    expect(() => service.settings.base(member("org_b"), "arm64")).toThrow("not found")
  })

  test("an evaluation case needs a question and an entry of the same base", async () => {
    const service = fresh()
    const base = service.bases.create(admin, { name: "a" })
    const other = service.bases.create(admin, { name: "b" })
    const [entry] = await service.entries.create(admin, other.id, [{ title: "t", content: "c" }])
    expect(() => service.evaluation.addCase(admin, base.id, { question: " ", expected: entry.entry.id })).toThrow("question is required")
    expect(() => service.evaluation.addCase(admin, base.id, { question: "q", expected: entry.entry.id })).toThrow("not in this knowledge base")
    expect(() => service.evaluation.addCase(admin, other.id, { question: "q", expected: entry.entry.id })).not.toThrow()
  })

  test("an empty id list changes nothing", async () => {
    const service = fresh()
    const base = service.bases.create(admin, { name: "b" })
    await service.entries.create(admin, base.id, [{ title: "t", content: "c" }])
    expect(await service.entries.setStatus(admin, base.id, [], "draft")).toBe(0)
    expect(service.bases.get(admin, base.id).entries).toBe(1)
  })

  test("deleting a base removes its entries from search and its cases", async () => {
    const service = fresh()
    const base = service.bases.create(admin, { name: "b" })
    const [entry] = await service.entries.create(admin, base.id, [{ title: "gone", content: "c", vector: { model: "m", values: [1, 0] } }])
    service.evaluation.addCase(admin, base.id, { question: "gone", expected: entry.entry.id })
    await service.bases.remove(admin, base.id)
    expect((await service.search(admin, { query: "gone", vector: [1, 0] })).hits).toHaveLength(0)
    expect(() => service.entries.get(admin, entry.entry.id)).toThrow("entry not found")
  })

  test("a member never sees drafts, by list, get or search", async () => {
    const service = fresh()
    const base = service.bases.create(admin, { name: "b" })
    service.bases.grant(admin, base.id, ["org_a"])
    const [draft] = await service.entries.create(admin, base.id, [{ title: "secret", content: "c", status: "draft" }])
    expect(service.entries.list(member("org_a"), base.id, { status: "draft" })).toHaveLength(0)
    expect(() => service.entries.get(member("org_a"), draft.entry.id)).toThrow("entry not found")
    expect(service.bases.get(member("org_a"), base.id).drafts).toBe(0)
    expect((await service.search(member("org_a"), { query: "secret" })).hits).toHaveLength(0)
  })

  test("search text that is only punctuation or FTS syntax finds nothing instead of failing", async () => {
    const service = fresh()
    const base = service.bases.create(admin, { name: "b" })
    await service.entries.create(admin, base.id, [{ title: "t", content: "c" }])
    for (const query of ["", "   ", "\"*\"", "AND OR NOT", "title:t", "(((", "%_"])
      expect(Array.isArray((await service.search(admin, { query })).hits)).toBe(true)
  })

  test("list filters by text with LIKE wildcards taken literally and pages", async () => {
    const service = fresh()
    const base = service.bases.create(admin, { name: "b" })
    await service.entries.create(admin, base.id, [
      { title: "100% off", content: "c" },
      { title: "1000 off", content: "c" },
      ...Array.from({ length: 5 }, (_, index) => ({ title: `n${index}`, content: "c" })),
    ])
    expect(service.entries.list(admin, base.id, { q: "100%" }).map((entry) => entry.title)).toEqual(["100% off"])
    expect(service.entries.list(admin, base.id, { limit: 3 })).toHaveLength(3)
    expect(service.entries.list(admin, base.id, { limit: 3, offset: 6 })).toHaveLength(1)
  })
  test("bases with different embedding models are each searched with their own query vector", async () => {
    const service = fresh()
    const a = service.bases.create(admin, { name: "a" })
    const b = service.bases.create(admin, { name: "b" })
    service.settings.patchBase(admin, a.id, { vector: { model: "p/one", queryPrefix: "q: " } })
    service.settings.patchBase(admin, b.id, { vector: { model: "p/two" } })
    await service.entries.create(admin, a.id, [{ title: "in a", content: "c", vector: { model: "p/one", values: [1, 0] } }])
    await service.entries.create(admin, b.id, [{ title: "in b", content: "c", vector: { model: "p/two", values: [0, 1, 0] } }])
    expect(service.searchModels(admin, undefined).map((item) => [item.model, item.queryPrefix]).sort()).toEqual([
      ["p/one", "q: "],
      ["p/two", ""],
    ])
    expect(service.searchModels(admin, ["b"]).map((item) => item.model)).toEqual(["p/two"])
    const found = await service.search(admin, { query: "zzz", vectors: { "p/one": [1, 0], "p/two": [0, 1, 0] } })
    expect(found.hits.map((hit) => hit.title).sort()).toEqual(["in a", "in b"])
  })

  test("only bases a member may search decide which models are needed", () => {
    const service = fresh()
    const base = service.bases.create(admin, { name: "a" })
    service.settings.patchBase(admin, base.id, { vector: { model: "p/one" } })
    expect(service.searchModels(member("org_a"), undefined)).toEqual([])
    service.bases.grant(admin, base.id, ["org_a"])
    expect(service.searchModels(member("org_a"), undefined).map((item) => item.model)).toEqual(["p/one"])
  })

  test("a second import into a base is refused while one runs, but not after it stalls", () => {
    const service = fresh()
    const base = service.bases.create(admin, { name: "a" })
    const job = service.jobs.create(admin, base.id, 2)
    expect(() => service.jobs.create(admin, base.id, 2)).toThrow("still running")
    service.jobs.update(admin, job, { status: "done" })
    const next = service.jobs.create(admin, base.id, 2)
    setSystemTime(new Date(Date.now() + 11 * 60_000))
    expect(() => service.jobs.create(admin, base.id, 2)).not.toThrow()
    setSystemTime()
    expect(next).toStartWith("kj_")
  })
  test("a base set up for vectors that gets no query vector of its model reports the search as degraded", async () => {
    const service = fresh()
    const base = service.bases.create(admin, { name: "a" })
    const plain = service.bases.create(admin, { name: "b" })
    service.settings.patchBase(admin, base.id, { vector: { model: "p/one" } })
    await service.entries.create(admin, base.id, [{ title: "关键词", content: "c" }])
    const found = await service.search(admin, { query: "关键词", vectors: {} })
    expect(found.hits).toHaveLength(1)
    expect(found.degraded).toEqual(["vector"])
    expect((await service.search(admin, { query: "关键词", bases: [plain.id] })).degraded).toEqual([])
  })

  test("changing custom terms rebuilds the keyword index of the bases they apply to", async () => {
    const service = fresh()
    const base = service.bases.create(admin, { name: "a" })
    await service.entries.create(admin, base.id, [{ title: "t", content: "LC MAIN 段" }])
    const tokens = () => service.search(admin, { query: "lcmain", bases: [base.id] })
    expect((await tokens()).hits).toHaveLength(0)
    service.settings.patchBase(admin, base.id, { terms: ["lcmain"] })
    expect((await tokens()).hits).toHaveLength(1)
    const other = service.bases.create(admin, { name: "b" })
    await service.entries.create(admin, other.id, [{ title: "t", content: "LC MAIN 段" }])
    service.settings.patchPlatform(admin, { terms: ["lcmain"] })
    expect((await service.search(admin, { query: "lcmain", bases: [other.id] })).hits).toHaveLength(1)
  })
})

import { describe, expect, test } from "bun:test"
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
})

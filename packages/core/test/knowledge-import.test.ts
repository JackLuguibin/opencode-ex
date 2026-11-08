import { describe, expect, test } from "bun:test"
import { KnowledgeImport } from "../src/knowledge-import"

const options = { chunkChars: 400, overlap: 40 }

describe("KnowledgeImport.split", () => {
  test("packs small sections together and keeps headings in the text", () => {
    const sections = KnowledgeImport.split("# A\n\nfirst\n\n## B\n\nsecond", options)
    expect(sections).toHaveLength(1)
    expect(sections[0].text).toContain("## B")
  })

  test("starts a new section at a top-level heading once the current one has substance", () => {
    const body = "x".repeat(150)
    const sections = KnowledgeImport.split(`# One\n\n${body}\n\n# Two\n\n${body}`, options)
    expect(sections.map((section) => section.path[0])).toEqual(["One", "Two"])
  })

  test("does not cut inside a code block or treat its # lines as headings", () => {
    const sections = KnowledgeImport.split("# T\n\n```sh\n# not a heading\nls\n```\n\ntext", options)
    expect(sections).toHaveLength(1)
    expect(sections[0].path).toEqual(["T"])
  })

  test("splits oversized text and gives each piece the tail of the last", () => {
    const paragraphs = Array.from({ length: 12 }, (_, index) => `paragraph ${index} ${"y".repeat(100)}`).join("\n\n")
    const sections = KnowledgeImport.split(paragraphs, options)
    expect(sections.length).toBeGreaterThan(2)
    expect(sections.every((section) => section.text.length <= options.chunkChars + options.overlap + 2)).toBe(true)
  })

  test("the hash is stable and changes with the text", () => {
    const one = KnowledgeImport.split("# A\n\nhello", options)[0].hash
    expect(KnowledgeImport.split("# A\n\nhello", options)[0].hash).toBe(one)
    expect(KnowledgeImport.split("# A\n\nhello!", options)[0].hash).not.toBe(one)
  })
})

describe("KnowledgeImport.parse", () => {
  test("reads the JSON the model was asked for, with or without a code fence", () => {
    const body = '{"entries":[{"title":"T","content":"C","aliases":["a"]},{"title":" ","content":"x"}]}'
    expect(KnowledgeImport.parse(body)).toEqual([{ title: "T", content: "C", aliases: ["a"] }])
    expect(KnowledgeImport.parse("```json\n" + body + "\n```")).toHaveLength(1)
  })

  test("refuses an answer that is not that JSON", () => {
    expect(KnowledgeImport.parse("Sure! Here you go")).toBeUndefined()
    expect(KnowledgeImport.parse('{"entries": "none"}')).toBeUndefined()
  })
})

describe("KnowledgeImport.prompt", () => {
  test("only asks for the fields that are switched on", () => {
    const section = { path: ["A"], text: "body", hash: "h" }
    const on = KnowledgeImport.prompt(section, { aliases: true, questions: true, summary: true })
    const off = KnowledgeImport.prompt(section, { aliases: false, questions: false, summary: false })
    expect(on).toContain('"questions"')
    expect(off).not.toContain('"questions"')
    expect(on).toContain("Headings above the fragment: A")
  })
})

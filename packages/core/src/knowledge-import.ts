export * as KnowledgeImport from "./knowledge-import.js"

import { createHash } from "node:crypto"
import { Option, Schema } from "effect"

export type Options = {
  readonly chunkChars: number
  readonly overlap: number
  readonly aliases: boolean
  readonly questions: boolean
  readonly summary: boolean
}

/** A piece of a document small enough to convert in one model call. `path` is the headings above it. */
export type Section = { readonly path: ReadonlyArray<string>; readonly text: string; readonly hash: string }

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const FENCE = /^\s*(```|~~~)/

type Block = { readonly path: ReadonlyArray<string>; readonly level: number; readonly lines: string[] }

/**
 * Cuts Markdown into sections of at most `chunkChars`, following its headings so a section stays about one topic. Small
 * neighbours are packed together to save model calls, and a section is never cut inside a code block. The hash covers the
 * headings and the text, so an unchanged section is recognised on a later import and skipped.
 */
export function split(markdown: string, options: Pick<Options, "chunkChars" | "overlap">): Section[] {
  const blocks = blocksOf(markdown)
  const packed = blocks.reduce<{ path: ReadonlyArray<string>; level: number; text: string }[]>((chunks, block) => {
    const text = block.lines.join("\n").trim()
    if (!text) return chunks
    const last = chunks.at(-1)
    // A new top-level heading starts a new section once the current one has some substance.
    const topic = block.level > 0 && block.level <= 2 && last && last.text.length >= options.chunkChars / 4
    if (last && !topic && last.text.length + text.length + 2 <= options.chunkChars)
      return [...chunks.slice(0, -1), { ...last, text: `${last.text}\n\n${text}` }]
    return [...chunks, { path: block.path, level: block.level, text }]
  }, [])
  return packed.flatMap((chunk) =>
    pieces(chunk.text, options).map((text) => ({
      path: chunk.path,
      text,
      hash: createHash("sha1").update(`${chunk.path.join(">")}\n${text}`).digest("hex"),
    })),
  )
}

function blocksOf(markdown: string): Block[] {
  const stack: { level: number; title: string }[] = []
  const blocks: Block[] = []
  let fenced = false
  let current: Block = { path: [], level: 0, lines: [] }
  const flush = () => {
    if (current.lines.length > 0) blocks.push(current)
  }
  markdown.replaceAll("\r\n", "\n").split("\n").forEach((line) => {
    if (FENCE.test(line)) fenced = !fenced
    const heading = fenced ? undefined : HEADING.exec(line)
    if (!heading) return void current.lines.push(line)
    flush()
    const level = heading[1].length
    while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop()
    stack.push({ level, title: heading[2] })
    current = { path: stack.map((item) => item.title), level, lines: [line] }
  })
  flush()
  return blocks
}

// Splits text that is still too long at paragraph breaks, then at line breaks, and keeps code fences whole where it can.
function pieces(text: string, options: Pick<Options, "chunkChars" | "overlap">): string[] {
  if (text.length <= options.chunkChars) return [text]
  const paragraphs = text.split(/\n{2,}/)
  const out: string[] = []
  let buffer = ""
  paragraphs.forEach((paragraph) => {
    if (paragraph.length > options.chunkChars) {
      if (buffer) out.push(buffer)
      buffer = ""
      out.push(...hardSplit(paragraph, options.chunkChars))
      return
    }
    if (buffer && buffer.length + paragraph.length + 2 > options.chunkChars) {
      out.push(buffer)
      // The tail of the previous piece gives the next one the context it starts in.
      buffer = `${buffer.slice(-options.overlap)}\n\n${paragraph}`.trimStart()
      return
    }
    buffer = buffer ? `${buffer}\n\n${paragraph}` : paragraph
  })
  if (buffer) out.push(buffer)
  return out
}

function hardSplit(text: string, size: number) {
  const out: string[] = []
  let rest = text
  while (rest.length > size) {
    const cut = rest.lastIndexOf("\n", size)
    const at = cut > size / 2 ? cut : size
    out.push(rest.slice(0, at))
    rest = rest.slice(at).trimStart()
  }
  if (rest) out.push(rest)
  return out
}

const Entry = Schema.Struct({
  title: Schema.String,
  content: Schema.String,
  summary: Schema.optional(Schema.String),
  aliases: Schema.optional(Schema.Array(Schema.String)),
  questions: Schema.optional(Schema.Array(Schema.String)),
  keywords: Schema.optional(Schema.Array(Schema.String)),
})

const Reply = Schema.Struct({ entries: Schema.Array(Entry) })

export type Converted = Schema.Schema.Type<typeof Entry>

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Reply))

/** The model's answer as entries, or undefined when it is not the JSON that was asked for. Code fences around it are ignored. */
export function parse(reply: string): Converted[] | undefined {
  const text = reply.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
  return Option.getOrUndefined(Option.map(decode(text), (value) => value.entries.filter((entry) => entry.title.trim() && entry.content.trim())))
}

/** The instruction for converting one section. */
export function prompt(section: Section, options: Pick<Options, "aliases" | "questions" | "summary">) {
  const fields = [
    `"title": a short name for the topic`,
    `"content": the knowledge itself, in Markdown`,
    ...(options.summary ? [`"summary": one sentence saying what this entry is about`] : []),
    ...(options.aliases ? [`"aliases": other names for the same thing: synonyms, abbreviations, names in another language`] : []),
    ...(options.questions ? [`"questions": 3 to 5 questions this entry answers, as a person would ask them`] : []),
    `"keywords": the specialist terms and identifiers that appear in it`,
  ]
  return [
    "You turn a fragment of a document into entries for a knowledge base that an AI assistant searches.",
    "",
    "Reply with JSON only, no explanation and no code fence, in this shape:",
    `{"entries": [{${fields.map((field) => field.split(":")[0]).join(", ")}}]}`,
    "",
    "Fields:",
    ...fields.map((field) => `- ${field}`),
    "",
    "Rules:",
    "- Split the fragment into entries by topic. One entry covers one idea and makes sense on its own.",
    "- Stay faithful to the source. You may tidy and reorganise, but never add a fact that is not in the fragment.",
    "- Keep code, commands, identifiers, numbers and units exactly as written.",
    "- Write titles, summaries, aliases and questions in the language of the fragment.",
    "- Skip navigation, licence text, tables of contents and other filler. If nothing is worth keeping, return {\"entries\": []}.",
    "",
    section.path.length > 0 ? `Headings above the fragment: ${section.path.join(" > ")}` : "The fragment has no heading above it.",
    "",
    "Fragment:",
    section.text,
  ].join("\n")
}

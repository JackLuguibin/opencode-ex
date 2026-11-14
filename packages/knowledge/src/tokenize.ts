export * as Tokenize from "./tokenize.js"

const segmenter = new Intl.Segmenter("zh", { granularity: "word" })

/** Longest run of adjacent tokens that may be joined into one custom term. */
const MAX_TERM_PARTS = 4

/**
 * Splits text into lowercase words for the keyword index. Chinese is cut into words with `Intl.Segmenter`; identifiers such as
 * `LC_MAIN` or `0xFEEDFACF` stay whole. A custom term whose parts sit next to each other is emitted as well as its parts, so a
 * query for either form finds it.
 */
export function words(text: string, terms: ReadonlySet<string> = new Set()) {
  const parts = [...segmenter.segment(text.toLowerCase())].flatMap((part) => (part.isWordLike ? [part.segment] : []))
  if (terms.size === 0) return parts
  return parts.flatMap((word, index) => {
    const joined = Array.from({ length: Math.min(MAX_TERM_PARTS - 1, parts.length - index - 1) }, (_, extra) =>
      parts.slice(index, index + extra + 2).join(""),
    ).filter((candidate) => terms.has(candidate))
    return [word, ...joined]
  })
}

/** The text stored in a keyword-index column: words separated by spaces. */
export function index(text: string, terms?: ReadonlySet<string>) {
  return words(text, terms).join(" ")
}

/** An FTS5 `MATCH` expression that finds entries with any of the words; ranking decides which come first. */
export function match(text: string, terms?: ReadonlySet<string>) {
  const unique = [...new Set(words(text, terms))]
  if (unique.length === 0) return undefined
  return unique.map((word) => `"${word.replaceAll('"', '""')}"`).join(" OR ")
}

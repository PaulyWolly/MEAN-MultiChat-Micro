// @ts-nocheck
/**
 * Split a reply into speakable chunks for pipelined text-to-speech.
 *
 * Synthesising a whole reply as one request means nothing plays until the
 * entire thing is rendered — several seconds on a long answer. Splitting it
 * lets the first sentence start while the rest is still being synthesised.
 *
 * Chunks are a trade-off: too small and playback is choppy with a request per
 * fragment, too large and the wait to first audio creeps back up. The first
 * chunk is deliberately allowed to be much shorter than the rest, because it is
 * the only one the listener actually waits for.
 */

const DEFAULT_FIRST_MIN = 40
const DEFAULT_MIN = 160
const DEFAULT_MAX = 600

/** Sentence splitting via Intl.Segmenter, which knows about abbreviations. */
function segmentSentences(block, locale) {
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    try {
      const segmenter = new Intl.Segmenter(locale, { granularity: "sentence" })
      return Array.from(segmenter.segment(block), (s) => s.segment)
    } catch {
      /* fall through to the regex below */
    }
  }

  // Fallback: break after .!? followed by whitespace. Keeps the delimiter and
  // tolerates the " ." spacing that markdown rendering sometimes produces.
  return block.split(/(?<=[.!?])[ \t]+/)
}

/** Hard-split a single sentence that is too long to send as one request. */
function splitOversized(sentence, maxChars) {
  const parts = []
  let rest = sentence

  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars)
    // Prefer a clause boundary, then any space, before cutting mid-word.
    const breakAt =
      Math.max(
        window.lastIndexOf(", "),
        window.lastIndexOf("; "),
        window.lastIndexOf(": "),
        window.lastIndexOf(" — ")
      ) + 1 || window.lastIndexOf(" ") + 1 || maxChars

    parts.push(rest.slice(0, breakAt).trim())
    rest = rest.slice(breakAt)
  }

  if (rest.trim()) parts.push(rest.trim())
  return parts
}

/**
 * @param {string} text Raw reply text, markdown included.
 * @param {{firstChunkMinChars?: number, minChars?: number, maxChars?: number, locale?: string}} [options]
 * @returns {string[]} Chunks in reading order. Empty when there is nothing to say.
 */
export function splitIntoSpeechChunks(text, options = {}) {
  const {
    firstChunkMinChars = DEFAULT_FIRST_MIN,
    minChars = DEFAULT_MIN,
    maxChars = DEFAULT_MAX,
    locale = "en",
  } = options

  const source = String(text || "").trim()
  if (!source) return []

  // Split on line breaks first so headings and list items stay intact; the
  // newlines are preserved when re-joining so markdown-to-SSML prep still sees
  // the original structure.
  const blocks = source
    .split(/\n+/)
    .map((b) => b.trim())
    .filter(Boolean)

  // Track which pieces began a new line in the source. Only those may be
  // re-joined with a newline: markdown-to-SSML prep turns newlines into pauses,
  // and sentence segmentation splits after abbreviations like "Dr.", so joining
  // everything with newlines would insert a pause mid-name.
  const pieces = []
  for (const block of blocks) {
    let first = true
    for (const sentence of segmentSentences(block, locale)) {
      const trimmed = sentence.trim()
      if (!trimmed) continue
      const parts =
        trimmed.length > maxChars ? splitOversized(trimmed, maxChars) : [trimmed]
      for (const part of parts) {
        pieces.push({ text: part, startsBlock: first })
        first = false
      }
    }
  }

  const chunks = []
  let current = ""

  for (const piece of pieces) {
    const target = chunks.length === 0 ? firstChunkMinChars : minChars
    const separator = piece.startsBlock ? "\n" : " "
    const candidate = current ? `${current}${separator}${piece.text}` : piece.text

    if (candidate.length > maxChars && current) {
      chunks.push(current)
      current = piece.text
    } else {
      current = candidate
    }

    if (current.length >= target) {
      chunks.push(current)
      current = ""
    }
  }

  if (current.trim()) chunks.push(current)
  return chunks
}

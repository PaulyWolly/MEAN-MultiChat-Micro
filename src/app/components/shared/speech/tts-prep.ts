// @ts-nocheck
/**
 * Turn plain/markdown text into Azure SSML voice body content
 * with pauses after titles, paragraphs, and list items.
 *
 * Displaying as Markdown does not change TTS by itself — the spoken
 * stream must preserve structure (this helper) or everything runs together.
 */

function escapeXml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

const DOMAIN_TLD =
  "com|org|net|edu|gov|io|info|biz|news|app|co\\.uk|us|ca|au|de|fr|ai"

/**
 * Drop URLs/domains from spoken text. Chat can still show citations;
 * TTS must not spell out "axios dot com".
 */
export function stripUrlsForSpeech(text) {
  return (
    String(text || "")
      // Full URLs (http, https, www)
      .replace(/https?:\/\/[^\s)\]>'"<]+/gi, " ")
      .replace(/\bwww\.[^\s)\]>'"<]+/gi, " ")
      // Autolink <https://...>
      .replace(/<\s*https?:\/\/[^>]+>/gi, " ")
      // Parenthetical host citations: (axios.com), (www.apnews.com/…)
      .replace(
        new RegExp(
          String.raw`\(\s*(?:https?:\/\/|www\.)?[a-z0-9][-a-z0-9.]*(?:\.(?:${DOMAIN_TLD}))(?:\/[^\s)]*)?\s*\)`,
          "gi",
        ),
        " ",
      )
      // Bare domains: axios.com, washingtonpost.com, news.ycombinator.com/…
      .replace(
        new RegExp(
          String.raw`\b(?:www\.)?[a-z0-9][-a-z0-9.]*(?:\.(?:${DOMAIN_TLD}))(?:\/[^\s.,;:!?)"'\]]*)?`,
          "gi",
        ),
        " ",
      )
      // Leftover "dot com" style if a prior split mangled a host
      .replace(/\bdot\s+(?:com|org|net|edu|gov|io)\b/gi, " ")
      .replace(/\s+([,.;:!?])/g, "$1")
      .replace(/\(\s*\)/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  )
}

/** Keep link labels; drop destinations — run before sentence chunking. */
export function stripForSpeech(text) {
  const withoutMdLinks = String(text || "")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
  return stripUrlsForSpeech(withoutMdLinks)
}

function stripInlineMarkdown(line) {
  return stripForSpeech(
    String(line)
      .replace(/(\*\*|__)(.*?)\1/g, "$2")
      .replace(/(\*|_)(.*?)\1/g, "$2")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/~~(.*?)~~/g, "$1")
      .replace(/[#*_`>~]/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  )
}

/**
 * Azure Andrew often pronounces "4" / "four" as "fur".
 * Mid-phrase (e.g. "3 to 4 pounds") is usually fine; phrase-initial
 * after a list pause (e.g. "4 cloves…") is where it breaks.
 * Respell as "foar", and if that starts a phrase, prefix "the" so it
 * is never utterance-initial. Leaves multi-digit numbers like 145 alone.
 */
function forceFourPronunciation(escapedText) {
  let text = String(escapedText || "").replace(
    /(?<![0-9])4(?![0-9])|\bfour\b|\bfohr\b/gi,
    "foar",
  )
  // "foar cloves" after a pause still becomes "fur" — give it a carrier.
  text = text.replace(/(^|[.!?…]\s+)foar\b/gi, "$1the foar")
  return text
}

/**
 * @param {string} text markdown or plain text
 * @returns {string} SSML fragments safe to place inside <voice>…</voice>
 */
export function prepareTextForAzureTts(text) {
  const raw = String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\u00a0/g, " ")
    .trim()
  if (!raw) return "OK."

  const lines = raw.split("\n")
  const chunks = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()

    if (!trimmed) {
      // Blank line = paragraph break
      chunks.push({ type: "break", ms: 550 })
      continue
    }

    const heading = trimmed.match(/^#{1,6}\s+(.+)$/)
    if (heading) {
      const title = stripInlineMarkdown(heading[1])
      if (title) {
        chunks.push({ type: "break", ms: 350 })
        chunks.push({ type: "text", value: title })
        chunks.push({ type: "break", ms: 750 })
      }
      continue
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      chunks.push({ type: "break", ms: 500 })
      continue
    }

    const listItem = trimmed.match(/^([-*+]|\d+[.)])\s+(.+)$/)
    if (listItem) {
      const item = stripInlineMarkdown(listItem[2])
      if (item) {
        chunks.push({ type: "text", value: item })
        chunks.push({ type: "break", ms: 320 })
      }
      continue
    }

    if (trimmed.startsWith(">")) {
      const quote = stripInlineMarkdown(trimmed.replace(/^>\s?/, ""))
      if (quote) {
        chunks.push({ type: "text", value: quote })
        chunks.push({ type: "break", ms: 400 })
      }
      continue
    }

    const plain = stripInlineMarkdown(trimmed)
    if (plain) {
      chunks.push({ type: "text", value: plain })
      // Soft pause at end of a non-empty line (common after a title line without #)
      const next = lines[i + 1]?.trim() ?? ""
      if (!next) {
        chunks.push({ type: "break", ms: 500 })
      } else if (/^#{1,6}\s+/.test(next) || /^([-*+]|\d+[.)])\s+/.test(next)) {
        chunks.push({ type: "break", ms: 400 })
      } else {
        chunks.push({ type: "break", ms: 220 })
      }
    }
  }

  // Collapse consecutive breaks; keep the longest
  const merged = []
  for (const chunk of chunks) {
    if (chunk.type === "break") {
      const prev = merged[merged.length - 1]
      if (prev?.type === "break") {
        prev.ms = Math.max(prev.ms, chunk.ms)
      } else {
        merged.push({ ...chunk })
      }
    } else if (chunk.value) {
      merged.push(chunk)
    }
  }

  // Drop leading/trailing breaks
  while (merged[0]?.type === "break") merged.shift()
  while (merged[merged.length - 1]?.type === "break") merged.pop()

  let ssml = ""
  for (const chunk of merged) {
    if (chunk.type === "break") {
      ssml += `<break time="${chunk.ms}ms"/>`
    } else {
      ssml += `${forceFourPronunciation(escapeXml(chunk.value))} `
    }
  }

  // Azure SSML practical size guard (characters)
  return ssml.trim().slice(0, 9000) || "OK."
}

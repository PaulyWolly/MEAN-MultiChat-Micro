// @ts-nocheck
/**
 * Detect image-intent chat prompts (incl. common typos) and extract a search subject.
 */
import { environment } from "../../../environments/environment"

const IMAGE_WORD_RE =
  /\b(images?|imges?|imge|pictures?|picturs?|pcture|pctures?|photos?|phots?)\b/i

/** Chat padding — strip repeatedly so "please tell me again about X" still works. */
const CHAT_LEAD_IN = [
  /^(please[,.\s]+)+/i,
  /^(can|could|would|will)\s+you\s+/i,
  /^(show|find|get|search\s+for|look\s+up|give)\s+(?:me\s+)?(?:some\s+|a\s+few\s+)?/i,
  /^(tell|remind)\s+me\s+(?:once\s+more|again|more)?\s*(?:about|of)?\s*/i,
  /^(tell\s+me\s+more\s+(?:about|of)\s+)/i,
  /^(talk|speak)\s+(?:to\s+me\s+)?(?:once\s+more\s+|again\s+)?about\s+/i,
  /^(explain|describe|discuss)\s+(?:to\s+me\s+)?(?:once\s+more\s+|again\s+)?(?:about\s+)?/i,
  /^(what\s+do\s+you\s+know\s+about)\s+/i,
  /^(what(?:'s|\s+is|\s+are)|who(?:'s|\s+is|\s+are))\s+/i,
  /^(i\s+(?:want|need|would\s+like)(?:\s+to\s+(?:know|hear|learn))?\s+(?:about\s+)?)/i,
  /^(once\s+more|again|more)(?:\s+about)?\s+/i,
  /^(about|of|for|on)\s+(?:the\s+|a\s+|an\s+)?/i,
  /^(the\s+|a\s+|an\s+)/i,
]

function stripChatLeadIn(input) {
  let q = String(input || "").trim()
  for (let n = 0; n < 8; n++) {
    const before = q
    for (const re of CHAT_LEAD_IN) {
      q = q.replace(re, "").trim()
    }
    if (q === before) break
  }
  return q
}

/** Words that look like a Latin binomial second half but are just English prose. */
const BINOMIAL_STOP = new Set(
  [
    "history",
    "plant",
    "world",
    "largest",
    "known",
    "famous",
    "american",
    "western",
    "story",
    "information",
    "species",
    "event",
    "events",
    "town",
    "territory",
    "outcome",
    "aftermath",
    "legacy",
    "participants",
    "lawmen",
    "cowboys",
    "gunfight",
    "corral",
    "seagrass",
    "meadow",
    "meadows",
  ].map((w) => w.toLowerCase())
)

export function wantsChatImages(text) {
  return IMAGE_WORD_RE.test(String(text || ""))
}

export function extractImageSearchSubject(text) {
  let q = String(text || "").trim()
  if (!q) return ""

  q = q.replace(
    /\b(and\s+)?(please\s+)?(provid(?:e|ing)|show|include|with|get|find|give\s+me|send)\s+(me\s+)?(some\s+|a\s+few\s+|relevant\s+|provided\s+)?(images?|imges?|imge|pictures?|picturs?|pcture|pctures?|photos?|phots?)\b/gi,
    " "
  )
  // "can I see images of X" before stripping the image word alone
  q = q.replace(
    /\b(can\s+i|could\s+i|may\s+i|let\s+me|i('d|\s+would)\s+like\s+to)\s+see\s+(some\s+|a\s+few\s+)?(images?|imges?|imge|pictures?|picturs?|pcture|pctures?|photos?|phots?)(\s+(of|about|for))?\b/gi,
    " "
  )
  // "do you have any images of X" / "got any pictures of X"
  q = q.replace(
    /\b(do\s+you\s+have|have\s+you\s+got|got|are\s+there|is\s+there)\s+(any\s+|some\s+|a\s+few\s+)?(images?|imges?|imge|pictures?|picturs?|pcture|pctures?|photos?|phots?)(\s+(of|about|for|showing))?\b/gi,
    " "
  )
  q = q.replace(IMAGE_WORD_RE, " ")
  // Leftover after "…and providing images" → images already stripped
  q = q.replace(/\b(and\s+)?provid(?:e|ing)\b/gi, " ")
  // "do you have any of …" after the image word was removed
  q = q.replace(
    /\b(do\s+you\s+have|have\s+you\s+got|got|are\s+there|is\s+there)\s+(any\s+|some\s+|a\s+few\s+)?/gi,
    " "
  )
  q = stripChatLeadIn(q)
  // Voice: "can I see …", "let me see …", "I'd like to see …"
  q = q.replace(
    /^(please\s+)?(can\s+i|could\s+i|may\s+i|let\s+me|i('d|\s+would)\s+like\s+to)\s+see(\s+(of|about|for))?\s+/i,
    ""
  )
  q = q.replace(
    /^(please\s+)?(can\s+you\s+)?(show|find|get|pull\s+up)\s+(me\s+)?(some\s+|a\s+few\s+)?/i,
    ""
  )
  q = stripChatLeadIn(q)
  // "history of crumb cake" → "crumb cake" (better for image search)
  q = q.replace(
    /^(the\s+)?(history|origins?|story|background)\s+of\s+(the\s+|a\s+|an\s+)?/i,
    ""
  )
  q = q.replace(/^(how\s+to\s+(make|bake|cook|prepare)\s+)/i, "")
  q = q.replace(
    /\s+and\s+how\s+(it'?s|they(?:'re|\s+are)|to)\s+\w[\s\S]*$/i,
    ""
  )
  q = q.replace(
    /\s+how\s+(it'?s|they(?:'re|\s+are))\s+(made|prepared|baked)\b[\s\S]*$/i,
    ""
  )
  // "what fracking looks like" / "of what X looks like" → "fracking"
  q = q.replace(
    /\b(?:of\s+)?what\s+(.+?)\s+looks?\s+like\b/gi,
    " $1 "
  )
  q = q.replace(/\s+looks?\s+like\b/gi, " ")
  q = q.replace(/\s+/g, " ").trim()
  q = q.replace(/^(of|about|for|on)\s+(the\s+|a\s+|an\s+)?/i, "")
  q = q.replace(/^(the|a|an)\s+/i, "")
  // Voice: "okay Corral" / "ok corral" → proper name for Wikimedia
  q = q.replace(/\bok(?:ay)?\s+corral\b/gi, "O.K. Corral")
  // Commons / Openverse index the hyphenated common name
  q = q.replace(/\b(blue)\s+(ringed|spotted|striped)\s+(\w+)\b/gi, "$1-$2 $3")
  // Prefer the technical Commons/Openverse term for oil/gas fracking
  q = q.replace(/\b(?:oil\s+)?frack(?:ing|ed)?\b/gi, "hydraulic fracturing")
  q = q.replace(/^[\s,.;:-]+|[\s,.;:-]+$/g, "").trim()
  q = refineImageSearchSubject(q)
  return q || String(text || "").trim()
}

/**
 * Rewrite subjects that Openverse otherwise answers with off-topic photos
 * (e.g. oil workers instead of reserve maps).
 */
function refineImageSearchSubject(subject) {
  const q = String(subject || "").trim()
  if (!q) return q

  // "largest oil reserves in the world" → maps/charts, not rig-worker photos
  if (
    /\boil\s+reserves?\b/i.test(q) &&
    /\b(world|largest|biggest|countries|country|global|proven|map|ranking|by\s+country)\b/i.test(
      q
    )
  ) {
    return "proven oil reserves by country map"
  }

  return q
}

function cleanReplyText(text) {
  return String(text || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Candidate image subjects from the assistant reply when the user query was
 * mangled (voice typos) or too vague for Wikimedia.
 */
export function extractImageSubjectCandidatesFromReply(text) {
  const raw = String(text || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
  if (!raw.trim()) return []

  const candidates = []
  const seen = new Set()
  const push = (value) => {
    const v = String(value || "")
      .replace(/\s*[-–—:].*$/, "")
      .replace(/\s+/g, " ")
      .trim()
    if (v.length < 4 || v.length > 70) return
    // Drop truncated abbreviations ("Gunfight at the O")
    if (/\b[A-Z]\.?$/i.test(v)) return
    const key = v.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    candidates.push(v)
  }

  const lines = raw
    .split(/\n+/)
    .map((l) => l.replace(/^#+\s*/, "").trim())
    .filter(Boolean)

  for (const line of lines.slice(0, 12)) {
    if (line.length > 80) continue
    if (
      /^(when and where|the participants|the outcome|the aftermath|legacy|key facts|appearance|size|age|growth)\b/i.test(
        line
      )
    ) {
      continue
    }
    if (
      /^(here'?s|here is|this is|according to|the gunfight took|one single)\b/i.test(
        line
      )
    ) {
      continue
    }
    // Short title-like lines: "The Gunfight at the O.K. Corral"
    if (/^[A-Z0-9“"]/.test(line) && /[A-Za-z]{3,}/.test(line)) {
      push(line)
    }
  }

  // Latin binomial near the start (Genus species) — skip English false positives
  const head = cleanReplyText(raw).slice(0, 500)
  const binomial = head.match(/\b([A-Z][a-z]{2,})\s+([a-z]{3,})\b/)
  if (
    binomial &&
    !BINOMIAL_STOP.has(binomial[1].toLowerCase()) &&
    !BINOMIAL_STOP.has(binomial[2].toLowerCase())
  ) {
    // Prefer scientific name at front of list
    const name = `${binomial[1]} ${binomial[2]}`
    if (!seen.has(name.toLowerCase())) {
      candidates.unshift(name)
      seen.add(name.toLowerCase())
    }
  }

  // Phrase after "story of the X," / "about X," — stop before ", one of" etc.
  const about = head.match(
    /\b(?:story of|about|known as)\s+(?:the\s+)?([A-Z][\w .''-]{3,55}?)(?=\s*,|\s+one\s+of\b)/
  )
  if (about?.[1]) push(about[1])

  return candidates.slice(0, 5)
}

/**
 * Best single subject from the assistant reply.
 */
export function extractImageSubjectFromReply(text) {
  return extractImageSubjectCandidatesFromReply(text)[0] || ""
}

export function normalizeChatImageList(data) {
  const apiBase = String(environment.apiBase || "").replace(/\/$/, "")
  const resolve = (u) => {
    if (!u || typeof u !== "string") return ""
    if (/^https?:\/\//i.test(u) || u.startsWith("data:")) return u
    if (u.startsWith("/") && apiBase) return `${apiBase}${u}`
    return u
  }

  /** Stable identity across proxy hosts / relative vs absolute paths. */
  const originKey = (raw) => {
    if (!raw || typeof raw !== "string") return ""
    try {
      if (raw.includes("/api/image-proxy") && raw.includes("url=")) {
        const q = raw.includes("?") ? raw.slice(raw.indexOf("?") + 1) : ""
        const params = new URLSearchParams(q)
        const inner = params.get("url")
        if (inner) return inner
      }
    } catch {
      /* keep raw */
    }
    return raw
  }

  const list = data?.images || data?.items || data?.results || []
  return list
    .map((item) => {
      const full =
        item.link ||
        item.url ||
        item.src ||
        item.originalUrl ||
        ""
      const thumb =
        item.thumbnail ||
        item.image?.thumbnailLink ||
        item.thumb ||
        full
      const originalUrl = item.originalUrl || originKey(full) || ""
      return {
        // Prefer proxied full-size for detail; thumb for grid
        url: resolve(full || thumb),
        thumb: resolve(thumb || full),
        originalUrl,
        title: item.title || item.name || "Image",
      }
    })
    .filter((img) => img.url || img.thumb)
}

/**
 * Models often claim they cannot show images, then dump URL lists.
 * Strip that when the app is already fetching a gallery below the reply.
 */
function isImageSectionHeading(line) {
  const s = String(line || "")
    .replace(/^#{1,6}\s*/, "")
    .replace(/^\*+|\*+$/g, "")
    .replace(/^[-*]\s*/, "")
    .replace(/:$/, "")
    .trim()
  return /^(?:related\s+|provided\s+|some\s+|optional\s+|inline\s+)?(?:images?|pictures?|photos?|image options|image gallery|photo gallery|image references|image links|image sources)$/i.test(
    s
  )
}

function looksLikeImageUrl(text) {
  return /https?:\/\/\S+/i.test(text) &&
    /(?:wikimedia|upload\.wikimedia|commons\.wikimedia|flickr|staticflickr|openverse|unsplash|imgur|\.jpe?g(?:\?|$)|\.png(?:\?|$)|\.gif(?:\?|$)|\.webp(?:\?|$)|\/thumb\/)/i.test(
      text
    )
}

function isImageDumpLine(line) {
  const s = String(line || "").trim()
  if (!s) return false
  if (/!\[[^\]]*\]\([^)]+\)/.test(s)) return true
  if (looksLikeImageUrl(s)) return true
  if (
    /(?:can't|cannot|unable|not able).{0,60}(?:display|show|provide|include|embed).{0,40}(?:images?|pictures?|photos?)/i.test(
      s
    )
  ) {
    return true
  }
  if (/here are (?:some )?(?:image|picture|photo) options/i.test(s)) return true
  if (/fetch higher-resolution|official datasets/i.test(s)) return true
  if (
    /(?:images?|pictures?|photos?)\s+(?:will|are)\s+(?:appear|shown|displayed|loaded)\s+(?:below|separately)/i.test(
      s
    )
  ) {
    return true
  }
  return false
}

function stripImageSentences(paragraph) {
  return paragraph
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(
      /\[[^\]]+\]\(https?:\/\/[^)]*(?:wikimedia|flickr|openverse|unsplash|imgur|\.jpe?g|\.png|\.gif|\.webp)[^)]*\)/gi,
      ""
    )
    .replace(
      /[^.!\n]*\b(?:I(?:'m| am)?\s+)?(?:cannot|can't|unable to|not able to)\s+(?:display|show|provide|include|embed)\s+(?:images?|pictures?|photos?)[^.!\n]*[.!]?/gi,
      ""
    )
    .replace(
      /[^.!\n]*here are (?:some )?(?:image|picture|photo) options[^.!\n]*[.!]?/gi,
      ""
    )
    .replace(
      /[^.!\n]*if you(?:'d| would) like,? I can (?:fetch|find|get|provide)[^.!\n]*(?:galler(?:y|ies)|images?|photos?|datasets?)[^.!\n]*[.!]?/gi,
      ""
    )
    .replace(
      /https?:\/\/[^\s)]*(?:wikimedia|flickr|openverse|unsplash|imgur)[^\s)]*/gi,
      ""
    )
    .replace(/https?:\/\/[^\s)]+\.(?:jpe?g|png|gif|webp)(?:\?[^\s)]*)?/gi, "")
}

export function stripImageCapabilityDisclaimers(text) {
  if (!text || typeof text !== "string") return text

  const lines = text.replace(/\r\n/g, "\n").split("\n")
  const kept = []
  let skippingImageSection = false

  for (const line of lines) {
    if (isImageSectionHeading(line)) {
      skippingImageSection = true
      continue
    }
    if (skippingImageSection) {
      const trimmed = line.trim()
      const nextHeading =
        /^#{1,6}\s+\S/.test(trimmed) && !isImageSectionHeading(trimmed)
      if (nextHeading) {
        skippingImageSection = false
      } else {
        continue
      }
    }
    if (isImageDumpLine(line)) continue
    kept.push(line)
  }

  let t = stripImageSentences(kept.join("\n"))
  t = t.replace(/[ \t]+\n/g, "\n")
  t = t.replace(/\n{3,}/g, "\n\n")
  return t.trim()
}

/**
 * Ordered src candidates for a chat gallery tile. Openverse /thumb/ URLs are
 * often dead (424); origin / proxied URLs usually still work.
 */
export function chatImageSrcCandidates(img) {
  const apiBase = String(environment.apiBase || "").replace(/\/$/, "")
  const out = []
  const push = (raw) => {
    if (!raw || typeof raw !== "string") return
    let u = raw
    if (u.startsWith("/") && apiBase) u = `${apiBase}${u}`
    if (out.includes(u)) return
    out.push(u)
  }

  push(img?.thumb)
  push(img?.url)

  const original = img?.originalUrl
  if (original && /^https?:\/\//i.test(original)) {
    push(original)
    if (apiBase) {
      push(
        `${apiBase}/api/image-proxy?url=${encodeURIComponent(original)}`
      )
    }
  } else {
    push(original)
  }

  return out
}

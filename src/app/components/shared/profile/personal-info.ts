// @ts-nocheck
/**
 * Personal profile helpers — scoped by logged-in dataKey (Auth).
 * Name / facts live in conversation_history via /api/personal-info/:type
 */
import { getActiveDataKey, LEGACY_DATA_KEY } from "../../login/auth-storage"

export const PERSONAL_SESSION_ID = LEGACY_DATA_KEY

export function getPersonalSessionId() {
  return getActiveDataKey()
}

const NAME_STORAGE_KEY = "stored_name"

const WHO_AM_I = [
  /^who am i\b/i,
  /^who(?:'s| is) this\??$/i,
  /^what do you know about me\??$/i,
  /^tell me (?:about )?myself\??$/i,
  /^show me my personal info(?:rmation)?\??$/i,
  /^what do i like\??$/i,
  /^what(?:'s| are) my (?:likes|interests|hobbies|preferences)\??$/i,
  /^tell me (?:about )?what i like\??$/i,
  /^can you tell me who i am(?: and what i like)?\??$/i,
  /^who am i and what do i like\??$/i,
]

const GET_NAME = [
  /^what(?:'s| is) my name\??$/i,
  /^tell me my name\??$/i,
  /^do you remember my name\??$/i,
]

const STORE_NAME = [
  /^remember (?:that )?my name is (.+)$/i,
  /^my name is (.+)$/i,
]

const STORE_FACT = [
  /^remember that (.+?) is (.+)$/i,
  /^remember (.+?) is (.+)$/i,
  /^please remember that (.+?) is (.+)$/i,
  /^please remember (.+?) is (.+)$/i,
]

const DELETE_FACT = [
  /^(?:please )?(?:can you |could you )?(?:remove|delete|forget|erase)(?: that)?(?: my)? (.+)$/i,
  /^(?:please )?(?:can you |could you )?clear my (.+)$/i,
]

const GET_FACT = [
  /^what(?:'s| is) my (.+)\??$/i,
  /^tell me (?:about )?my (.+)\??$/i,
  /^do you remember my (.+)\??$/i,
  /^what do you remember about my (.+)\??$/i,
]

const DELETE_SKIP = new Set(["chat", "history", "conversation", "messages", "it", "that", "this"])

/** Spaces, punctuation, and "my" prefixes collapse so "test preference" matches test_preference. */
export function normalizeFactKey(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/^(?:a|an|the|my)\s+/i, "")
    .replace(/\s+(?:please|from my profile|from my personal info|from the profile).*$/i, "")
    .replace(/\s+i\s+(?:don't|do not|dont)\b.*$/i, "")
    .replace(/[?.!,]+$/g, "")
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
}

function keysLookAlike(stored, requested) {
  const a = normalizeFactKey(stored)
  const b = normalizeFactKey(requested)
  if (!a || !b) return false
  if (a === b) return true
  if (b.length >= 6 && (a.startsWith(b) || b.startsWith(a))) return true
  const aParts = a.split("_").filter(Boolean)
  const bParts = b.split("_").filter(Boolean)
  if (bParts.length >= 2 && bParts.every((part) => aParts.some((p) => p === part || p.startsWith(part)))) {
    return true
  }
  return false
}

/** Stored profile key that matches a spoken/typed label, or null. */
export function resolveProfileFactKey(profile, requestedKey) {
  const want = normalizeFactKey(requestedKey)
  if (!want || !profile || typeof profile !== "object") return null
  const keys = Object.keys(profile).filter((k) => k && k !== "avatar")
  const exact = keys.find((k) => normalizeFactKey(k) === want)
  if (exact) return exact
  return keys.find((k) => keysLookAlike(k, want)) || null
}

/** @returns {string | null} requested fact label to delete */
export function matchDeleteFact(text) {
  if (matchStoreName(text) || matchStoreFact(text)) return null
  const q = String(text || "").trim()
  for (const re of DELETE_FACT) {
    const m = q.match(re)
    if (!m?.[1]) continue
    const key = normalizeFactKey(m[1])
    if (!key || DELETE_SKIP.has(key)) continue
    return key
  }
  return null
}

export function getCachedUserName() {
  try {
    return localStorage.getItem(NAME_STORAGE_KEY) || ""
  } catch {
    return ""
  }
}

export function setCachedUserName(name) {
  try {
    if (name) localStorage.setItem(NAME_STORAGE_KEY, name)
    else localStorage.removeItem(NAME_STORAGE_KEY)
  } catch {
    /* ignore */
  }
}

export function isWhoAmIQuery(text) {
  const q = String(text || "").trim()
  return WHO_AM_I.some((re) => re.test(q))
}

export function isGetNameQuery(text) {
  const q = String(text || "").trim()
  return GET_NAME.some((re) => re.test(q))
}

export function matchStoreName(text) {
  const q = String(text || "").trim()
  for (const re of STORE_NAME) {
    const m = q.match(re)
    if (m?.[1]) return m[1].trim().replace(/[?.!]+$/, "")
  }
  return null
}

/** @returns {{ key: string, value: string } | null} */
export function matchStoreFact(text) {
  // Name has its own path
  if (matchStoreName(text)) return null
  const q = String(text || "").trim()
  for (const re of STORE_FACT) {
    const m = q.match(re)
    if (m?.[1] && m?.[2]) {
      let key = normalizeFactKey(m[1].trim().replace(/^my\s+/i, ""))
      const value = m[2].trim().replace(/[?.!]+$/, "")
      if (key && value) return { key, value }
    }
  }
  return null
}

/** @returns {string | null} fact key, or "" for full dump, or null if not a fact query */
export function matchGetFact(text) {
  if (isGetNameQuery(text) || isWhoAmIQuery(text)) return null
  const q = String(text || "").trim()
  // General knowledge / image requests are never profile lookups
  if (
    /\b(octopus|animal|recipe|news|weather|image|images|picture|pictures|photo|photos|provide|explain|how does|what is a|tell me about the)\b/i.test(
      q
    )
  ) {
    return null
  }
  for (const re of GET_FACT) {
    const m = q.match(re)
    if (m) {
      if (m[1]) {
        return normalizeFactKey(m[1])
      }
      return ""
    }
  }
  return null
}

export function isIdentityQuery(text) {
  return (
    isWhoAmIQuery(text) ||
    isGetNameQuery(text) ||
    Boolean(matchStoreName(text)) ||
    Boolean(matchStoreFact(text)) ||
    Boolean(matchDeleteFact(text)) ||
    matchGetFact(text) != null
  )
}

function formatFactValue(value) {
  if (Array.isArray(value)) return value.join(", ")
  return String(value)
}

/** System-prompt block so the model knows the user — only for personal questions. */
export function buildPersonalContextPrompt(profile = {}) {
  const entries = Object.entries(profile || {}).filter(
    ([k, v]) =>
      k !== "avatar" &&
      v != null &&
      String(v).trim() !== "" &&
      !String(v).startsWith("data:image")
  )
  if (!entries.length) {
    return `Optional user profile: none saved yet.
Only if the user asks about themselves (who they are, their name, likes, hobbies), say you don't have that saved and they can teach you with "My name is …" or "Remember that my hobby is …".
For all other topics (science, news, animals, recipes, etc.), answer normally. Never treat a general question as a missing profile field.`
  }
  const lines = entries
    .map(([k, v]) => `- ${k}: ${formatFactValue(v)}`)
    .join("\n")
  return `Optional user profile (MongoDB) — use ONLY when the user asks about themselves (who they are, their name, what they like, hobbies, preferences):

${lines}

Important:
- For personal/"about me" questions, use these facts and do not claim you know nothing about them.
- For general knowledge questions (animals, science, news, how-to, etc.), answer the topic normally with web search when needed. Do NOT reply that a profile detail is missing, and do NOT ask them to "Remember that my …".`
}

export function formatWhoAmIReply(profile = {}) {
  const name = profile.name || getCachedUserName()
  const other = Object.entries(profile || {}).filter(
    ([k, v]) =>
      k !== "name" &&
      k !== "avatar" &&
      v != null &&
      String(v).trim() !== "" &&
      !String(v).startsWith("data:image")
  )
  if (!name && !other.length) {
    return `I don't have your profile saved yet. Tell me by saying "My name is [your name]", or "Remember that my hobby is hiking".`
  }
  const lines = []
  if (name) lines.push(`You're ${name}.`)
  if (other.length) {
    lines.push("Here's what I have saved about you:")
    for (const [k, v] of other) {
      lines.push(`- Your ${k}: ${formatFactValue(v)}`)
    }
  } else {
    lines.push(
      "I only have your name so far. You can add more with “Remember that my hobby is …”."
    )
  }
  return lines.join("\n")
}

export function formatGetNameReply(name) {
  if (!name) {
    return `I don't know your name yet. You can tell me by saying "My name is [your name]".`
  }
  return `Your name is ${name}.`
}

export function formatGetFactReply(key, profile = {}) {
  if (!key) return formatWhoAmIReply(profile)
  const foundKey = resolveProfileFactKey(profile, key)
  if (foundKey) {
    const direct = profile[foundKey]
    return `Your ${foundKey} ${Array.isArray(direct) ? "are" : "is"}: ${formatFactValue(direct)}.`
  }
  return `I don't have your ${key} saved yet. You can tell me by saying "Remember that my ${key} is …".`
}

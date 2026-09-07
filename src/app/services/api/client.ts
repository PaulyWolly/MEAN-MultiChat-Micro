// @ts-nocheck
/**
 * Thin API client — all calls go through Angular proxy to Express (:4800).
 */
import {
  getAllCachedPagesForQuery,
  getCachedYouTubePage,
  highestCachedPageForQuery,
  hydrateLocalCacheFromMongoPages,
  normalizeYouTubeQuery,
  setCachedYouTubePage,
  youtubeQueriesLooselyEqual,
} from "../../components/youtube/youtube-cache"
import { prepareTextForAzureTts } from "../../components/shared/speech/tts-prep"
import { getActiveDataKey, getStoredToken } from "../../components/login/auth-storage"
import { environment } from "../../../environments/environment"
import { resolveClientTimezone } from "../../utils/client-timezone"

const API_BASE = String(environment.apiBase || "").replace(/\/$/, "")

async function request(path, options = {}) {
  const token = getStoredToken()
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  })
  return res
}

/** Read SSE stream from POST /api/chat (OpenAI path in Node-AI). */
export async function chatWithOpenAI({
  message,
  history = [],
  systemPrompt,
  model = "gpt-4o-mini",
  timezone = resolveClientTimezone(),
}) {
  const res = await request("/api/chat", {
    method: "POST",
    body: JSON.stringify({ message, history, systemPrompt, model, timezone }),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.message || err.error || `Chat failed (${res.status})`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let full = ""
  let buffer = ""
  let usedWebSearch = false

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split("\n\n")
    buffer = parts.pop() || ""

    for (const part of parts) {
      const line = part.trim()
      if (!line.startsWith("data:")) continue
      const json = line.replace(/^data:\s*/, "")
      try {
        const data = JSON.parse(json)
        if (data.error) throw new Error(data.message || data.error)
        if (data.usedWebSearch) usedWebSearch = true
        if (data.done || data.complete) continue
        if (typeof data.response === "string") full += data.response
        if (typeof data.content === "string") full += data.content
        if (typeof data.delta === "string") full += data.delta
      } catch (e) {
        if (e.message && !e.message.includes("JSON")) throw e
      }
    }
  }

  return { text: full.trim() || "(No response)", usedWebSearch }
}

/** Claude via Express POST /api/claude/chat */
export async function chatWithClaudeApi(messages, systemPrompt) {
  const res = await request("/api/claude/chat", {
    method: "POST",
    body: JSON.stringify({ messages, systemPrompt }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.message || data.error || `Claude chat failed (${res.status})`)
  }
  return {
    text: data.text || "(No response)",
    usedWebSearch: Boolean(data.usedWebSearch),
  }
}

export async function fetchAzureVoices() {
  const res = await request("/api/voices")
  if (!res.ok) throw new Error("Failed to fetch voices")
  return res.json()
}

/** Azure TTS via Node-AI POST /api/tts — returns playable blob URL helpers */
let currentTtsAudio = null

/**
 * Synthesise text and return a playable blob URL without starting playback.
 *
 * Kept separate from playback so a caller can render the next sentence while
 * the current one is still speaking. The caller owns the URL and must pass it
 * to playTtsAudioUrl (which revokes it) or call URL.revokeObjectURL itself.
 */
export async function fetchTtsAudioUrl(text, voice = "en-US-AndrewNeural") {
  // Keep markdown structure as SSML pauses (titles / paragraphs / list items).
  // Do NOT flatten all whitespace — that is what made recipes sound jumbled.
  const clean = prepareTextForAzureTts(text)

  const res = await request("/api/tts", {
    method: "POST",
    body: JSON.stringify({ text: clean || "OK.", voice }),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.details || err.error || `TTS failed (${res.status})`)
  }

  const buffer = await res.arrayBuffer()
  const blob = new Blob([buffer], { type: "audio/mpeg" })
  return URL.createObjectURL(blob)
}

/**
 * Play an already-synthesised blob URL and return the usual control handle.
 * Revokes the URL once playback settles.
 */
export async function playTtsAudioUrl(url) {
  const audio = new Audio(url)
  currentTtsAudio = audio
  let settled = false
  let resolveDone = () => {}

  const finish = () => {
    if (settled) return
    settled = true
    if (currentTtsAudio === audio) currentTtsAudio = null
    try {
      audio.pause()
      audio.removeAttribute("src")
      audio.load()
    } catch {
      /* ignore */
    }
    try {
      URL.revokeObjectURL(url)
    } catch {
      /* ignore */
    }
    resolveDone()
  }

  const done = new Promise((resolve) => {
    resolveDone = resolve
    audio.onended = finish
    audio.onerror = finish
  })

  await audio.play()
  return {
    stop: () => {
      try {
        audio.pause()
        audio.currentTime = 0
        audio.removeAttribute("src")
        audio.load()
      } catch {
        /* ignore */
      }
      finish()
    },
    pause: () => {
      if (settled || audio.paused) return false
      try {
        audio.pause()
        return true
      } catch {
        return false
      }
    },
    resume: () => {
      if (settled || !audio.paused) return false
      try {
        void audio.play()
        return true
      } catch {
        return false
      }
    },
    isPaused: () => Boolean(!settled && audio.paused && audio.currentTime > 0),
    done,
  }
}

/** Synthesise and play in one step. */
export async function speakViaServerTts(text, voice = "en-US-AndrewNeural") {
  const url = await fetchTtsAudioUrl(text, voice)
  return playTtsAudioUrl(url)
}

/** Force-stop any in-flight Azure <audio> even before the speak handle is wired. */
export function stopCurrentTtsAudio() {
  const audio = currentTtsAudio
  currentTtsAudio = null
  if (!audio) return
  try {
    audio.pause()
    audio.currentTime = 0
    audio.removeAttribute("src")
    audio.load()
  } catch {
    /* ignore */
  }
}

export function pauseCurrentTtsAudio() {
  const audio = currentTtsAudio
  if (!audio || audio.paused || audio.ended) return false
  try {
    audio.pause()
    return true
  } catch {
    return false
  }
}

export function resumeCurrentTtsAudio() {
  const audio = currentTtsAudio
  if (!audio || !audio.paused || audio.ended) return false
  try {
    void audio.play()
    return true
  } catch {
    return false
  }
}

export function isCurrentTtsAudioPaused() {
  const audio = currentTtsAudio
  return Boolean(audio && !audio.ended && audio.paused && audio.currentTime > 0)
}

export async function searchYouTube(query, { page = 1, pageToken = null, type = "search" } = {}) {
  const body = { query, type, page }
  if (pageToken) body.pageToken = pageToken
  const res = await request("/api/youtube/search", {
    method: "POST",
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.success === false) {
    const primary = data.error || data.message || "YouTube search failed"
    const detail = data.details && !primary.includes(data.details) ? data.details : ""
    const note = data.note || ""
    throw new Error([primary, detail, note].filter(Boolean).join(" — "))
  }
  return data
}

/** Resolve channel name or video id → UC… id for the in-app uploads playlist player. */
export async function resolveYouTubeChannel({ q = "", videoId = "" } = {}) {
  const params = new URLSearchParams()
  if (videoId) params.set("videoId", String(videoId).trim())
  if (q) params.set("q", String(q).trim())
  const res = await request(`/api/youtube/resolve-channel?${params}`)
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.success === false) {
    throw new Error(data.error || data.message || "Could not resolve channel")
  }
  return data
}

/** Restore cached pages from MongoDB (no YouTube API quota). */
export async function restoreYouTubeCacheFromMongo(query) {
  const res = await request(
    `/api/youtube/restore-cache/${encodeURIComponent(query)}`
  )
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.message || data.error || "Mongo restore failed")
  }
  return data
}

const hydratedMongoQueries = new Set()

/**
 * Pull the fullest Mongo cache for this query into localStorage (quota-free).
 * Runs once per normalized query per page session unless force=true.
 */
export async function ensureYouTubeMongoHydrated(
  query,
  { type = "search", force = false } = {}
) {
  const key = normalizeYouTubeQuery(query)
  if (!key) return null
  if (!force && hydratedMongoQueries.has(key)) {
    return {
      success: true,
      pages: getAllCachedPagesForQuery(query, type),
      totalPages: highestCachedPageForQuery(query, type),
      fromSession: true,
    }
  }

  const variants = [
    query,
    key,
    key.replace(/\./g, " "),
  ].filter((v, i, arr) => v && arr.indexOf(v) === i)

  let best = null
  for (const variant of variants) {
    try {
      const restored = await restoreYouTubeCacheFromMongo(variant)
      if (restored?.success && Array.isArray(restored.pages) && restored.pages.length) {
        const matches =
          youtubeQueriesLooselyEqual(query, restored.query) ||
          youtubeQueriesLooselyEqual(query, restored.displayName) ||
          youtubeQueriesLooselyEqual(query, variant)
        if (!matches) continue
        if (!best || restored.pages.length > best.pages.length) {
          best = restored
        }
      }
    } catch {
      /* try next variant */
    }
  }

  if (best?.pages?.length) {
    hydrateLocalCacheFromMongoPages(query, best.pages, type)
    hydratedMongoQueries.add(key)
    return best
  }
  return null
}

/**
 * Cache-first YouTube search:
 * 1) hydrate from MongoDB (once)  2) localStorage  3) YouTube API (quota)
 * Fresh API pages are written back to localStorage.
 */
export async function searchYouTubeCached(
  query,
  { page = 1, pageToken = null, type = "search", skipCache = false } = {}
) {
  const pageNum = Math.max(1, Number(page) || 1)

  if (!skipCache) {
    // Always try Mongo hydrate first so Next/Last use saved Santana pages, not API
    const restored = await ensureYouTubeMongoHydrated(query, { type })

    const local = getCachedYouTubePage(query, pageNum, type)
    if (local) {
      const highest = highestCachedPageForQuery(query, type)
      const restoredPages = Number(restored?.totalPages) || 0
      const restoredMatches =
        restored?.success &&
        (!restored.query ||
          youtubeQueriesLooselyEqual(query, restored.query) ||
          youtubeQueriesLooselyEqual(query, restored.displayName))
      return {
        ...local,
        quota: null,
        fromCache: true,
        cacheSource: restored?.pages?.length && restoredMatches
          ? "mongodb"
          : local.cacheSource || "localStorage",
        // Stored pages for this query only — not YouTube estimates
        totalPages: Math.max(highest, restoredMatches ? restoredPages : 0, pageNum),
      }
    }
  }

  const data = await searchYouTube(query, { page: pageNum, pageToken, type })
  if (data?.videos?.length) {
    setCachedYouTubePage(query, data.page || pageNum, {
      videos: data.videos,
      nextPageToken: data.nextPageToken || null,
      resultType: data.resultType || "MULTI",
      type,
    })
  }
  const highest = highestCachedPageForQuery(query, type)
  return {
    ...data,
    fromCache: Boolean(data.fromCache),
    cacheSource: data.fromCache ? data.cacheSource || "server-memory" : "api",
    // Ignore API totalPages estimates (YouTube totalResults is unreliable)
    totalPages: Math.max(highest, pageNum),
  }
}

export async function saveYouTubeSearch({
  query,
  userId = getActiveDataKey(),
  displayName,
  videoCount = 0,
  totalPages = 1,
  videoResults = null,
  cacheKeys = null,
}) {
  const body = {
    query,
    userId,
    displayName: displayName || query,
    videoCount,
    totalPages,
  }
  if (Array.isArray(videoResults)) body.videoResults = videoResults
  if (Array.isArray(cacheKeys)) body.cacheKeys = cacheKeys

  const res = await request("/api/youtube/save-search", {
    method: "POST",
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.success === false) {
    throw new Error(data.error || data.message || "Failed to save search")
  }
  return data
}

export async function listSavedYouTubeSearches(userId = getActiveDataKey()) {
  const params = new URLSearchParams({ userId })
  const res = await request(`/api/youtube/saved-searches?${params}`)
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.success === false) {
    const text = data.message || data.error || "Failed to load saved searches"
    if (/access token required|invalid or expired token|missing a data scope/i.test(text)) {
      throw new Error(
        "Session expired or not signed in — please sign out and sign back in, then open History again."
      )
    }
    throw new Error(text)
  }
  return data
}

export async function deleteSavedYouTubeSearch(
  searchId,
  userId = getActiveDataKey(),
  { unsaveOnly = true } = {}
) {
  const params = new URLSearchParams({ userId })
  if (unsaveOnly) params.set("unsaveOnly", "true")
  const res = await request(
    `/api/youtube/saved-searches/${encodeURIComponent(searchId)}?${params}`,
    { method: "DELETE" }
  )
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.success === false) {
    throw new Error(data.error || data.message || "Failed to delete search")
  }
  return data
}

export async function analyzeImage({ image, prompt }) {
  const res = await request("/api/analyze-image", {
    method: "POST",
    body: JSON.stringify({ image, prompt }),
  })
  if (!res.ok) {
    const raw = await res.text().catch(() => "")
    let err = {}
    try {
      err = raw ? JSON.parse(raw) : {}
    } catch {
      /* non-JSON (proxy/HTML) */
    }
    throw new Error(
      err.error ||
        err.message ||
        err.details ||
        (raw && raw.slice(0, 160)) ||
        `Image analysis failed (HTTP ${res.status})`,
    )
  }
  // SSE stream — accumulate text
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let full = ""
  let buffer = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split("\n\n")
    buffer = parts.pop() || ""
    for (const part of parts) {
      const line = part.trim()
      if (!line.startsWith("data:")) continue
      try {
        const data = JSON.parse(line.replace(/^data:\s*/, ""))
        if (data.error) throw new Error(data.message || data.error)
        if (data.done || data.complete) continue
        if (typeof data.response === "string") full += data.response
        if (typeof data.content === "string") full += data.content
        if (typeof data.delta === "string") full += data.delta
      } catch (e) {
        if (e.message && !e.message.includes("JSON")) throw e
      }
    }
  }
  return full.trim()
}

/**
 * Generate an image with OpenAI GPT Image models.
 * @param {{ prompt: string, preset?: 'cheap'|'quality', size?: string, quality?: string }} opts
 */
export async function generateImage({
  prompt,
  preset = "cheap",
  size = "1024x1024",
  quality,
} = {}) {
  const body = { prompt, preset, size }
  if (quality) body.quality = quality
  const res = await request("/api/images/generate", {
    method: "POST",
    body: JSON.stringify(body),
  })
  const raw = await res.text()
  let data
  try {
    data = raw ? JSON.parse(raw) : {}
  } catch {
    if (!res.ok) {
      throw new Error(
        res.status === 404
          ? "Image API route not found — restart the server (npm run dev:stable)."
          : `Image generation failed (HTTP ${res.status})`
      )
    }
    throw new Error("Image generation returned an invalid response")
  }
  if (!res.ok || data.success === false) {
    const err = new Error(
      data.error || data.message || "Image generation failed"
    )
    // Let callers show the remaining count / prompt a sign-in without re-parsing.
    err.status = res.status
    err.reason = data.reason || (res.status === 401 ? "anonymous" : "")
    err.usage = data.usage || null
    throw err
  }
  return data
}

/**
 * Read the server's AI guard rails and this caller's current standing.
 *
 * The UI never hardcodes a limit — help text, inline hints, and the remaining
 * image count all render from this response, so what a user is told is always
 * what the server enforces.
 */
export async function getAiStatus() {
  const res = await request("/api/ai/status")
  if (!res.ok) throw new Error(`Could not load AI status (HTTP ${res.status})`)
  const data = await res.json()
  if (data.success === false) {
    throw new Error(data.error || "Could not load AI status")
  }
  return data
}

export async function listJokes({
  sessionId = getActiveDataKey(),
  showAll = false,
} = {}) {
  const params = new URLSearchParams({
    sessionId,
    showAll: String(showAll),
  })
  const res = await request(`/api/jokes/list-jokes?${params}`)
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.success === false) {
    throw new Error(data.message || "Failed to load jokes")
  }
  return data
}

export async function saveJoke({
  title,
  content,
  userId = getActiveDataKey(),
}) {
  const res = await request("/api/jokes/save-joke", {
    method: "POST",
    body: JSON.stringify({ title, content, userId }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.message || "Failed to save joke")
  return data
}

export async function searchImages(query, { start = 1 } = {}) {
  const params = new URLSearchParams({ q: query })
  if (start > 1) params.set("start", String(start))

  const attempt = async () => {
    const res = await request(`/api/image-search?${params}`)
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      throw new Error(
        data.details || data.error || data.message || "Image search failed"
      )
    }
    return data
  }

  try {
    return await attempt()
  } catch (firstErr) {
    // One retry — upstream sources can flake under concurrent chat load
    await new Promise((r) => setTimeout(r, 400))
    try {
      return await attempt()
    } catch {
      throw firstErr
    }
  }
}

export async function parseRecipe(text) {
  const res = await request("/api/recipe", {
    method: "POST",
    body: JSON.stringify({ text }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.message || "Recipe parse failed")
  return data
}

/** Node-AI personal profile (conversation_history), e.g. type=name → "Paul". */
export async function fetchPersonalInfoType(
  type,
  sessionId = getActiveDataKey()
) {
  const qs = new URLSearchParams({ sessionId })
  const res = await request(
    `/api/personal-info/${encodeURIComponent(type)}?${qs}`
  )
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.message || data.error || "Personal info lookup failed")
  }
  return data.value ?? null
}

/** All typed facts for the active session → { name, hobby, ... }. */
export async function fetchAllPersonalInfo(sessionId = getActiveDataKey()) {
  const qs = new URLSearchParams({ sessionId })
  const res = await request(`/api/personal-info/all?${qs}`)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.message || data.error || "Personal info lookup failed")
  }
  return data.personalInfo && typeof data.personalInfo === "object"
    ? data.personalInfo
    : {}
}

/** Upsert a personal fact (name, etc.) into Mongo conversation_history. */
export async function savePersonalInfoType(
  type,
  value,
  sessionId = getActiveDataKey()
) {
  const res = await request(`/api/personal-info/${encodeURIComponent(type)}`, {
    method: "POST",
    body: JSON.stringify({ value, sessionId }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.success === false) {
    throw new Error(data.message || data.error || "Could not save personal info")
  }
  return data.value ?? value
}

/** Remove one typed fact from Mongo (POST with empty value). */
export async function deletePersonalInfoType(
  type,
  sessionId = getActiveDataKey()
) {
  const res = await request(`/api/personal-info/${encodeURIComponent(type)}`, {
    method: "POST",
    body: JSON.stringify({ value: "", sessionId }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.success === false) {
    throw new Error(data.message || data.error || "Could not delete personal info")
  }
  return true
}

export async function login({ email, password }) {
  const res = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.success === false) {
    throw new Error(data.message || data.error || "Login failed")
  }
  return data
}

export async function register({ email, password }) {
  const res = await request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.success === false) {
    throw new Error(data.message || data.error || "Registration failed")
  }
  return data
}

export async function verifyToken(token) {
  const res = await request("/api/auth/verify", {
    method: "POST",
    body: JSON.stringify({ token }),
  })
  return res.json()
}

/** Auth0 / Google → Multichat JWT */
export async function loginWithOAuth({ accessToken, idToken } = {}) {
  const res = await request("/api/auth/oauth", {
    method: "POST",
    headers: {
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify({
      ...(accessToken ? { accessToken } : {}),
      ...(idToken ? { idToken } : {}),
    }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.success === false) {
    throw new Error(data.message || data.error || "Social login failed")
  }
  return data
}

/** RAG — upload PDF/text for Q&A */
export async function uploadRagDocument(file, dataKey = getActiveDataKey()) {
  const token = getStoredToken()
  const form = new FormData()
  form.append("file", file)
  form.append("dataKey", dataKey)
  const res = await fetch(`${API_BASE}/api/rag/upload`, {
    method: "POST",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: form,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.success === false) {
    throw new Error(data.error || data.message || "Upload failed")
  }
  return data.document
}

export async function listRagDocuments(dataKey = getActiveDataKey()) {
  const params = new URLSearchParams({ dataKey })
  const res = await request(`/api/rag/documents?${params}`)
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.success === false) {
    throw new Error(data.error || data.message || "Failed to list documents")
  }
  return data.documents || []
}

export async function deleteRagDocument(id, dataKey = getActiveDataKey()) {
  const params = new URLSearchParams({ dataKey })
  const res = await request(`/api/rag/documents/${encodeURIComponent(id)}?${params}`, {
    method: "DELETE",
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.success === false) {
    throw new Error(data.error || data.message || "Delete failed")
  }
  return data
}

/** Ask a question against one or more indexed RAG documents. */
export async function askRag(opts: {
  question: string
  documentId?: string
  documentIds?: string[]
  dataKey?: string
}) {
  const question = opts.question
  const documentId = opts.documentId || ""
  const documentIds = opts.documentIds
  const dataKey = opts.dataKey || getActiveDataKey()
  const ids = [
    ...new Set(
      (Array.isArray(documentIds) ? documentIds : documentId ? [documentId] : [])
        .map((id) => String(id || "").trim())
        .filter(Boolean)
    ),
  ]
  const res = await request("/api/rag/ask", {
    method: "POST",
    body: JSON.stringify({
      dataKey,
      question,
      ...(ids.length ? { documentIds: ids } : {}),
    }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.success === false) {
    throw new Error(data.error || data.message || "Ask failed")
  }
  return data
}

export async function listChatConversations() {
  const res = await request("/api/conversations")
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.success === false) {
    const text = data.message || data.error || "Failed to load conversations"
    if (/access token required|invalid or expired token|missing a data scope/i.test(text)) {
      throw new Error(
        "Session expired or not signed in — please sign out and sign back in, then open History again."
      )
    }
    throw new Error(text)
  }
  return data.conversations || []
}

export async function getChatConversation(id) {
  const res = await request(`/api/conversations/${encodeURIComponent(id)}`)
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.success === false) {
    throw new Error(data.message || data.error || "Failed to load conversation")
  }
  return data.conversation
}

export async function saveChatConversation({ id, title, messages }) {
  const res = await request("/api/conversations", {
    method: "POST",
    body: JSON.stringify({ id, title, messages }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.success === false) {
    throw new Error(data.message || data.error || "Failed to save conversation")
  }
  return data.conversation
}

export async function deleteChatConversation(id) {
  const res = await request(`/api/conversations/${encodeURIComponent(id)}`, {
    method: "DELETE",
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.success === false) {
    throw new Error(data.message || data.error || "Failed to delete conversation")
  }
  return data
}

export { request }

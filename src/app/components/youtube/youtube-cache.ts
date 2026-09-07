// @ts-nocheck
/**
 * Browser localStorage cache for YouTube search pages.
 *
 * Entries are namespaced per account:
 *   global-persistent-storage-001-v1::yt_search_carlos.santana_p1_none
 *
 * Without the namespace every account sharing a browser profile saw the same
 * recent-search list and could replay each other's cached pages, which the
 * server-side scoping cannot prevent.
 */

import { getActiveDataKey, LEGACY_DATA_KEY } from "../login/auth-storage"
import {
  cleanYouTubeQueryForDisplay,
  normalizeYouTubeQuery,
  preferYouTubeDisplayName,
  preferYouTubeNormalizedKey,
  repairYouTubeDisplayNameFromTitles,
  youtubeConsonantSkeleton,
} from "./youtube-query-clean"

export {
  cleanYouTubeQueryForDisplay,
  normalizeYouTubeQuery,
  preferYouTubeDisplayName,
  preferYouTubeNormalizedKey,
  repairYouTubeDisplayNameFromTitles,
  youtubeConsonantSkeleton,
} from "./youtube-query-clean"

/** Legacy key that deleted accents instead of folding (Rós → rs). */
function legacyAccentStripKey(query) {
  return cleanYouTubeQueryForDisplay(query)
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ".")
    .replace(/[^a-z0-9.]/g, "")
    .replace(/\.+/g, ".")
    .replace(/^\.+|\.+$/g, "")
}

export function youtubeQueryKeyVariants(query) {
  return [
    ...new Set(
      [normalizeYouTubeQuery(query), legacyAccentStripKey(query)].filter(Boolean)
    ),
  ]
}

/**
 * Accent/typo twin? ("sigur.ros" ↔ "sigur.rs") — not a longer distinct search
 * ("privettriker" must not absorb "privettricker.revival").
 */
export function youtubeQueriesLooselyEqual(a, b) {
  const na = normalizeYouTubeQuery(a)
  const nb = normalizeYouTubeQuery(b)
  if (!na || !nb) return false
  if (na === nb) return true
  // Same letters with/without word dots: privettrickerrevival ↔ privettricker.revival
  if (na.replace(/\./g, "") === nb.replace(/\./g, "")) return true
  if (legacyAccentStripKey(a) === legacyAccentStripKey(b)) return true
  const sa = youtubeConsonantSkeleton(na)
  const sb = youtubeConsonantSkeleton(nb)
  if (!sa || sa !== sb) return false
  return Math.abs(na.replace(/\./g, "").length - nb.replace(/\./g, "").length) <= 2
}

function currentScope() {
  return getActiveDataKey() || "anon"
}

/** Namespace a bare cache name for the signed-in account. */
export function scopeCacheKey(name) {
  return `${currentScope()}::${name}`
}

/**
 * Read a namespaced entry, falling back to the old un-namespaced name.
 *
 * Only the legacy account gets the fallback: those entries were written before
 * namespacing existed and are its own. Other accounts start empty rather than
 * inheriting whatever the browser happened to hold.
 */
function readScoped(name) {
  const scoped = readRaw(scopeCacheKey(name))
  if (scoped !== null) return scoped
  return currentScope() === LEGACY_DATA_KEY ? readRaw(name) : null
}

export function buildYouTubeCacheKey(query, type = "search", page = 1) {
  const normalized = normalizeYouTubeQuery(query)
  return `yt_${type}_${normalized}_p${page}_none`
}

function readRaw(key) {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function writeRaw(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch (err) {
    // Quota exceeded — drop oldest entries for this account and retry once.
    // Scoped to the caller so one account cannot evict another's cache.
    try {
      const prefix = `${currentScope()}::yt_`
      const keys = []
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        if (k?.startsWith(prefix)) keys.push(k)
      }
      keys.slice(0, Math.ceil(keys.length / 4)).forEach((k) => localStorage.removeItem(k))
      localStorage.setItem(key, JSON.stringify(value))
      return true
    } catch {
      console.warn("[youtubeCache] localStorage write failed:", err?.message)
      return false
    }
  }
}

function extractVideos(entry) {
  if (!entry) return []
  const layers = [entry, entry.data, entry.data?.data].filter(Boolean)
  for (const layer of layers) {
    if (Array.isArray(layer.videos) && layer.videos.length) return layer.videos
  }
  return []
}

function extractNextPageToken(entry) {
  if (!entry) return null
  const layers = [entry, entry.data, entry.data?.data].filter(Boolean)
  for (const layer of layers) {
    if (layer.nextPageToken) return layer.nextPageToken
  }
  return null
}

/** Read one page from localStorage. Returns null on miss. */
export function getCachedYouTubePage(query, page = 1, type = "search") {
  const entry = readScoped(buildYouTubeCacheKey(query, type, page))
  const videos = extractVideos(entry)
  if (!videos.length) return null

  return {
    success: true,
    videos,
    page: entry?.page || entry?.data?.page || page,
    nextPageToken: extractNextPageToken(entry),
    fromCache: true,
    cacheSource: "localStorage",
    resultType: entry?.resultType || entry?.data?.resultType || "MULTI",
  }
}

/** Persist one search page to localStorage (Node-compatible shape). */
export function setCachedYouTubePage(
  query,
  page,
  { videos, nextPageToken = null, resultType = "MULTI", type = "search" } = {}
) {
  if (!videos?.length) return false
  const key = scopeCacheKey(buildYouTubeCacheKey(query, type, page))
  return writeRaw(key, {
    videos,
    page,
    nextPageToken,
    resultType,
    timestamp: Date.now(),
    data: { videos, page, nextPageToken, resultType },
  })
}

/** Write every page returned from Mongo restore into localStorage. */
export function hydrateLocalCacheFromMongoPages(query, pages = [], type = "search") {
  let count = 0
  for (const p of pages) {
    const pageNum = p.page || 1
    const videos = p.videos || []
    if (!videos.length) continue
    if (
      setCachedYouTubePage(query, pageNum, {
        videos,
        nextPageToken: p.nextPageToken || null,
        resultType: p.resultType || "MULTI",
        type,
      })
    ) {
      count++
    }
  }
  return count
}

const RECENT_NAME = "yt_recent_queries"
const MAX_RECENT = 40

/** Track queries the user actually searched (local history; not necessarily Mongo-saved). */
export function rememberRecentYouTubeQuery(query) {
  const normalized = normalizeYouTubeQuery(query)
  if (!normalized) return
  const displayName =
    preferYouTubeDisplayName(query, cleanYouTubeQueryForDisplay(query)) ||
    normalized.replace(/\./g, " ")
  const entry = {
    query: normalized,
    displayName: displayName || normalized.replace(/\./g, " "),
    lastSearched: Date.now(),
  }
  const prev = listRecentYouTubeQueries().filter((r) => {
    const other = normalizeYouTubeQuery(r.query || r.displayName)
    if (!other) return false
    if (youtubeQueriesLooselyEqual(normalized, other)) return false
    return true
  })
  writeRaw(scopeCacheKey(RECENT_NAME), [entry, ...prev].slice(0, MAX_RECENT))
}

export function listRecentYouTubeQueries() {
  const raw = readScoped(RECENT_NAME)
  if (!Array.isArray(raw)) return []
  // Collapse legacy keys (youtube.seach.*, sigur.rs↔sigur.ros) into one row each
  const bySkel = new Map()
  for (const r of raw) {
    const key = normalizeYouTubeQuery(r.query || r.displayName)
    if (!key) continue
    const skel = youtubeConsonantSkeleton(key) || key
    const prev = bySkel.get(skel)
    const mergedKey = preferYouTubeNormalizedKey(prev?.query, key)
    const lastSearched = Math.max(r.lastSearched || 0, prev?.lastSearched || 0)
    bySkel.set(skel, {
      query: mergedKey,
      displayName:
        preferYouTubeDisplayName(
          r.displayName,
          prev?.displayName,
          cleanYouTubeQueryForDisplay(r.displayName),
          mergedKey.replace(/\./g, " ")
        ) || mergedKey.replace(/\./g, " "),
      lastSearched,
    })
  }
  return [...bySkel.values()].sort(
    (a, b) => (b.lastSearched || 0) - (a.lastSearched || 0)
  )
}

/** Remove a query from the local recent-history list. */
export function forgetRecentYouTubeQuery(query) {
  if (!query) return
  const next = listRecentYouTubeQueries().filter(
    (r) => !queriesMatch(r.query || r.displayName, query)
  )
  writeRaw(scopeCacheKey(RECENT_NAME), next)
}

/**
 * Drop all localStorage page caches for a search query (yt_search_… keys).
 */
export function clearLocalYouTubeCacheForQuery(query, type = "search") {
  if (!query) return 0
  const targets = new Set(youtubeQueryKeyVariants(query))
  const toRemove = []
  try {
    const bare = `yt_${type}_`
    const scopePrefix = `${currentScope()}::`
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key) continue
      let bareKey = null
      if (key.startsWith(bare)) bareKey = key
      else if (key.startsWith(scopePrefix) && key.slice(scopePrefix.length).startsWith(bare)) {
        bareKey = key.slice(scopePrefix.length)
      }
      if (!bareKey) continue
      const match = bareKey.match(new RegExp(`^yt_${type}_(.+)_p(\\d+)_`))
      if (!match) continue
      const body = match[1]
      const bodyNorm = normalizeYouTubeQuery(body.replace(/\./g, " "))
      const bodyLegacy = legacyAccentStripKey(body.replace(/\./g, " "))
      const exactHit =
        targets.has(bodyNorm) ||
        targets.has(bodyLegacy) ||
        targets.has(body) ||
        [...targets].some((t) => body === t || body.endsWith(`.${t}`))
      const looseHit = youtubeQueriesLooselyEqual(query, bodyNorm || body)
      if (exactHit || looseHit) toRemove.push(key)
    }
    toRemove.forEach((k) => localStorage.removeItem(k))
  } catch {
    /* ignore */
  }
  return toRemove.length
}

/** Collect all cached pages for a query from localStorage (for Mongo save). */
export function getAllCachedPagesForQuery(query, type = "search") {
  const targets = new Set(youtubeQueryKeyVariants(query))
  const pagesByNum = new Map()
  try {
    const bare = `yt_${type}_`
    const scopePrefix = `${currentScope()}::`
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key) continue
      let bareKey = null
      if (key.startsWith(bare)) bareKey = key
      else if (key.startsWith(scopePrefix) && key.slice(scopePrefix.length).startsWith(bare)) {
        bareKey = key.slice(scopePrefix.length)
      }
      if (!bareKey) continue
      const match = bareKey.match(new RegExp(`^yt_${type}_(.+)_p(\\d+)_`))
      if (!match) continue
      const body = match[1]
      const bodyNorm = normalizeYouTubeQuery(body.replace(/\./g, " "))
      const bodyLegacy = legacyAccentStripKey(body.replace(/\./g, " "))
      const exactHit =
        targets.has(bodyNorm) ||
        targets.has(bodyLegacy) ||
        targets.has(body) ||
        [...targets].some((t) => body === t || body.endsWith(`.${t}`))
      // Loose match for accent twins only — not longer distinct queries
      const looseHit = youtubeQueriesLooselyEqual(query, bodyNorm || body)
      if (!exactHit && !looseHit) continue
      const pageNum = Number(match[2])
      if (!pageNum) continue
      const entry = readRaw(key)
      const videos = extractVideos(entry)
      if (!videos.length) continue
      const prev = pagesByNum.get(pageNum)
      if (!prev || videos.length > (prev.videos?.length || 0)) {
        pagesByNum.set(pageNum, {
          page: pageNum,
          videos,
          nextPageToken: extractNextPageToken(entry),
          resultType: entry?.resultType || entry?.data?.resultType || "MULTI",
          timestamp: entry?.timestamp || Date.now(),
        })
      }
    }
  } catch {
    /* ignore */
  }
  return [...pagesByNum.values()].sort((a, b) => a.page - b.page)
}

/** Highest page number stored for a query (not merely how many page slots exist). */
export function highestCachedPageForQuery(query, type = "search") {
  return getAllCachedPagesForQuery(query, type).reduce(
    (max, p) => Math.max(max, Number(p.page) || 0),
    0
  )
}

export function queriesMatch(a, b) {
  return youtubeQueriesLooselyEqual(a, b)
}

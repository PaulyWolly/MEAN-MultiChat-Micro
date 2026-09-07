// @ts-nocheck
/**
 * Playlist name helpers — keep in sync with Node-AI playlistNameNormalizer.
 */

import {
  cleanYouTubeQueryForDisplay,
  foldYouTubeAscii,
  youtubeConsonantSkeleton,
} from "./youtube-query-clean"

export function stripPlaylistPrefixes(name) {
  if (!name) return ""
  let cleaned = name
    .replace(/^youtube\s+search\s+/i, "")
    .replace(/^youtube\s+channel\s+/i, "")
    .replace(/^youtube\s+movies?\s+/i, "")
    .replace(/^youtube\s+tv\s+/i, "")
    .replace(/^youtube\s+/i, "")
    .replace(/^search\s+/i, "")
    .replace(/^channel\s+/i, "")
    .replace(/^movies?\s+/i, "")
    .replace(/^tv\s+/i, "")
    .trim()
  if (!cleaned) cleaned = name.trim()
  return cleaned.replace(/[._-]/g, " ").replace(/\s+/g, " ").trim()
}

export function getPlaylistVisibleName(name) {
  if (!name) return ""
  let cleaned = stripPlaylistPrefixes(name)
  if (!cleaned) cleaned = name.trim()
  return cleaned.replace(/\b\w/g, (l) => l.toUpperCase())
}

export function getPlaylistVisibleNameKey(name) {
  return getPlaylistVisibleName(name).toLowerCase().trim()
}

function normalizeMatchKey(text) {
  return foldYouTubeAscii(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function scrubChannelHint(channel) {
  return String(channel || "")
    .replace(/\s*[-–—]\s*Topic$/i, "")
    .replace(/\s*VEVO$/i, "")
    .replace(/\s*Official$/i, "")
    .trim()
}

/**
 * Artist / subject hints from a staged video + optional YouTube search query.
 * Used to float matching playlists to the top of Playlist Manager.
 */
export function playlistHintsFromVideo(video, contextQuery = "") {
  const hints = []
  const push = (raw) => {
    const v = String(raw || "").trim()
    if (!v || v.length < 2) return
    if (!hints.some((h) => normalizeMatchKey(h) === normalizeMatchKey(v))) {
      hints.push(v)
    }
  }

  const q = cleanYouTubeQueryForDisplay(contextQuery)
  if (q) push(q)

  const channel = scrubChannelHint(video?.channelTitle || video?.channel)
  if (channel) push(channel)

  const title = String(video?.title || "").trim()
  if (title) {
    const parts = title
      .split(/\s[-–—|:]\s+/)
      .map((p) => p.trim())
      .filter(Boolean)
    if (parts.length >= 2) {
      // "Foo Fighters - My Hero" → artist before the dash
      push(parts[0])
    }
    // "Foo Fighters Live at…" — leading phrase before Live/Official/…
    const lead = title.match(
      /^(.+?)(?:\s+(?:live|official|full|concert|ft\.?|feat\.?|perform|covers?)\b|[(\[]|$)/i
    )
    if (lead?.[1] && lead[1].length >= 3 && lead[1].length < title.length) {
      push(lead[1].trim())
    }
  }

  return hints
}

/**
 * Best playlist name when auto-creating from a staged video + search query.
 * Prefers cleaned search query, then channel, then title lead-in.
 */
export function suggestedPlaylistNameFromVideo(video, contextQuery = "") {
  const hints = playlistHintsFromVideo(video, contextQuery)
  if (hints[0]) return hints[0]

  const q = cleanYouTubeQueryForDisplay(contextQuery)
  if (q) return q

  const channel = scrubChannelHint(video?.channelTitle || video?.channel)
  if (channel) return channel

  const title = String(video?.title || "").trim()
  if (title) return title.slice(0, 80)

  return "New Playlist"
}

/** Score 0–100 how well a playlist name matches artist/search hints. */
export function scorePlaylistNameAgainstHints(playlistName, hints) {
  const name = normalizeMatchKey(getPlaylistVisibleName(playlistName))
  if (!name || !hints?.length) return 0

  const nameSkel = youtubeConsonantSkeleton(name)
  let best = 0

  for (const hint of hints) {
    const h = normalizeMatchKey(hint)
    if (!h || h.length < 2) continue

    if (name === h) {
      best = Math.max(best, 100)
      continue
    }

    const hSkel = youtubeConsonantSkeleton(h)
    if (hSkel.length >= 4 && nameSkel === hSkel) {
      best = Math.max(best, 95)
      continue
    }

    if (name.includes(h) || h.includes(name)) {
      best = Math.max(best, 85)
      continue
    }

    const nameTokens = name.split(" ").filter(Boolean)
    const hintTokens = h.split(" ").filter((t) => t.length > 1)
    if (!hintTokens.length) continue
    const hits = hintTokens.filter((t) => nameTokens.includes(t)).length
    if (hits === hintTokens.length && hintTokens.length >= 1) {
      best = Math.max(best, 75)
    } else if (hits >= 2) {
      best = Math.max(best, 55)
    } else if (hits === 1 && hintTokens[0].length >= 5) {
      best = Math.max(best, 40)
    }
  }

  return best
}

export const PLAYLIST_HINT_MATCH_MIN = 55

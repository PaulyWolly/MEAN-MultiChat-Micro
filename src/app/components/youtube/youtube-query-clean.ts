// @ts-nocheck
/**
 * Strip voice/UI prefixes from YouTube search strings so history shows
 * "Sigur Rós" not "Youtube Seach Sigur Rs".
 * Handles both spaced input and legacy dotted cache keys (youtube.seach.sigur.rs).
 *
 * Accent rule: fold ó→o ("Rós"→"ros"), never strip the letter ("Rós"→"rs").
 * Handle rule: never promote "@Coldplay" over "Coldplay".
 */
const YOUTUBE_PREFIX_RE =
  /^(?:youtube[\s.]+(?:search|seach|play|channel|movies?|tv)|youtube|search|channel|movies?|tv)[\s.]+/i

/** Fold accents: "Rós" → "ros" (not "rs"). */
export function foldYouTubeAscii(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
}

/** Drop YouTube @handles so "@Coldplay" → "Coldplay". */
export function stripYouTubeHandlePrefix(text) {
  return String(text || "")
    .replace(/^[@＠]+/gu, "")
    .replace(/(^|[\s.])[@＠]+/gu, "$1")
    .replace(/\s+/g, " ")
    .trim()
}

/** Trailing "Coldplay:" / "Ros..." punctuation is not part of the query. */
export function stripYouTubeTrailingPunct(text) {
  return String(text || "")
    .replace(/[:;,.!?…]+$/gu, "")
    .replace(/\s+/g, " ")
    .trim()
}

function scrubYouTubeLabel(text) {
  return stripYouTubeTrailingPunct(stripYouTubeHandlePrefix(text))
}

export function cleanYouTubeQueryForDisplay(query) {
  const original = scrubYouTubeLabel(String(query || "").trim())
  if (!original) return ""

  // Normalize dots→spaces for prefix strip, then restore subject casing from original
  const spaced = original.replace(/\./g, " ").replace(/\s+/g, " ").trim()
  const cleanedSpaced = scrubYouTubeLabel(
    spaced.replace(YOUTUBE_PREFIX_RE, "").trim()
  )
  if (!cleanedSpaced) return original.replace(/\./g, " ").trim() || original

  const lowerSpaced = spaced.toLowerCase()
  const lowerClean = cleanedSpaced.toLowerCase()
  const startPos = lowerSpaced.indexOf(lowerClean)
  if (startPos >= 0) {
    // Map back onto original if it used spaces; otherwise title-ish from cleaned
    if (!original.includes(".")) {
      return scrubYouTubeLabel(
        original.slice(startPos, startPos + cleanedSpaced.length).trim()
      )
    }
  }
  return cleanedSpaced
}

/** Dot-key used for cache / Mongo query field. */
export function normalizeYouTubeQuery(query) {
  return foldYouTubeAscii(cleanYouTubeQueryForDisplay(query))
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ".")
    .replace(/[^a-z0-9.]/g, "")
    .replace(/\.+/g, ".")
    .replace(/^\.+|\.+$/g, "")
}

export function humanizeYouTubeQueryKey(normalized) {
  return String(normalized || "")
    .replace(/\./g, " ")
    .replace(/\b\w/g, (l) => l.toUpperCase())
}

function vowelCount(text) {
  return (foldYouTubeAscii(text).match(/[aeiou]/gi) || []).length
}

/** Consonant skeleton so "Sigur Rós" / "Sigur Ros" / "Sigur Rs" match. */
export function youtubeConsonantSkeleton(text) {
  return foldYouTubeAscii(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s.]/g, "")
    .replace(/[aeiou]/g, "")
    .replace(/[.\s]+/g, " ")
    .trim()
}

/**
 * Prefer fuller spellings (e.g. "Sigur Ros" over "Sigur Rs").
 * Keep English-keyboard ASCII when it already matches the folded accented form
 * ("Sigur Ros" wins over "Sigur Rós"). Only prefer accents when they restore
 * missing letters (Rs → Rós/Ros).
 * Never prefer trailing punctuation ("Coldplay:" over "Coldplay").
 */
export function preferYouTubeDisplayName(...candidates) {
  let best = ""
  for (const raw of candidates) {
    const cleaned = cleanYouTubeQueryForDisplay(raw) || scrubYouTubeLabel(raw)
    if (!cleaned) continue
    // Never prefer a raw dotted cache key as the visible label
    if (/^[a-z0-9]+(\.[a-z0-9]+)+$/i.test(String(raw || "").trim()) && !String(raw).includes(" ")) {
      const human = scrubYouTubeLabel(humanizeYouTubeQueryKey(String(raw).trim()))
      if (!best) best = human
      else {
        const skelBest = youtubeConsonantSkeleton(best)
        const skelNext = youtubeConsonantSkeleton(human)
        if (skelBest && skelBest === skelNext && vowelCount(human) > vowelCount(best)) {
          best = human
        } else if (human.length > best.length && vowelCount(human) >= vowelCount(best)) {
          best = human
        }
      }
      continue
    }
    if (!best) {
      best = cleaned
      continue
    }
    const bestUni = /[^\u0000-\u007F]/.test(best)
    const nextUni = /[^\u0000-\u007F]/.test(cleaned)
    const skelBest = youtubeConsonantSkeleton(best)
    const skelNext = youtubeConsonantSkeleton(cleaned)

    // Accented vs ASCII: only switch when accents restore missing letters
    if (nextUni && !bestUni) {
      if (skelBest && skelBest === skelNext) {
        if (vowelCount(cleaned) > vowelCount(best)) {
          // Prefer folded ASCII for English-keyboard display (Rós → Ros)
          best = foldYouTubeAscii(cleaned)
        }
      }
      continue
    }
    if (bestUni && !nextUni) {
      if (skelBest && skelBest === skelNext) {
        // Prefer ASCII when it has same/more vowels (user typed without accent)
        if (vowelCount(cleaned) >= vowelCount(foldYouTubeAscii(best))) {
          best = cleaned
        } else if (vowelCount(cleaned) > vowelCount(best)) {
          best = cleaned
        }
      }
      continue
    }

    if (skelBest && skelBest === skelNext) {
      if (vowelCount(cleaned) > vowelCount(best)) {
        best = cleaned
        continue
      }
      if (vowelCount(cleaned) < vowelCount(best)) continue
      // Prefer Title Case / mixed over all-lowercase ("Coldplay" over "coldplay")
      const bestLower = best === best.toLowerCase()
      const nextLower = cleaned === cleaned.toLowerCase()
      if (bestLower && !nextLower) {
        best = cleaned
        continue
      }
      if (!bestLower && nextLower) continue
      // Same subject — keep existing (don't grow via "Coldplay:" punctuation)
      continue
    }
    if (cleaned.length > best.length) best = cleaned
  }
  return best
}

/**
 * Prefer the folded cache key with vowels over a legacy accent-stripped key
 * (sigur.ros over sigur.rs).
 */
export function preferYouTubeNormalizedKey(...keys) {
  let best = ""
  for (const raw of keys) {
    const key = normalizeYouTubeQuery(raw) || String(raw || "").trim()
    if (!key) continue
    if (!best) {
      best = key
      continue
    }
    const skelBest = youtubeConsonantSkeleton(best)
    const skelNext = youtubeConsonantSkeleton(key)
    if (skelBest && skelBest === skelNext) {
      if (vowelCount(key) > vowelCount(best)) best = key
      else if (vowelCount(key) === vowelCount(best) && key.length > best.length) best = key
      continue
    }
    if (key.length > best.length) best = key
  }
  return best
}

/**
 * Restore letters lost to bad accent-stripping (Rs → Ros).
 * Uses video titles for spelling, but folds to ASCII so English-keyboard
 * searches stay "Sigur Ros" (not "Sigur Rós").
 */
export function repairYouTubeDisplayNameFromTitles(displayName, titles = []) {
  const label =
    cleanYouTubeQueryForDisplay(displayName) ||
    scrubYouTubeLabel(String(displayName || "").trim())
  if (!label || !titles.length) return label
  const labelFold = foldYouTubeAscii(label).toLowerCase().replace(/[^a-z0-9\s]/g, "").trim()
  const labelSkel = youtubeConsonantSkeleton(label)
  if (!labelSkel) return label

  let best = label
  for (const title of titles) {
    const head = scrubYouTubeLabel(
      String(title || "")
        .split(/\s+[-\u2013|:]+|\s+[(\[]/)[0]
        ?.trim()
    )
    if (!head) continue
    // Also split on attached punctuation: "Coldplay: Clocks" → "Coldplay"
    const headWords = head
      .split(/\s+/)
      .map((w) => scrubYouTubeLabel(w))
      .filter(Boolean)
    if (!headWords.length) continue
    const headJoined = headWords.join(" ")
    const headFold = foldYouTubeAscii(headJoined)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .trim()
    const headSkel = youtubeConsonantSkeleton(headJoined)
    if (
      headFold === labelFold ||
      headSkel === labelSkel ||
      headFold.startsWith(labelFold + " ") ||
      labelFold.startsWith(headFold)
    ) {
      const words = label.split(/\s+/).length
      const repairedRaw = scrubYouTubeLabel(headWords.slice(0, words).join(" "))
      // Fold accents for display (Rós → Ros) — matches English keyboard searches
      const repaired = scrubYouTubeLabel(foldYouTubeAscii(repairedRaw))
      if (
        youtubeConsonantSkeleton(repaired) === labelSkel ||
        foldYouTubeAscii(repaired)
          .toLowerCase()
          .includes(labelFold.split(/\s+/)[0])
      ) {
        best = preferYouTubeDisplayName(best, repaired, label) || repaired
      }
    }
  }
  return best
}

/** Final label for History rows / results chrome. */
export function formatYouTubeHistoryLabel(itemOrName, titles = []) {
  const raw =
    typeof itemOrName === "string"
      ? itemOrName
      : itemOrName?.displayName || itemOrName?.query || ""
  const hintTitles = [
    ...titles,
    ...(Array.isArray(itemOrName?.titleHints) ? itemOrName.titleHints : []),
  ]
  const cleaned = cleanYouTubeQueryForDisplay(raw) || scrubYouTubeLabel(raw)
  const repaired = repairYouTubeDisplayNameFromTitles(cleaned, hintTitles)
  const preferred = preferYouTubeDisplayName(repaired, cleaned) || cleaned
  // Title-case all-lowercase single/multi word labels ("coldplay" → "Coldplay")
  if (preferred && preferred === preferred.toLowerCase()) {
    return preferred.replace(/\b[a-z]/g, (c) => c.toUpperCase())
  }
  return preferred
}

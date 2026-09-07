// @ts-nocheck
/**
 * Auth + Mongo data-scope storage (JWT + dataKey).
 * dataKey scopes jokes / YouTube / playlists / personal info per user.
 */

export const TOKEN_KEY = "multichat-jwt"
export const USER_KEY = "multichat-user"
export const DATA_KEY_KEY = "multichat-data-key"
export const GUEST_MODE_KEY = "multichat-guest-mode"

/** Matches Node-AI single-user bucket (Paul's existing docs). */
export const LEGACY_DATA_KEY = "global-persistent-storage-001-v1"

/** Isolated scope for anonymous guest sessions (Chat / Images / About only). */
export const GUEST_DATA_KEY = "guest-local-v1"

/** Paths guests may open without JWT / Auth0. */
export const GUEST_ALLOWED_PATHS = ["/", "/images", "/rag", "/about", "/login"]

export function getStoredToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || ""
  } catch {
    return ""
  }
}

export function getStoredUser() {
  try {
    const raw = localStorage.getItem(USER_KEY)
    if (!raw) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function getStoredDataKey() {
  try {
    return localStorage.getItem(DATA_KEY_KEY) || ""
  } catch {
    return ""
  }
}

export function isGuestMode() {
  try {
    if (getStoredToken()) return false
    return localStorage.getItem(GUEST_MODE_KEY) === "1"
  } catch {
    return false
  }
}

export function enterGuestMode() {
  try {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(USER_KEY)
    localStorage.setItem(GUEST_MODE_KEY, "1")
    localStorage.setItem(DATA_KEY_KEY, GUEST_DATA_KEY)
  } catch {
    /* ignore */
  }
}

export function clearGuestMode() {
  try {
    localStorage.removeItem(GUEST_MODE_KEY)
    if (getStoredDataKey() === GUEST_DATA_KEY) {
      localStorage.removeItem(DATA_KEY_KEY)
    }
  } catch {
    /* ignore */
  }
}

/**
 * Active Mongo scope for API calls.
 * Logged-in → user.dataKey; guest → guest-local; else legacy fallback.
 */
export function getActiveDataKey() {
  const stored = getStoredDataKey()
  if (getStoredToken()) {
    const user = getStoredUser()
    if (user?.dataKey) return user.dataKey
    if (stored) return stored
  }
  if (isGuestMode()) return GUEST_DATA_KEY
  if (stored) return stored
  return LEGACY_DATA_KEY
}

export function persistAuthSession({ token, user } = {}) {
  try {
    clearGuestMode()
    if (token) localStorage.setItem(TOKEN_KEY, token)
    if (user) {
      localStorage.setItem(USER_KEY, JSON.stringify(user))
      if (user.dataKey) localStorage.setItem(DATA_KEY_KEY, user.dataKey)
    }
  } catch {
    /* ignore */
  }
}

export function clearAuthSession() {
  try {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(USER_KEY)
    localStorage.removeItem(DATA_KEY_KEY)
    localStorage.removeItem(GUEST_MODE_KEY)
  } catch {
    /* ignore */
  }
}

export function pathAllowedForGuest(pathname) {
  const path = String(pathname || "/").split("?")[0] || "/"
  return GUEST_ALLOWED_PATHS.includes(path)
}

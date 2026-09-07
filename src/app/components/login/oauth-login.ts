// @ts-nocheck
import { environment } from '../../../environments/environment'
/**
 * Auth0 / Google OAuth helpers (client-side Universal Login / Google OAuth).
 * Configure via src/environments/environment.ts.
 */

function appOrigin() {
  if (typeof window === "undefined") return ""
  return window.location.origin
}

export function getAuth0Config() {
  const domain = (environment.auth0Domain || "").trim()
  const clientId = (environment.auth0ClientId || "").trim()
  const audience = (environment.auth0Audience || "").trim()
  return {
    configured: Boolean(domain && clientId),
    domain,
    clientId,
    audience,
  }
}

export function getGoogleOAuthConfig() {
  const clientId = (environment.googleClientId || "").trim()
  return {
    configured: Boolean(clientId),
    clientId,
  }
}

/** Auth0 authorize URL (Universal Login — can include Google connection). */
export function buildAuth0AuthorizeUrl({ connection } = {}) {
  const { configured, domain, clientId, audience } = getAuth0Config()
  if (!configured) return null

  const redirectUri = `${appOrigin()}/login`
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "token id_token",
    redirect_uri: redirectUri,
    scope: "openid profile email",
    nonce: crypto.randomUUID?.() || String(Date.now()),
    state: connection === "google-oauth2" ? "google" : "auth0",
  })
  if (audience) params.set("audience", audience)
  if (connection) params.set("connection", connection)

  return `https://${domain}/authorize?${params}`
}

/** Google OAuth 2.0 implicit/code start (browser redirect). */
export function buildGoogleAuthorizeUrl() {
  const { configured, clientId } = getGoogleOAuthConfig()
  if (!configured) return null

  const redirectUri = `${appOrigin()}/login`
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "token",
    scope: "openid email profile",
    include_granted_scopes: "true",
    state: "google",
  })
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`
}

export function startAuth0Login({ connection } = {}) {
  const url = buildAuth0AuthorizeUrl({ connection })
  if (!url) {
    throw new Error(
      "Auth0 is not configured. Set auth0Domain and auth0ClientId in environment.ts."
    )
  }
  window.location.assign(url)
}

export function startGoogleLogin() {
  // Prefer Auth0 Google connection when Auth0 is set up (one callback path)
  const auth0 = getAuth0Config()
  if (auth0.configured) {
    startAuth0Login({ connection: "google-oauth2" })
    return
  }
  const url = buildGoogleAuthorizeUrl()
  if (!url) {
    throw new Error(
      "Google sign-in is not configured. Set googleClientId or Auth0 values in environment.ts."
    )
  }
  window.location.assign(url)
}

/**
 * Parse Auth0 / Google redirect hash on /login.
 * Clears the hash from the URL after reading.
 * @returns {{ accessToken?: string, idToken?: string, provider: string, error?: string, errorDescription?: string } | null}
 */
export function parseOAuthRedirectHash() {
  if (typeof window === "undefined") return null
  const raw = window.location.hash?.replace(/^#/, "") || ""
  if (!raw) return null

  const params = new URLSearchParams(raw)
  const error = params.get("error") || ""
  const errorDescription = params.get("error_description") || ""
  const accessToken = params.get("access_token") || ""
  const idToken = params.get("id_token") || ""
  const state = params.get("state") || "auth0"

  // Clear sensitive tokens from the address bar
  const { pathname, search } = window.location
  window.history.replaceState({}, document.title, `${pathname}${search}`)

  if (error) {
    return {
      provider: state === "google" ? "google" : "auth0",
      error,
      errorDescription: errorDescription.replace(/\+/g, " "),
    }
  }

  if (!accessToken && !idToken) return null

  return {
    accessToken: accessToken || undefined,
    idToken: idToken || undefined,
    provider: state === "google" ? "google" : "auth0",
  }
}

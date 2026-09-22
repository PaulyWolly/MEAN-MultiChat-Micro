// @ts-nocheck
import { environment } from '../../../environments/environment'
/**
 * Auth0 / Google OAuth helpers (client-side Universal Login / Google OAuth).
 * Configure via src/environments/environment.ts.
 *
 * Uses implicit / hybrid fragment tokens (`token id_token`). Auth0 Application
 * must be a SPA with callback http(s)://<origin>/login and Implicit (or
 * matching OIDC) grants enabled — otherwise Auth0 returns ?code= and we cannot
 * finish login without PKCE.
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
    response_mode: "fragment",
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

function clearOAuthParamsFromUrl() {
  const { pathname } = window.location
  window.history.replaceState({}, document.title, pathname)
}

/**
 * Parse Auth0 / Google redirect on /login (hash fragment and/or query string).
 * Clears tokens from the URL after reading.
 * @returns {{ accessToken?: string, idToken?: string, provider: string, error?: string, errorDescription?: string } | null}
 */
export function parseOAuthRedirectHash() {
  if (typeof window === "undefined") return null

  const hashRaw = window.location.hash?.replace(/^#/, "") || ""
  const queryRaw = window.location.search?.replace(/^\?/, "") || ""
  if (!hashRaw && !queryRaw) return null

  const hash = new URLSearchParams(hashRaw)
  const query = new URLSearchParams(queryRaw)

  const pick = (key) => hash.get(key) || query.get(key) || ""

  const error = pick("error")
  const errorDescription = pick("error_description")
  const accessToken = pick("access_token")
  const idToken = pick("id_token")
  const code = pick("code")
  const state = pick("state") || "auth0"

  const hadOAuthNoise = Boolean(
    error || accessToken || idToken || code || hashRaw || queryRaw.includes("state=")
  )
  if (hadOAuthNoise) clearOAuthParamsFromUrl()

  if (error) {
    return {
      provider: state === "google" ? "google" : "auth0",
      error,
      errorDescription: errorDescription.replace(/\+/g, " "),
    }
  }

  if (code && !accessToken && !idToken) {
    return {
      provider: state === "google" ? "google" : "auth0",
      error: "unsupported_response",
      errorDescription:
        "Auth0 returned an authorization code, but this app expects tokens in the URL. " +
        "In Auth0 → Applications → MEAN-MultiChat → Settings → Advanced → Grant Types, " +
        "enable Implicit, and set Application Type to Single Page Application. " +
        "Allowed Callback URLs must include " +
        `${appOrigin()}/login`,
    }
  }

  if (!accessToken && !idToken) return null

  return {
    accessToken: accessToken || undefined,
    idToken: idToken || undefined,
    provider: state === "google" ? "google" : "auth0",
  }
}

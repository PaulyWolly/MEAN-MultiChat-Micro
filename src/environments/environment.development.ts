/** Local dev — `ng serve` uses this via angular.json fileReplacements. */
export const environment = {
  production: false,
  // REST still uses Angular proxy (`apiBase: ''` → /api → :4800).
  apiBase: '',
  // SSE heartbeat bypasses Vite proxy (long-lived streams get ECONNRESET there).
  gatewayBase: 'http://localhost:4800',
  // MEAN-MultiChat Auth0 SPA (public client id — not a secret).
  auth0Domain: 'pwconsulting.auth0.com',
  auth0ClientId: 'b4xkM6nI02LZM0UKdOEYLakp7qRKPXkB',
  auth0Audience: '',
  googleClientId: '',
};

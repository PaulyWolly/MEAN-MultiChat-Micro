/**
 * Auth0 token helpers (ported from My-Profiling-App pattern).
 * Accepts Auth0 access_token (Bearer) and resolves email via JWT claims or /userinfo.
 */

const jwt = require('jsonwebtoken');

function getAuth0Issuer() {
  const raw = (
    process.env.AUTH0_ISSUER_BASE_URL ||
    process.env.AUTH0_DOMAIN ||
    ''
  ).trim();
  if (!raw) return '';
  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    return raw.replace(/\/$/, '');
  }
  return `https://${raw.replace(/\/$/, '')}`;
}

/**
 * Resolve Auth0 user profile from an access or id token string.
 * @returns {Promise<{sub:string,email:string,name?:string,picture?:string,email_verified?:boolean}|null>}
 */
async function resolveAuth0UserFromToken(token) {
  if (!token || typeof token !== 'string') return null;

  const issuer = getAuth0Issuer();
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded?.payload) return null;

  let email = decoded.payload.email;
  let name = decoded.payload.name;
  let picture = decoded.payload.picture;
  let emailVerified = Boolean(decoded.payload.email_verified);

  if (!email && issuer) {
    try {
      const userinfoResponse = await fetch(`${issuer}/userinfo`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (userinfoResponse.ok) {
        const userinfo = await userinfoResponse.json();
        email = userinfo.email || email;
        name = userinfo.name || name;
        picture = userinfo.picture || picture;
        emailVerified = Boolean(userinfo.email_verified ?? emailVerified);
      }
    } catch (err) {
      console.warn('[Auth0] userinfo fetch failed:', err.message);
    }
  }

  if (!email && decoded.payload.sub) {
    // Last resort — avoid inventing fake emails for login
    return null;
  }
  if (!email) return null;

  return {
    sub: decoded.payload.sub || '',
    email: String(email).toLowerCase().trim(),
    name: name || String(email).split('@')[0],
    picture: picture || '',
    email_verified: emailVerified,
  };
}

module.exports = {
  getAuth0Issuer,
  resolveAuth0UserFromToken,
};

/**
 * Shared JWT auth middleware.
 *
 * Lives here rather than inside server.js so route modules (AI routes, quota
 * enforcement) can attach the same identity check without importing the whole
 * server. `req.user.id` set here is what the per-user quota counts against.
 */

const jwt = require('jsonwebtoken')
const User = require('../models/User')

// Read lazily rather than at import time: this module must not depend on being
// required after dotenv has run.
function getJwtSecret() {
  return process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production'
}

/** Resolve a verified token payload to the request-shaped user object. */
async function loadUserFromToken(token) {
  const decoded = await new Promise((resolve) => {
    jwt.verify(token, getJwtSecret(), (err, payload) => resolve(err ? null : payload))
  })
  if (!decoded?.userId) return null

  const user = await User.findById(decoded.userId)
  if (!user || !user.isActive) return null

  return {
    id: user._id,
    email: user.email,
    role: user.role,
    dataKey: user.dataKey || null,
  }
}

function readBearer(req) {
  const authHeader = req.headers['authorization']
  return (authHeader && authHeader.split(' ')[1]) || ''
}

/** Reject the request unless it carries a valid token for an active user. */
async function authenticateToken(req, res, next) {
  const token = readBearer(req)
  if (!token) {
    return res.status(401).json({ success: false, message: 'Access token required' })
  }

  try {
    const user = await loadUserFromToken(token)
    if (!user) {
      return res.status(403).json({ success: false, message: 'Invalid or expired token' })
    }
    req.user = user
    next()
  } catch (error) {
    console.error('[AUTH] Middleware error:', error)
    return res.status(500).json({ success: false, message: 'Internal server error' })
  }
}

/**
 * Populate req.user when a valid token is present, but let anonymous and guest
 * callers through. Routes that meter usage must still check for req.user.
 */
async function optionalAuth(req, _res, next) {
  const token = readBearer(req)
  if (!token) return next()

  try {
    req.user = (await loadUserFromToken(token)) || undefined
  } catch (error) {
    console.warn('[AUTH] optionalAuth ignored a bad token:', error?.message || error)
  }
  next()
}

/**
 * Require a signed-in caller and publish the owner key its documents live under.
 *
 * The key comes from the verified token, never from the path, query or body, so
 * a caller cannot read or delete another account's rows by naming its id.
 * Routes downstream must filter on req.scopeKey rather than any supplied value.
 */
function requireDataScope(req, res, next) {
  authenticateToken(req, res, () => {
    const scopeKey = req.user?.dataKey
    if (!scopeKey) {
      return res
        .status(403)
        .json({ success: false, message: 'Account is missing a data scope' })
    }
    req.scopeKey = scopeKey
    next()
  })
}

module.exports = { authenticateToken, optionalAuth, requireDataScope, getJwtSecret }

/**
 * Shared JWT auth middleware (copied from monolith for this peel).
 */

const jwt = require('jsonwebtoken');
const User = require('../models/User');

function getJwtSecret() {
  return process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production';
}

async function loadUserFromToken(token) {
  const decoded = await new Promise((resolve) => {
    jwt.verify(token, getJwtSecret(), (err, payload) => resolve(err ? null : payload));
  });
  if (!decoded?.userId) return null;

  const user = await User.findById(decoded.userId);
  if (!user || !user.isActive) return null;

  return {
    id: user._id,
    email: user.email,
    role: user.role,
    dataKey: user.dataKey || null,
  };
}

function readBearer(req) {
  const authHeader = req.headers['authorization'];
  return (authHeader && authHeader.split(' ')[1]) || '';
}

async function authenticateToken(req, res, next) {
  const token = readBearer(req);
  if (!token) {
    return res.status(401).json({ success: false, message: 'Access token required' });
  }

  try {
    const user = await loadUserFromToken(token);
    if (!user) {
      return res.status(403).json({ success: false, message: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  } catch (error) {
    console.error('[AUTH] Middleware error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

async function optionalAuth(req, _res, next) {
  const token = readBearer(req);
  if (!token) return next();

  try {
    req.user = (await loadUserFromToken(token)) || undefined;
  } catch (error) {
    console.warn('[AUTH] optionalAuth ignored a bad token:', error?.message || error);
  }
  next();
}

function requireDataScope(req, res, next) {
  authenticateToken(req, res, () => {
    const scopeKey = req.user?.dataKey;
    if (!scopeKey) {
      return res
        .status(403)
        .json({ success: false, message: 'Account is missing a data scope' });
    }
    req.scopeKey = scopeKey;
    next();
  });
}

function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      message: 'Authentication required',
    });
  }

  if (req.user.role !== 'admin' && req.user.role !== 'superadmin') {
    return res.status(403).json({
      success: false,
      message: 'Admin access required',
    });
  }

  next();
}

function requireSuperAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      message: 'Authentication required',
    });
  }

  if (req.user.role !== 'superadmin') {
    return res.status(403).json({
      success: false,
      message: 'SuperAdmin access required',
    });
  }

  next();
}

module.exports = {
  authenticateToken,
  optionalAuth,
  requireDataScope,
  requireAdmin,
  requireSuperAdmin,
  getJwtSecret,
};

/**
 * JWT optionalAuth for speech (STT/TTS). No Mongo — guests are allowed through.
 */
const jwt = require('jsonwebtoken');

function getJwtSecret() {
  return process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production';
}

function readBearer(req) {
  const authHeader = req.headers.authorization;
  return (authHeader && authHeader.split(' ')[1]) || '';
}

async function optionalAuth(req, _res, next) {
  const token = readBearer(req);
  if (!token) return next();

  jwt.verify(token, getJwtSecret(), (err, payload) => {
    if (!err && payload) {
      req.user = {
        id: payload.userId || payload.id || null,
        email: payload.email || null,
        role: payload.role || null,
      };
    }
    next();
  });
}

module.exports = { optionalAuth, getJwtSecret };

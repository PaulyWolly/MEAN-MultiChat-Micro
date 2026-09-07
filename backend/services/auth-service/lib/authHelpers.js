/**
 * Auth helpers peeled from monolith server.js.
 */

const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../models/User');
const { getJwtSecret } = require('../middleware/auth');

const SALT_ROUNDS = 12;

/** Existing single-user Multichat docs live under these keys. */
const LEGACY_DATA_KEY = 'global-persistent-storage-001-v1';
const LEGACY_USER_ALIASES = ['default-user', LEGACY_DATA_KEY];

function getSuperAdminPassword() {
  return process.env.SUPERADMIN_PASSWORD || 'superadmin-secret-2025';
}

function generateToken(user, extras = {}) {
  const authMethod = extras.authMethod || user.authProvider || 'password';
  return jwt.sign(
    {
      userId: user._id,
      email: user.email,
      role: user.role,
      dataKey: user.dataKey || null,
      authMethod,
    },
    getJwtSecret(),
    { expiresIn: '7d' },
  );
}

function publicUserPayload(user, extras = {}) {
  const authMethod = extras.authMethod || user.authProvider || null;
  return {
    id: user._id,
    email: user.email,
    role: user.role,
    dataKey: user.dataKey || null,
    /** How this session signed in: password | google | auth0 */
    authProvider: authMethod === 'password' ? null : authMethod,
    auth0Id: user.auth0Id || null,
  };
}

/** Point old default-user / global docs at the claimed dataKey. */
async function migrateLegacyDocsTo(dataKey) {
  const db = mongoose.connection;
  if (!db?.db) return;

  const jokeResult = await db.collection('my_jokes').updateMany(
    { userId: { $in: LEGACY_USER_ALIASES } },
    { $set: { userId: dataKey } },
  );
  const ytResult = await db.collection('youtube_searches').updateMany(
    { userId: { $in: LEGACY_USER_ALIASES } },
    { $set: { userId: dataKey } },
  );
  const playlistResult = await db.collection('playlists').updateMany(
    { userId: { $in: LEGACY_USER_ALIASES } },
    { $set: { userId: dataKey } },
  );
  const personalBagResult = await db.collection('personal_info').updateMany(
    { userId: { $in: LEGACY_USER_ALIASES } },
    { $set: { userId: dataKey } },
  );

  console.log('[AUTH] Legacy migrate:', {
    jokes: jokeResult.modifiedCount,
    youtube: ytResult.modifiedCount,
    playlists: playlistResult.modifiedCount,
    personal_info: personalBagResult.modifiedCount,
    dataKey,
  });
}

/**
 * Ensure every account has a stable dataKey for Mongo scoping.
 * First account (or first admin) without an owner claims the legacy Paul bucket.
 */
async function ensureUserDataKey(user) {
  if (user.dataKey) return user.dataKey;

  const legacyOwner = await User.findOne({ dataKey: LEGACY_DATA_KEY }).select('_id');
  const assignedCount = await User.countDocuments({
    dataKey: { $exists: true, $nin: [null, ''] },
  });

  let dataKey;
  if (!legacyOwner && assignedCount === 0) {
    dataKey = LEGACY_DATA_KEY;
  } else if (!legacyOwner && (user.role === 'admin' || user.role === 'superadmin')) {
    dataKey = LEGACY_DATA_KEY;
  } else {
    dataKey = `user-${user._id}-v1`;
  }

  user.dataKey = dataKey;
  user.updated = new Date();
  await user.save();

  if (dataKey === LEGACY_DATA_KEY) {
    try {
      await migrateLegacyDocsTo(dataKey);
    } catch (err) {
      console.warn('[AUTH] Legacy data migrate warning:', err.message);
    }
  }

  console.log(`[AUTH] Assigned dataKey=${dataKey} to ${user.email}`);
  return dataKey;
}

module.exports = {
  SALT_ROUNDS,
  LEGACY_DATA_KEY,
  LEGACY_USER_ALIASES,
  getSuperAdminPassword,
  generateToken,
  publicUserPayload,
  ensureUserDataKey,
  migrateLegacyDocsTo,
};

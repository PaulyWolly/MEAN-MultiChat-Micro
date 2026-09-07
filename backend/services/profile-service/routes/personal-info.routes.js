/**
 * Personal-info / profile endpoints — peeled from monolith server.js.
 * Mounted at /api/personal-info
 * JWT required (authenticateToken); sessionId/dataKey scoping matches monolith.
 */
const express = require('express');
const mongoose = require('mongoose');
const PersonalInfo = require('../models/PersonalInfo');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

const LEGACY_DATA_KEY = 'global-persistent-storage-001-v1';
const LEGACY_USER_ALIASES = ['default-user', LEGACY_DATA_KEY];
const GUEST_DATA_KEY = 'guest-local-v1';
const PERSISTENT_SESSION = {
  id: 'persistent-storage-001',
  version: 'v1',
  type: 'global',
};

router.use(authenticateToken);

function defaultSessionId() {
  return `${PERSISTENT_SESSION.type}-${PERSISTENT_SESSION.id}-${PERSISTENT_SESSION.version}`;
}

// GET /all — must be before /:type
router.get('/all', async (req, res) => {
  try {
    const sessionId =
      (req.query.sessionId && String(req.query.sessionId).trim()) ||
      req.user?.dataKey ||
      defaultSessionId();

    console.log('Received request for all personal info:', { sessionId });

    const sessionIds =
      sessionId === LEGACY_DATA_KEY
        ? [LEGACY_DATA_KEY, ...LEGACY_USER_ALIASES.filter((id) => id !== LEGACY_DATA_KEY)]
        : [sessionId];

    const docs = await PersonalInfo.find({ sessionId: { $in: sessionIds } })
      .sort({ timestamp: -1, updated: -1 })
      .lean();

    const personalInfo = {};
    for (const doc of docs) {
      const key = String(doc.type || '').trim();
      if (!key || doc.value == null || doc.value === '') continue;
      if (personalInfo[key] === undefined) {
        personalInfo[key] = doc.value;
      }
    }

    const bagUserIds = [...new Set([sessionId, ...sessionIds, 'default-user', 'global'])];
    const bag = await mongoose.connection.collection('personal_info').findOne({
      userId: { $in: bagUserIds },
    });
    if (bag?.content && typeof bag.content === 'object') {
      for (const [k, v] of Object.entries(bag.content)) {
        if (v == null || v === '') continue;
        if (personalInfo[k] === undefined) personalInfo[k] = v;
      }
    }
    if (bag?.personalInfo && typeof bag.personalInfo === 'object') {
      for (const [k, v] of Object.entries(bag.personalInfo)) {
        if (v == null || v === '') continue;
        if (personalInfo[k] === undefined) personalInfo[k] = v;
      }
    }

    console.log('Personal info keys for session:', Object.keys(personalInfo));
    res.json({ personalInfo, sessionId });
  } catch (error) {
    console.error('Error retrieving personal info:', {
      error: error.message,
      stack: error.stack,
      name: error.name,
    });
    res.status(500).json({ error: error.message });
  }
});

// GET /:type
router.get('/:type', async (req, res) => {
  try {
    const { type } = req.params;
    const sessionId =
      (req.query.sessionId && String(req.query.sessionId).trim()) ||
      req.user?.dataKey ||
      defaultSessionId();

    const info = await PersonalInfo.findOne(
      { sessionId, type },
      { value: 1, _id: 0 },
    ).sort({ timestamp: -1 });

    res.json({ value: info?.value || null });
  } catch (error) {
    console.error('Error retrieving personal info:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /:type
router.post('/:type', async (req, res) => {
  try {
    const { type } = req.params;
    const rawValue = req.body?.value;
    const value = rawValue == null ? '' : String(rawValue).trim();
    if (!type) {
      return res.status(400).json({ success: false, error: 'type is required' });
    }

    const sessionId =
      req.body?.sessionId || req.user?.dataKey || defaultSessionId();

    if (sessionId === GUEST_DATA_KEY) {
      return res.status(403).json({
        success: false,
        error: 'Guest accounts cannot save or change a profile. Sign in to continue.',
      });
    }

    if (!value) {
      const sessionIds =
        sessionId === LEGACY_DATA_KEY
          ? [LEGACY_DATA_KEY, ...LEGACY_USER_ALIASES.filter((id) => id !== LEGACY_DATA_KEY)]
          : [sessionId];
      await PersonalInfo.deleteMany({ sessionId: { $in: sessionIds }, type });

      const bagUserIds = [...new Set([sessionId, ...sessionIds, 'default-user', 'global'])];
      try {
        await mongoose.connection.collection('personal_info').updateMany(
          { userId: { $in: bagUserIds } },
          { $unset: { [`content.${type}`]: '', [`personalInfo.${type}`]: '' } },
        );
      } catch (bagErr) {
        console.warn('[PERSONAL-INFO] Legacy bag unset skipped:', bagErr.message);
      }

      return res.json({ success: true, value: null, deleted: true, type, sessionId });
    }

    const now = new Date();
    await PersonalInfo.findOneAndUpdate(
      { sessionId, type },
      {
        $set: {
          value,
          sessionId,
          type,
          timestamp: now,
          updated: now,
          userId: sessionId.split('-')[0],
          sessionType: PERSISTENT_SESSION.type,
          sessionVersion: PERSISTENT_SESSION.version,
        },
        $setOnInsert: { created: now },
      },
      { upsert: true, new: true },
    );

    res.json({ success: true, value, type, sessionId });
  } catch (error) {
    console.error('Error saving personal info type:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /
router.post('/', async (req, res) => {
  try {
    const { userId, content } = req.body;
    console.log('Store personal info request:', { userId, content });

    if (userId === GUEST_DATA_KEY) {
      return res.status(403).json({
        success: false,
        error: 'Guest accounts cannot save or change a profile. Sign in to continue.',
      });
    }

    const match = content.match(/(.+?) is (.+)/);
    if (!match) {
      throw new Error('Invalid content format');
    }
    const [, key, value] = match;

    const listTypes = ['hobbies', 'hobby', 'interests', 'favorite foods', 'pets'];
    const isList = listTypes.some((type) => key.toLowerCase().includes(type));

    let existingInfo = await mongoose.connection
      .collection('personal_info')
      .findOne({ userId });

    if (existingInfo && isList) {
      const existingValue = existingInfo.content[key] || [];
      if (!Array.isArray(existingValue)) {
        existingInfo.content[key] = [existingValue];
      }
      if (!existingInfo.content[key].includes(value)) {
        existingInfo.content[key].push(value);
      }

      await mongoose.connection.collection('personal_info').updateOne(
        { userId },
        { $set: { content: existingInfo.content } },
      );
    } else {
      const info = {
        userId,
        content: { [key]: isList ? [value] : value },
      };

      if (existingInfo) {
        await mongoose.connection.collection('personal_info').updateOne(
          { userId },
          { $set: { [`content.${key}`]: info.content[key] } },
        );
      } else {
        await mongoose.connection.collection('personal_info').insertOne(info);
      }
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error storing personal info:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /
router.get('/', async (req, res) => {
  try {
    const { userId, key } = req.query;
    console.log('Get personal info request:', { userId, key });

    const info = await mongoose.connection
      .collection('personal_info')
      .findOne({ userId });

    if (info && info.content) {
      if (key) {
        const value = info.content[key];
        if (Array.isArray(value)) {
          const formattedList = value.join(', ');
          info.content = `Your ${key} are: ${formattedList}`;
        } else {
          info.content = `Your ${key} is: ${value}`;
        }
      } else {
        const formatted = Object.entries(info.content)
          .map(([k, v]) => {
            if (Array.isArray(v)) {
              return `Your ${k} are: ${v.join(', ')}`;
            }
            return `Your ${k} is: ${v}`;
          })
          .join('\n');
        info.content = formatted;
      }
    }

    res.json({ success: true, info });
  } catch (error) {
    console.error('Error getting personal info:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;

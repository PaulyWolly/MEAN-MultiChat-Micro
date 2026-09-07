/**
 * Platform microservice — misc leftovers peeled from the Express monolith.
 * Gateway: /api/datetime, /api/events, /api/logs, /api/quota, /api/debug,
 *          /api/db-test, /api/cleanup → this process :4812
 */
const path = require('path');
const { spawn } = require('child_process');
const express = require('express');
const cors = require('cors');
const chalk = require('chalk');
const mongoose = require('mongoose');

require('dotenv').config({ path: path.join(__dirname, '../../server/.env') });
require('dotenv').config({ path: path.join(__dirname, '.env'), override: true });

const { resolveMongoUri } = require('./mongoDnsFallback');
const logger = require('./lib/logger');
const Joke = require('./models/Joke');
const logsRoutes = require('./routes/logs.routes');

logger.installProcessHandlers();
logger.info('platform-service.boot', { file: __filename });

const PORT = Number(process.env.PORT) || 4812;
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:4200';
/** Scripts historically lived under backend/server/scripts/… relative to monolith cwd. */
const SCRIPT_CWD = path.join(__dirname, '../../server');

const app = express();
app.disable('x-powered-by');

app.use(
  cors({
    origin: CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean),
    credentials: true,
  }),
);

app.use(express.json({ limit: '2mb' }));

app.use((req, res, next) => {
  const incoming = req.headers['x-request-id'];
  if (typeof incoming === 'string' && incoming.trim()) {
    res.setHeader('x-request-id', incoming.trim());
  }
  next();
});

app.get('/healthz', (_req, res) => {
  res.json({
    ok: true,
    service: 'platform-service',
    port: PORT,
    mongoReadyState: mongoose.connection.readyState,
  });
});

// =====================================================
// Holidays / datetime helpers (from monolith server.js)
// =====================================================

function getHoliday(date) {
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const year = date.getFullYear();

  if (month === 11) {
    const thanksgiving = new Date(year, 10, 1);
    while (thanksgiving.getDay() !== 4) {
      thanksgiving.setDate(thanksgiving.getDate() + 1);
    }
    thanksgiving.setDate(thanksgiving.getDate() + 21);
    if (day === thanksgiving.getDate()) {
      return { name: 'Thanksgiving Day', greeting: 'Happy Thanksgiving!' };
    }
  }

  const holidays = {
    '1/1': "New Year's Day",
    '7/4': 'Independence Day',
    '12/24': 'Christmas Eve',
    '12/25': 'Christmas Day',
    '12/31': "New Year's Eve",
  };

  const dateKey = `${month}/${day}`;
  if (holidays[dateKey]) {
    return {
      name: holidays[dateKey],
      greeting: `Happy ${holidays[dateKey]}!`,
    };
  }
  return null;
}

app.post('/api/datetime', async (req, res) => {
  const { timezone = 'America/Los_Angeles', type } = req.body || {};
  const now = new Date();

  try {
    const timeOptions = {
      timeZone: timezone,
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hour12: true,
    };
    const dateOptions = {
      timeZone: timezone,
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    };

    const currentTime = now.toLocaleTimeString('en-US', timeOptions);
    const currentDate = now.toLocaleDateString('en-US', dateOptions);
    const holiday = getHoliday(now);

    let response;
    if (holiday) {
      if (type === 'date') {
        response = `Today's date is ${currentDate}. This day being a special holiday... I wish you a... ${holiday.greeting}`;
      } else if (type === 'time') {
        response = `The current time is ${currentTime} ${timezone}. By the way, today is ${holiday.name}, so ${holiday.greeting}`;
      } else {
        response = `Today's date is ${currentDate} and the local time is ${currentTime} ${timezone}. This day being a special holiday, I wish to say have a... ${holiday.greeting}`;
      }
    } else if (type === 'date') {
      response = `Today's date is ${currentDate}`;
    } else if (type === 'time') {
      response = `The current time is ${currentTime} ${timezone}`;
    } else {
      response = `Today's date is ${currentDate} and the local time is ${currentTime} ${timezone}`;
    }

    res.json({
      response,
      messageType: type,
      metrics: {
        model: 'datetime',
        duration: `${new Date().toLocaleTimeString()} PST`,
      },
    });
  } catch (error) {
    console.error('[platform] DateTime error:', error);
    res.status(500).json({
      error: 'Failed to get date/time information',
      details: error.message,
    });
  }
});

// =====================================================
// SSE events
// =====================================================

let clients = [];

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const clientId = Date.now();
  clients.push({ id: clientId, res });
  console.log(chalk.blue(`[SSE] Client connected: ${clientId}`));

  req.on('close', () => {
    clients = clients.filter((client) => client.id !== clientId);
    console.log(chalk.yellow(`[SSE] Client disconnected: ${clientId}`));
  });
});

app.use('/api/logs', logsRoutes);

// =====================================================
// Quota script runner (filesystem only)
// =====================================================

app.post('/api/quota/run-script', async (req, res) => {
  const { script } = req.body || {};

  if (!script) {
    return res.status(400).json({
      success: false,
      error: 'Script name is required',
    });
  }

  const scriptMap = {
    fix_quota_monitor: 'scripts/YOUTUBE_QUOTA/fix_quota_monitor.js',
    check_real_youtube_quota: 'scripts/YOUTUBE_QUOTA/check_real_youtube_quota.js',
    force_quota_sync: 'scripts/YOUTUBE_QUOTA/force_quota_sync.js',
    auto_quota_sync: 'scripts/YOUTUBE_QUOTA/auto_quota_sync.js',
  };

  const scriptPath = scriptMap[script];
  if (!scriptPath) {
    return res.status(400).json({
      success: false,
      error: `Unknown script: ${script}`,
    });
  }

  try {
    const scriptProcess = spawn('node', [scriptPath], {
      cwd: SCRIPT_CWD,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let output = '';
    let errorOutput = '';

    scriptProcess.stdout.on('data', (data) => {
      output += data.toString();
    });
    scriptProcess.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    scriptProcess.on('close', (code) => {
      if (code === 0) {
        res.json({
          success: true,
          message: `Script ${script} completed successfully`,
          output: output.trim(),
        });
      } else {
        res.json({
          success: false,
          error: `Script ${script} failed with code ${code}`,
          output: errorOutput.trim() || output.trim(),
        });
      }
    });

    scriptProcess.on('error', (error) => {
      res.status(500).json({
        success: false,
        error: `Failed to run script: ${error.message}`,
      });
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: `Server error: ${error.message}`,
    });
  }
});

// =====================================================
// Debug / DB helpers
// =====================================================

app.get('/api/db-test', async (_req, res) => {
  try {
    const collections = await mongoose.connection.db.listCollections().toArray();
    const dbStats = await mongoose.connection.db.stats();
    res.json({
      connected: mongoose.connection.readyState === 1,
      database: mongoose.connection.name,
      collections: collections.map((c) => c.name),
      stats: dbStats,
    });
  } catch (error) {
    res.status(500).json({ error: error.message, stack: error.stack });
  }
});

app.post('/api/cleanup', async (_req, res) => {
  try {
    await mongoose.connection.collection('conversation_history').deleteMany({});
    console.log('[platform] Database cleanup completed');
    res.json({
      success: true,
      message: 'All collections cleared',
      timestamp: new Date(),
    });
  } catch (error) {
    console.error('[platform] Cleanup error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/debug/db-state', async (_req, res) => {
  try {
    res.json({
      connection: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
      collections: await mongoose.connection.db.listCollections().toArray(),
      jokeCount: await Joke.countDocuments(),
      recentJokes: await Joke.find().sort({ dateCreated: -1 }).limit(5),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/debug/jokes', async (_req, res) => {
  try {
    const collection = mongoose.connection.collection('my_jokes');
    const allJokes = await collection.find({}).toArray();
    res.json({
      success: true,
      count: allJokes.length,
      jokes: allJokes,
    });
  } catch (error) {
    console.error('[platform] Error fetching all jokes:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/debug/add-test-joke', async (req, res) => {
  try {
    const testJoke = new Joke({
      title: 'Test Joke',
      content:
        "Why did the programmer quit his job? Because he didn't get arrays!",
      userId: req.query.userId || 'test-user',
      dateCreated: new Date(),
    });
    await testJoke.save();
    res.json({ success: true, joke: testJoke });
  } catch (error) {
    console.error('[platform] Error adding test joke:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.use((_req, res) => {
  res.status(404).json({ ok: false, error: 'Not found' });
});

async function connectMongo() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error(
      'MONGODB_URI is not set (expected in backend/server/.env or platform-service/.env)',
    );
  }
  const mongoUri = await resolveMongoUri(uri);
  await mongoose.connect(mongoUri, {
    serverSelectionTimeoutMS: 30000,
    socketTimeoutMS: 45000,
    maxPoolSize: 10,
    minPoolSize: 1,
  });
  console.log('[platform-service] MongoDB connected:', {
    host: mongoose.connection.host || 'Atlas',
    name: mongoose.connection.name,
  });
}

async function main() {
  await connectMongo();
  app.listen(PORT, () => {
    console.log(`[platform-service] listening on http://localhost:${PORT}`);
    console.log(
      '[platform-service] mount /api/datetime, /api/events, /api/logs, /api/quota, /api/debug, /api/db-test, /api/cleanup',
    );
  });
}

main().catch((err) => {
  console.error('[platform-service] failed to start:', err);
  process.exit(1);
});

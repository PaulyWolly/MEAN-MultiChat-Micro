/**
 * Chat microservice — peel from the Express monolith.
 * Gateway: /api/chat + /api/claude + /api/conversations → this process :4804
 */
const path = require('path');
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const { resolveMongoUri } = require('./mongoDnsFallback');
const { logAiLimits } = require('./lib/aiLimits');
const chatRoutes = require('./routes/chat.routes');
const claudeRoutes = require('./routes/claude.routes');
const chatHistoryRoutes = require('./routes/chatHistory.routes');

// Load monolith .env first (shared secrets), then local overrides (PORT/CORS).
require('dotenv').config({ path: path.join(__dirname, '../../server/.env') });
require('dotenv').config({ path: path.join(__dirname, '.env'), override: true });

const PORT = Number(process.env.PORT) || 4804;
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:4200';

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
    service: 'chat-service',
    port: PORT,
    mongoReadyState: mongoose.connection.readyState,
  });
});

app.use('/api/chat', chatRoutes);
app.use('/api/claude', claudeRoutes);
app.use('/api/conversations', chatHistoryRoutes);

app.use((_req, res) => {
  res.status(404).json({ ok: false, error: 'Not found' });
});

async function connectMongo() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI is not set (expected in backend/server/.env or chat-service/.env)');
  }
  const mongoUri = await resolveMongoUri(uri);
  await mongoose.connect(mongoUri, {
    serverSelectionTimeoutMS: 30000,
    socketTimeoutMS: 45000,
    maxPoolSize: 10,
    minPoolSize: 1,
  });
  console.log('[chat-service] MongoDB connected:', {
    host: mongoose.connection.host || 'Atlas',
    name: mongoose.connection.name,
  });
}

async function main() {
  logAiLimits((...args) => console.log('[chat-service]', ...args));
  await connectMongo();
  app.listen(PORT, () => {
    console.log(`[chat-service] listening on http://localhost:${PORT}`);
    console.log(`[chat-service] mount /api/chat, /api/claude, /api/conversations`);
  });
}

main().catch((err) => {
  console.error('[chat-service] failed to start:', err);
  process.exit(1);
});

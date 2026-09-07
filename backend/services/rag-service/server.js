/**
 * RAG microservice — Phase 2 peel from the Express monolith.
 * Public path stays /api/rag via the gateway (port 4800 → this process :4802).
 */
const path = require('path');
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const { resolveMongoUri } = require('./mongoDnsFallback');
const { authenticateToken } = require('./middleware/auth');
const { logAiLimits } = require('./lib/aiLimits');
const ragRoutes = require('./routes/rag.routes');

// Load monolith .env first (shared secrets), then local overrides.
require('dotenv').config({ path: path.join(__dirname, '../../server/.env') });
require('dotenv').config({ path: path.join(__dirname, '.env') });

const PORT = Number(process.env.PORT) || 4802;
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:4200';

const app = express();
app.disable('x-powered-by');

app.use(
  cors({
    origin: CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean),
    credentials: true,
  }),
);

// JSON bodies for /ask (multipart uploads are handled by multer on the route).
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
    service: 'rag-service',
    port: PORT,
    mongoReadyState: mongoose.connection.readyState,
  });
});

app.use('/api/rag', authenticateToken, ragRoutes);

app.use((_req, res) => {
  res.status(404).json({ ok: false, error: 'Not found' });
});

async function connectMongo() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI is not set (expected in backend/server/.env or rag-service/.env)');
  }
  const mongoUri = await resolveMongoUri(uri);
  await mongoose.connect(mongoUri, {
    serverSelectionTimeoutMS: 30000,
    socketTimeoutMS: 45000,
    maxPoolSize: 10,
    minPoolSize: 1,
  });
  console.log('[rag-service] MongoDB connected:', {
    host: mongoose.connection.host || 'Atlas',
    name: mongoose.connection.name,
  });
}

async function main() {
  logAiLimits((...args) => console.log('[rag-service]', ...args));
  await connectMongo();
  app.listen(PORT, () => {
    console.log(`[rag-service] listening on http://localhost:${PORT}`);
    console.log(`[rag-service] mount /api/rag (JWT required)`);
  });
}

main().catch((err) => {
  console.error('[rag-service] failed to start:', err);
  process.exit(1);
});

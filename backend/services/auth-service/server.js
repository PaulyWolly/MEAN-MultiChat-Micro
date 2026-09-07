/**
 * Auth microservice — peel from the Express monolith.
 * Gateway: /api/auth + /api/users → this process :4801
 */
const path = require('path');
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const { resolveMongoUri } = require('./mongoDnsFallback');
const authRoutes = require('./routes/auth.routes');
const usersRoutes = require('./routes/users.routes');

// Load monolith .env first (shared secrets), then local overrides (PORT/CORS).
require('dotenv').config({ path: path.join(__dirname, '../../server/.env') });
require('dotenv').config({ path: path.join(__dirname, '.env'), override: true });

const PORT = Number(process.env.PORT) || 4801;
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
    service: 'auth-service',
    port: PORT,
    mongoReadyState: mongoose.connection.readyState,
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/users', usersRoutes);

app.use((_req, res) => {
  res.status(404).json({ ok: false, error: 'Not found' });
});

async function connectMongo() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI is not set (expected in backend/server/.env or auth-service/.env)');
  }
  const mongoUri = await resolveMongoUri(uri);
  await mongoose.connect(mongoUri, {
    serverSelectionTimeoutMS: 30000,
    socketTimeoutMS: 45000,
    maxPoolSize: 10,
    minPoolSize: 1,
  });
  console.log('[auth-service] MongoDB connected:', {
    host: mongoose.connection.host || 'Atlas',
    name: mongoose.connection.name,
  });
}

async function main() {
  await connectMongo();
  app.listen(PORT, () => {
    console.log(`[auth-service] listening on http://localhost:${PORT}`);
    console.log(`[auth-service] mount /api/auth, /api/users`);
  });
}

main().catch((err) => {
  console.error('[auth-service] failed to start:', err);
  process.exit(1);
});

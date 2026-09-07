/**
 * Jokes microservice — user joke library peel from the Express monolith.
 * Gateway: /api/jokes → this process :4807
 * Recipes live in recipes-service (:4808) — do not mount them here.
 */
const path = require('path');
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

require('dotenv').config({ path: path.join(__dirname, '../../server/.env') });
require('dotenv').config({ path: path.join(__dirname, '.env'), override: true });

const { resolveMongoUri } = require('./mongoDnsFallback');
const jokesRoutes = require('./routes/jokes.routes');

const PORT = Number(process.env.PORT) || 4807;
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:4200';

const app = express();
app.disable('x-powered-by');

app.use(
  cors({
    origin: CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean),
    credentials: true,
  }),
);

app.use(express.json({ limit: '1mb' }));

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
    service: 'jokes-service',
    port: PORT,
    mongoReadyState: mongoose.connection.readyState,
  });
});

app.use('/api/jokes', jokesRoutes);

app.use((_req, res) => {
  res.status(404).json({ ok: false, error: 'Not found' });
});

async function connectMongo() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI is not set (expected in backend/server/.env or jokes-service/.env)');
  }
  const mongoUri = await resolveMongoUri(uri);
  await mongoose.connect(mongoUri, {
    serverSelectionTimeoutMS: 30000,
    socketTimeoutMS: 45000,
    maxPoolSize: 10,
    minPoolSize: 1,
  });
  console.log('[jokes-service] MongoDB connected:', {
    host: mongoose.connection.host || 'Atlas',
    name: mongoose.connection.name,
  });
}

async function main() {
  await connectMongo();
  app.listen(PORT, () => {
    console.log(`[jokes-service] listening on http://localhost:${PORT}`);
    console.log(`[jokes-service] mount /api/jokes`);
  });
}

main().catch((err) => {
  console.error('[jokes-service] failed to start:', err);
  process.exit(1);
});

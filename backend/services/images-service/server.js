/**
 * Images microservice — peel from the Express monolith.
 * Gateway: /api/images + /api/analyze-image → this process :4803
 * (image-search stays on the monolith for now.)
 */
const path = require('path');
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const { resolveMongoUri } = require('./mongoDnsFallback');
const { logAiLimits } = require('./lib/aiLimits');
const imagesRoutes = require('./routes/images.routes');
const analyzeImageRoutes = require('./routes/analyze-image.routes');

require('dotenv').config({ path: path.join(__dirname, '../../server/.env') });
require('dotenv').config({ path: path.join(__dirname, '.env') });

const PORT = Number(process.env.PORT) || 4803;
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:4200';

// Analyze uploads base64 data URLs; keep headroom above AI_IMAGE_MAX_UPLOAD_MB
// (a 10MB file becomes ~13MB+ as a data URL in JSON).
const JSON_LIMIT = process.env.IMAGES_JSON_LIMIT || '25mb';

const app = express();
app.disable('x-powered-by');

app.use(
  cors({
    origin: CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean),
    credentials: true,
  }),
);

app.use(express.json({ limit: JSON_LIMIT }));

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
    service: 'images-service',
    port: PORT,
    mongoReadyState: mongoose.connection.readyState,
  });
});

// /generate auth is inside the router; /models stays public.
app.use('/api/images', imagesRoutes);
app.use('/api/analyze-image', analyzeImageRoutes);

app.use((_req, res) => {
  res.status(404).json({ ok: false, error: 'Not found' });
});

// Prefer JSON over Express HTML for oversized analyze payloads.
app.use((err, _req, res, next) => {
  if (err?.type === 'entity.too.large' || err?.status === 413) {
    return res.status(413).json({
      error: 'Image payload is too large for analysis. Try a smaller photo.',
      details: err.message,
    });
  }
  return next(err);
});

async function connectMongo() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI is not set (expected in backend/server/.env or images-service/.env)');
  }
  const mongoUri = await resolveMongoUri(uri);
  await mongoose.connect(mongoUri, {
    serverSelectionTimeoutMS: 30000,
    socketTimeoutMS: 45000,
    maxPoolSize: 10,
    minPoolSize: 1,
  });
  console.log('[images-service] MongoDB connected:', {
    host: mongoose.connection.host || 'Atlas',
    name: mongoose.connection.name,
  });
}

async function main() {
  logAiLimits((...args) => console.log('[images-service]', ...args));
  await connectMongo();
  app.listen(PORT, () => {
    console.log(`[images-service] listening on http://localhost:${PORT}`);
    console.log(`[images-service] mount /api/images, /api/analyze-image`);
  });
}

main().catch((err) => {
  console.error('[images-service] failed to start:', err);
  process.exit(1);
});

/**
 * Media microservice — YouTube + playlists + image-search peel from the Express monolith.
 * Gateway: /api/youtube + /api/playlists + /api/image-search + /api/image-proxy → :4805
 */
const path = require('path');
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

// Load monolith .env first (shared secrets), then local overrides (PORT/CORS).
// Must run before youtube.routes (it reads GOOGLE_API_KEY at require time).
require('dotenv').config({ path: path.join(__dirname, '../../server/.env') });
require('dotenv').config({ path: path.join(__dirname, '.env'), override: true });

const { resolveMongoUri } = require('./mongoDnsFallback');
const playlistRoutes = require('./routes/playlists.routes');
const youtubeHistoryRoutes = require('./routes/youtubeHistory.routes');
const youtubeRoutes = require('./routes/youtube.routes');
const imageSearchRoutes = require('./routes/image-search.routes');

const PORT = Number(process.env.PORT) || 4805;
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:4200';

const app = express();
app.disable('x-powered-by');

app.use(
  cors({
    origin: CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean),
    credentials: true,
  }),
);

app.use(express.json({ limit: '10mb' }));

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
    service: 'media-service',
    port: PORT,
    mongoReadyState: mongoose.connection.readyState,
  });
});

app.use('/api/playlists', playlistRoutes);
app.use('/api/youtube/history', youtubeHistoryRoutes);
app.use('/api/youtube', youtubeRoutes);
app.use('/api', imageSearchRoutes);

app.use((_req, res) => {
  res.status(404).json({ ok: false, error: 'Not found' });
});

async function connectMongo() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI is not set (expected in backend/server/.env or media-service/.env)');
  }
  const mongoUri = await resolveMongoUri(uri);
  await mongoose.connect(mongoUri, {
    serverSelectionTimeoutMS: 30000,
    socketTimeoutMS: 45000,
    maxPoolSize: 10,
    minPoolSize: 1,
  });
  console.log('[media-service] MongoDB connected:', {
    host: mongoose.connection.host || 'Atlas',
    name: mongoose.connection.name,
  });
}

async function main() {
  await connectMongo();
  app.listen(PORT, () => {
    console.log(`[media-service] listening on http://localhost:${PORT}`);
    console.log(`[media-service] mount /api/playlists, /api/youtube, /api/image-search, /api/image-proxy`);
  });
}

main().catch((err) => {
  console.error('[media-service] failed to start:', err);
  process.exit(1);
});

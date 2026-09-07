/**
 * Recipes microservice — recipe parse peel from the Express monolith.
 * Gateway: /api/recipe → this process :4808
 * Jokes live in jokes-service (:4807) — do not mount them here.
 * No Mongo / OpenAI — pure text formatting of AI chat output.
 */
const path = require('path');
const express = require('express');
const cors = require('cors');

require('dotenv').config({ path: path.join(__dirname, '../../server/.env') });
require('dotenv').config({ path: path.join(__dirname, '.env'), override: true });

const recipeRoutes = require('./routes/recipe.routes');

const PORT = Number(process.env.PORT) || 4808;
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
    service: 'recipes-service',
    port: PORT,
  });
});

app.use('/api/recipe', recipeRoutes);

app.use((_req, res) => {
  res.status(404).json({ ok: false, error: 'Not found' });
});

app.listen(PORT, () => {
  console.log(`[recipes-service] listening on http://localhost:${PORT}`);
  console.log(`[recipes-service] mount /api/recipe`);
});

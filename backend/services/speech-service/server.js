/**
 * Speech microservice — Azure TTS + STT + voices.
 * Gateway: /api/tts + /api/stt + /api/voices → this process :4806
 * No Mongo — secrets from backend/server/.env.
 */
require('../../loadEnv')(require('dotenv'), __dirname);
const express = require('express');
const cors = require('cors');
const { logAiLimits } = require('./lib/aiLimits');
const { keepHostWarm } = require('./lib/upstreamAgent');
const voicesRoutes = require('./routes/voices.routes');
const ttsRoutes = require('./routes/tts.routes');
const sttRoutes = require('./routes/stt.routes');

const PORT = Number(process.env.PORT) || 4806;
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
    service: 'speech-service',
    port: PORT,
    speechRegion: process.env.SPEECH_REGION || null,
    speechKeyPresent: Boolean(process.env.SPEECH_API_KEY),
  });
});

app.use('/api/voices', voicesRoutes);
app.use('/api/tts', ttsRoutes);
app.use('/api/stt', sttRoutes);

app.use((_req, res) => {
  res.status(404).json({ ok: false, error: 'Not found' });
});

function main() {
  logAiLimits((...args) => console.log('[speech-service]', ...args));
  if (process.env.SPEECH_REGION) {
    keepHostWarm(`${process.env.SPEECH_REGION}.tts.speech.microsoft.com`);
    keepHostWarm(`${process.env.SPEECH_REGION}.stt.speech.microsoft.com`);
  }
  app.listen(PORT, () => {
    console.log(`[speech-service] listening on http://localhost:${PORT}`);
    console.log(`[speech-service] mount /api/tts, /api/stt, /api/voices`);
  });
}

main();

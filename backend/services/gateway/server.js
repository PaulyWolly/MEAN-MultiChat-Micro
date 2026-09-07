/**
 * Phase 1–5 strangler gateway (backend/services).
 * Angular → :4800 → auth / rag / images / chat / media / speech /
 *                 jokes / recipes / profile / usage / platform peels
 *                 → /api/* → monolith :4810 (stub leftover)
 */
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { createProxyMiddleware } = require('http-proxy-middleware');

require('dotenv').config({ path: path.join(__dirname, '.env') });

const PORT = Number(process.env.PORT) || 4800;
const MONOLITH_URL = (process.env.MONOLITH_URL || 'http://localhost:4810').replace(/\/$/, '');
const AUTH_URL = (process.env.AUTH_URL || 'http://localhost:4801').replace(/\/$/, '');
const RAG_URL = (process.env.RAG_URL || 'http://localhost:4802').replace(/\/$/, '');
const IMAGES_URL = (process.env.IMAGES_URL || 'http://localhost:4803').replace(/\/$/, '');
const CHAT_URL = (process.env.CHAT_URL || 'http://localhost:4804').replace(/\/$/, '');
const MEDIA_URL = (process.env.MEDIA_URL || 'http://localhost:4805').replace(/\/$/, '');
const SPEECH_URL = (process.env.SPEECH_URL || 'http://localhost:4806').replace(/\/$/, '');
const JOKES_URL = (process.env.JOKES_URL || 'http://localhost:4807').replace(/\/$/, '');
const RECIPES_URL = (process.env.RECIPES_URL || 'http://localhost:4808').replace(/\/$/, '');
const PROFILE_URL = (process.env.PROFILE_URL || 'http://localhost:4809').replace(/\/$/, '');
const USAGE_URL = (process.env.USAGE_URL || 'http://localhost:4811').replace(/\/$/, '');
const PLATFORM_URL = (process.env.PLATFORM_URL || 'http://localhost:4812').replace(/\/$/, '');
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:4200';
const PROXY_TIMEOUT_MS = Number(process.env.PROXY_TIMEOUT_MS) || 5 * 60 * 1000;

const app = express();
app.disable('x-powered-by');

app.use(
  cors({
    origin: CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean),
    credentials: true,
  }),
);

app.use((req, res, next) => {
  const incoming = req.headers['x-request-id'];
  const requestId =
    typeof incoming === 'string' && incoming.trim()
      ? incoming.trim()
      : crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);
  next();
});

app.get('/healthz', (_req, res) => {
  res.json({
    ok: true,
    service: 'gateway',
    upstream: {
      monolith: MONOLITH_URL,
      auth: AUTH_URL,
      rag: RAG_URL,
      images: IMAGES_URL,
      chat: CHAT_URL,
      media: MEDIA_URL,
      speech: SPEECH_URL,
      jokes: JOKES_URL,
      recipes: RECIPES_URL,
      profile: PROFILE_URL,
      usage: USAGE_URL,
      platform: PLATFORM_URL,
    },
    port: PORT,
  });
});

/**
 * Classic MultiChat SSE heartbeat lives on the gateway (quiet edge process)
 * so the ♡/❤️/💗 \r animation stays the most recent terminal line.
 * POST /api/chat still proxies to chat-service.
 */
app.get('/api/chat', (req, res) => {
  let isConnected = false;
  let connectionAttempts = 0;
  const maxAttempts = 5;

  console.log('\n━━━━━━━━━━━ SSE Connection Request ━━━━━━━━━━━');
  console.log('Time:', new Date().toLocaleTimeString());
  console.log('Client:', req.headers['user-agent']);
  console.log('Session:', req.query.sessionId);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  res.write(`data: ${JSON.stringify({ type: 'connection', status: 'established' })}\n\n`);
  isConnected = true;

  let heartPhase = 0;
  const heartbeatInterval = setInterval(() => {
    if (!isConnected) {
      console.log('Attempting to restore connection...');
      connectionAttempts++;
      if (connectionAttempts > maxAttempts) {
        console.log('Max reconnection attempts reached');
        clearInterval(heartbeatInterval);
        return;
      }
    }

    const hearts = ['♡', '❤️', '💗'];
    const heart = hearts[heartPhase];
    process.stdout.write(`\r\u001b[?25l`);
    process.stdout.write(
      `💓 Heartbeat ${new Date().toLocaleTimeString()} ${heart}                \u001b[?25l`,
    );
    heartPhase = (heartPhase + 1) % 3;

    try {
      res.write(`data: ${JSON.stringify({ type: 'heartbeat' })}\n\n`);
      isConnected = true;
      connectionAttempts = 0;
    } catch (error) {
      console.log('Heartbeat error:', error.message);
      isConnected = false;
    }
  }, 500);

  req.on('close', () => {
    process.stdout.write(`\u001b[?25h`);
    process.stdout.write('\n');
    console.log('\n━━━━━━━━━━━ SSE Connection Closed ━━━━━━━━━━━');
    console.log('Time:', new Date().toLocaleTimeString());
    console.log('Session:', req.query.sessionId);
    console.log('Final connection state:');
    console.log(JSON.stringify({ isConnected, attempts: connectionAttempts }, null, 4));
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    clearInterval(heartbeatInterval);
  });
});

function proxyOpts(target, extra = {}) {
  return {
    target,
    changeOrigin: true,
    selfHandleResponse: false,
    proxyTimeout: PROXY_TIMEOUT_MS,
    timeout: PROXY_TIMEOUT_MS,
    ...extra,
    on: {
      proxyReq(proxyReq, req) {
        if (req.requestId) {
          proxyReq.setHeader('x-request-id', req.requestId);
        }
      },
      error(err, req, res) {
        console.error('[gateway] proxy error', {
          requestId: req.requestId,
          url: req.url,
          target,
          message: err.message,
        });
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
        }
        res.end(
          JSON.stringify({
            ok: false,
            error: 'Bad gateway',
            message: err.message,
            upstream: target,
            requestId: req.requestId,
          }),
        );
      },
    },
  };
}

function prefixFilter(...prefixes) {
  return (pathname) =>
    prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

app.use(
  createProxyMiddleware({
    ...proxyOpts(AUTH_URL),
    pathFilter: prefixFilter('/api/auth', '/api/users'),
  }),
);

app.use(
  createProxyMiddleware({
    ...proxyOpts(RAG_URL),
    pathFilter: '/api/rag',
  }),
);

app.use(
  createProxyMiddleware({
    ...proxyOpts(IMAGES_URL),
    pathFilter: prefixFilter('/api/analyze-image', '/api/images'),
  }),
);

app.use(
  createProxyMiddleware({
    ...proxyOpts(CHAT_URL),
    // GET /api/chat is the gateway heartbeat above; proxy everything else.
    pathFilter: (pathname, req) => {
      if (pathname === '/api/claude' || pathname.startsWith('/api/claude/')) return true;
      if (pathname === '/api/conversations' || pathname.startsWith('/api/conversations/')) {
        return true;
      }
      if (pathname === '/api/chat' || pathname.startsWith('/api/chat/')) {
        return !(req.method === 'GET' && (pathname === '/api/chat' || pathname === '/api/chat/'));
      }
      return false;
    },
  }),
);

app.use(
  createProxyMiddleware({
    ...proxyOpts(MEDIA_URL),
    pathFilter: prefixFilter(
      '/api/youtube',
      '/api/playlists',
      '/api/image-search',
      '/api/google-image-search',
      '/api/image-proxy',
    ),
  }),
);

app.use(
  createProxyMiddleware({
    ...proxyOpts(SPEECH_URL),
    pathFilter: prefixFilter('/api/tts', '/api/voices'),
  }),
);

app.use(
  createProxyMiddleware({
    ...proxyOpts(JOKES_URL),
    pathFilter: '/api/jokes',
  }),
);

app.use(
  createProxyMiddleware({
    ...proxyOpts(RECIPES_URL),
    pathFilter: '/api/recipe',
  }),
);

app.use(
  createProxyMiddleware({
    ...proxyOpts(PROFILE_URL),
    pathFilter: '/api/personal-info',
  }),
);

app.use(
  createProxyMiddleware({
    ...proxyOpts(USAGE_URL),
    pathFilter: '/api/ai',
  }),
);

app.use(
  createProxyMiddleware({
    ...proxyOpts(PLATFORM_URL),
    pathFilter: prefixFilter(
      '/api/datetime',
      '/api/events',
      '/api/logs',
      '/api/quota',
      '/api/debug',
      '/api/db-test',
      '/api/cleanup',
    ),
  }),
);

app.use(
  createProxyMiddleware({
    ...proxyOpts(MONOLITH_URL),
    pathFilter: '/api',
  }),
);

app.use((_req, res) => {
  res.status(404).json({ ok: false, error: 'Not found' });
});

app.listen(PORT, () => {
  console.log(`[gateway] listening on http://localhost:${PORT}`);
  console.log(`[gateway] /api/auth, /api/users → ${AUTH_URL}`);
  console.log(`[gateway] /api/rag → ${RAG_URL}`);
  console.log(`[gateway] /api/images, /api/analyze-image → ${IMAGES_URL}`);
  console.log(`[gateway] GET /api/chat → local ♡ heartbeat; POST /api/chat + claude/conversations → ${CHAT_URL}`);
  console.log(`[gateway] /api/youtube, /api/playlists, /api/image-search → ${MEDIA_URL}`);
  console.log(`[gateway] /api/tts, /api/voices → ${SPEECH_URL}`);
  console.log(`[gateway] /api/jokes → ${JOKES_URL}`);
  console.log(`[gateway] /api/recipe → ${RECIPES_URL}`);
  console.log(`[gateway] /api/personal-info → ${PROFILE_URL}`);
  console.log(`[gateway] /api/ai → ${USAGE_URL}`);
  console.log(`[gateway] /api/datetime, /api/events, /api/logs, … → ${PLATFORM_URL}`);
  console.log(`[gateway] /api/*   → ${MONOLITH_URL}`);
  console.log(`[gateway] CORS origin: ${CORS_ORIGIN}`);
});

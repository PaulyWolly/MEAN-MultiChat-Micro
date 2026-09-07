# Add MultiChat terminal heartbeat

Port this into any MultiChat instance so the server terminal shows the classic in-place animation:

```text
💓 Heartbeat 9:14:02 AM ♡
💓 Heartbeat 9:14:02 AM ❤️
💓 Heartbeat 9:14:03 AM 💗
```

**What it means:** the browser has an open `GET /api/chat` SSE connection. The heart is a **liveness** signal (“the pipe is open”), not a chat request log. It redraws one line with `\r` and does not rewrite other service logs.

Reference implementation: this repo (`MEAN-MultiChat-Micro`), commit that restored gateway heartbeat.

---

## Mental model (two halves)

| Half | Role |
|------|------|
| **Server** | `GET /api/chat` opens SSE, writes heartbeat events to the client, and animates stdout with `\r` |
| **Client** | Keeps an `EventSource` open to that URL for the life of the SPA |

If either half is missing, you will not see the heart.

Chat **POST** (`POST /api/chat`) is unrelated — keep streaming chat as-is.

---

## Choose where the heartbeat lives

### A) Monolith / single Express server (classic)

Put `app.get('/api/chat', …)` on the main API process (the same process you watch in the terminal).

Typical layout:

- `backend/server/server.js` → `app.get('/api/chat', …)` next to `app.post('/api/chat', …)`
- Angular proxies `/api` → that server (e.g. `:3000` / `:4810`)

This is how `MEAN-MultiChat` works.

### B) Gateway + microservices (this repo)

Put heartbeat on the **quiet edge** process (gateway), not on a chatty peel:

- `GET /api/chat` → **gateway** (local SSE + `\r` animation)
- `POST /api/chat` (+ `/api/claude`, `/api/conversations`) → **chat-service**

Otherwise the animation is buried under `[profile]` / `[speech]` / etc., or `\r` fights concurrently prefixes.

If a peel still has `GET /api/chat` for direct curls on `:4804`, that is optional; the browser should hit the gateway.

---

## 1) Server: SSE + `\r` animation

Copy this handler onto the process whose terminal you watch (monolith **or** gateway).

```js
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
```

### Microservices gateway routing note

Register the `app.get('/api/chat', …)` **before** the chat proxy. Exclude that GET from the proxy:

```js
pathFilter: (pathname, req) => {
  if (pathname === '/api/claude' || pathname.startsWith('/api/claude/')) return true;
  if (pathname === '/api/conversations' || pathname.startsWith('/api/conversations/')) {
    return true;
  }
  if (pathname === '/api/chat' || pathname.startsWith('/api/chat/')) {
    // Local heartbeat handles GET /api/chat; proxy POST (and subpaths) to chat-service.
    return !(req.method === 'GET' && (pathname === '/api/chat' || pathname === '/api/chat/'));
  }
  return false;
},
```

Files in this repo:

- `backend/services/gateway/server.js` — heartbeat + path filter
- `backend/services/chat-service/routes/chat.routes.js` — optional direct `:4804` GET (same animation)

---

## 2) Angular: keep EventSource open

Chat UIs often only **POST** to `/api/chat`. Without a long-lived GET, the server never starts the heart.

### Add `src/app/services/chat-heartbeat.service.ts`

Adapt imports (`environment`, session id helper) to the target app.

```ts
import { Injectable, OnDestroy } from '@angular/core';
import { environment } from '../../environments/environment';
import { getActiveDataKey } from '../components/login/auth-storage';

/**
 * Opens GET /api/chat SSE so the server prints the ♡ / ❤️ / 💗 heartbeat.
 * Without this, the GET route never runs.
 */
@Injectable({ providedIn: 'root' })
export class ChatHeartbeatService implements OnDestroy {
  private source: EventSource | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.source?.close();
    this.source = null;
  }

  ngOnDestroy() {
    this.stop();
  }

  private connect() {
    if (this.stopped || typeof EventSource === 'undefined') return;
    this.source?.close();

    const base = String(environment.apiBase || '').replace(/\/$/, '');
    const sessionId = encodeURIComponent(getActiveDataKey() || 'anonymous');
    const url = `${base}/api/chat?sessionId=${sessionId}`;

    try {
      const es = new EventSource(url);
      this.source = es;
      es.onerror = () => {
        es.close();
        if (this.source === es) this.source = null;
        if (this.stopped) return;
        this.reconnectTimer = setTimeout(() => this.connect(), 4000);
      };
    } catch {
      if (!this.stopped) {
        this.reconnectTimer = setTimeout(() => this.connect(), 4000);
      }
    }
  }
}
```

### Start it once at app bootstrap

In root `App` / `AppComponent` constructor (or `APP_INITIALIZER`):

```ts
private readonly chatHeartbeat = inject(ChatHeartbeatService);

constructor() {
  this.chatHeartbeat.start();
  // …
}
```

### Session id helper

Any stable string is fine for logs (`anonymous` works). Prefer the same data-key / session helper the rest of the app uses so “SSE Connection Request” lines are useful.

---

## 3) Dev proxy (Angular → API)

For SSE through `ng serve`, keep the proxy from buffering/closing early:

```json
{
  "/api": {
    "target": "http://localhost:4800",
    "secure": false,
    "changeOrigin": true,
    "headers": {
      "Connection": "keep-alive"
    },
    "timeout": 0
  }
}
```

Point `target` at your monolith port or gateway port. If `environment.apiBase` is already an absolute API URL, EventSource bypasses the Angular proxy — ensure CORS allows the SPA origin.

---

## Port checklist (per MultiChat instance)

1. [ ] Confirm whether the app is **monolith** or **gateway + peels**.
2. [ ] Add `GET /api/chat` SSE + `\r` animation on the process you watch in the terminal.
3. [ ] If microservices: exclude that GET from the chat proxy; leave POST on chat-service.
4. [ ] Add `ChatHeartbeatService` (or equivalent) and call `start()` at app boot.
5. [ ] Ensure `EventSource` URL matches how the app calls the API (`apiBase` + `/api/chat`).
6. [ ] Tune `proxy.conf.json` for SSE if using `ng serve` proxy.
7. [ ] Restart the API process (plain `node` does not hot-reload) and hard-refresh the browser.
8. [ ] Smoke-test without the UI:

   ```bash
   curl -sN -m 3 "http://localhost:<API_PORT>/api/chat?sessionId=probe"
   ```

   You should see SSE `data:` lines and the terminal heart animation.

---

## Troubleshooting

| Symptom | Likely cause |
|---------|----------------|
| No heart at all | Browser never opens GET (missing client service), or API process not restarted |
| Heart only with `curl`, not in UI | Wrong URL / `apiBase`, proxy timeout, or CORS if calling API host directly |
| Heart buried / not “last line” | Animation on a chatty microservice; move GET to gateway/monolith |
| `\r` looks broken under `concurrently` | Many processes interleave; still prefer quiet process + `\r` over `console.log` spam |
| “SSE Connection Closed” looping | Proxy/timeout killing the stream; set proxy `timeout: 0`, keep-alive headers |

---

## Do not

- Drive the heart from `POST /api/chat` only — that only runs while a message streams.
- Use `console.log` every tick for the animation in production-like terminals — that floods the log; `\r` is the classic MultiChat UX.
- Put the watched animation on the noisiest peel if you care about it staying the bottom line.

---

## Files to copy from this repo

| File | Purpose |
|------|---------|
| `docs/ADD_HEARTBEAT.md` | This guide |
| `backend/services/gateway/server.js` | Gateway GET + proxy filter (micro) |
| `src/app/services/chat-heartbeat.service.ts` | Angular EventSource keeper |
| `src/app/app.ts` | `chatHeartbeat.start()` at boot |
| `proxy.conf.json` | SSE-friendly proxy |

Classic monolith reference (sibling): `MEAN-MultiChat` → `backend/server/server.js` `app.get('/api/chat', …)`.

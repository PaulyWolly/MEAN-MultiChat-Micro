# MEAN Stack Setup Flow (like MEAN-MultiChat)

This guide walks through the **process flow** and **steps** to set up a MEAN application in the same style as this repo: **MongoDB + Express + Angular + Node**, with a separate API and SPA, local proxy, and Render deployment.

---

## What MEAN means here

| Letter | Technology | Role in this app |
|--------|------------|------------------|
| **M** | **MongoDB** | Stores users, chat history, YouTube searches, jokes, RAG docs, etc. |
| **E** | **Express** | HTTP API (`/api/...`) on Node — auth, chat, TTS, YouTube, images, RAG |
| **A** | **Angular** | Browser UI (routes, components, services) — **no API secrets in the client** |
| **N** | **Node.js** | Runtime for Express (and the tooling that builds/serves Angular) |

```text
┌─────────────────┐         HTTP /api          ┌─────────────────┐
│  Angular SPA    │  ───────────────────────►  │  Express API    │
│  :4200 (local)  │                            │  :4800 (local)  │
│  or Static Site │                            │  or Web Service │
└─────────────────┘                            └────────┬────────┘
                                                        │
                                                        ▼
                                               ┌─────────────────┐
                                               │    MongoDB      │
                                               │  (Atlas / URI)  │
                                               └────────┬────────┘
                                                        │
                                                        ▼
                                               ┌─────────────────┐
                                               │ MongoDB Compass │
                                               │ (you inspect DB)│
                                               └─────────────────┘
```

**Important split:** the browser never holds `OPENAI_API_KEY`, `SPEECH_API_KEY`, or `MONGODB_URI`. Angular calls your Express API; Express talks to MongoDB and third-party APIs. You use **MongoDB Compass** with the same URI to browse collections while developing.

---

## Big-picture process flow

```text
1. Create project skeleton (Angular app + Express API)
2. Connect MongoDB
3. Add Express routes (/api/...)
4. Wire Angular → API (proxy locally, apiBase in production)
5. Add CORS so the deployed SPA can call the API
6. Put secrets in .env (local) / host Environment (Render)
7. Run locally (two processes)
8. Build Angular → static files
9. Deploy API + static site
10. Point Auth0 / CORS / env at production URLs
```

---

## Step-by-step: build one like this

### Step 1 — Prerequisites

- Node.js **20+**
- npm
- A MongoDB Atlas cluster (or local Mongo) and a connection string
- **[MongoDB Compass](https://www.mongodb.com/products/tools/compass)** — GUI to browse collections, run queries, and verify data
- Accounts/keys as needed (OpenAI, Azure Speech, Google YouTube, Auth0, etc.)
- Git + a GitHub repo (for Render deploys)

### Step 2 — Create the folder layout

Mirror this shape:

```text
my-mean-app/
  src/app/                 # Angular UI
    components/            # pages by feature (chat, images, …)
    services/              # API client, auth, toasts
    environments/          # development vs production config
  backend/
    server/
      server.js            # Express entry
      routes/              # /api/... routers
      models/              # Mongoose schemas
      middleware/          # JWT / optionalAuth
      .env.example         # committed template (no secrets)
      .env                 # local secrets (gitignored)
  proxy.conf.json          # local /api → Express
  package.json             # Angular + npm scripts
```

### Step 3 — Scaffold Angular

```bash
npx @angular/cli@20 new my-mean-app --routing --style=css
cd my-mean-app
```

Add feature routes in `app.routes.ts` (chat, login, about, …) and a simple layout (header + router outlet + footer).

### Step 4 — Scaffold Express

Inside `backend/server`:

```bash
npm init -y
npm install express cors dotenv mongoose mongodb jsonwebtoken bcryptjs
npm install -D nodemon
```

Minimal `server.js` flow:

1. Load `.env` with `dotenv`
2. `app.use(cors({ ... }))`
3. `app.use(express.json())`
4. Connect MongoDB (`mongoose` / `MongoClient`)
5. Mount routers: `app.use('/api/...', ...)`
6. `app.listen(process.env.PORT || 4800)`

### Step 5 — Environment secrets

1. Copy `backend/server/.env.example` → `backend/server/.env`
2. Fill values (never commit `.env`)

Typical keys for an app like this:

| Variable | Purpose |
|----------|---------|
| `PORT` | API port (local often `4800`) |
| `MONGODB_URI` | Atlas / Mongo connection (same URI you paste into Compass) |
| `JWT_SECRET` | Sign app login tokens |
| `OPENAI_API_KEY` | Chat / images / embeddings |
| `ANTHROPIC_API_KEY` | Optional Claude + web_search |
| `GOOGLE_API_KEY` | YouTube Data API |
| `SPEECH_API_KEY` / `SPEECH_REGION` | Azure Neural TTS |
| `CORS_ORIGINS` | Deployed frontend URL(s) |
| Auth0 vars | Social login (optional) |

### Step 5b — Connect with MongoDB Compass

Compass is the desktop GUI for the same database Express uses. You do **not** put Compass credentials in Angular — only in Compass and in `MONGODB_URI` for the API.

**Flow**

```text
MongoDB Compass  ←── same MONGODB_URI ──►  Express API  ←── /api ──►  Angular
     (you)                                    (Node)
```

**Steps**

1. Install [MongoDB Compass](https://www.mongodb.com/products/tools/compass) if needed.
2. In Atlas: **Database** → **Connect** → **Compass** → copy the connection string  
   (or use your local `mongodb://127.0.0.1:27017` URI).
3. Paste that URI into Compass’s **New Connection** field and connect.
4. Paste the **same** URI into `backend/server/.env` as `MONGODB_URI=...`.
5. Open the database your app uses (this project often uses a DB name inside the URI, e.g. `Chat_Streaming_Image`).
6. After the API runs and you use a feature (login, chat save, YouTube history), refresh Compass and confirm collections/documents appear.

**Useful Compass checks while building**

| You did in the app | What to look for in Compass |
|--------------------|-----------------------------|
| Signed up / logged in | `users` (or your User collection) |
| Saved a chat | conversation / chat history collection |
| Saved a YouTube search | YouTube search / history collection |
| Uploaded a RAG doc | RAG documents collection |

If Compass connects but the API does not (or the reverse), the URI, DB name, or network IP allow-list in Atlas is usually wrong — fix that before debugging Angular.

### Step 6 — Connect Angular to the API

**Local development**

1. Set `environment.development.ts` → `apiBase: ''` (same origin via proxy)
2. Add `proxy.conf.json`:

```json
{
  "/api": {
    "target": "http://localhost:4800",
    "secure": false,
    "changeOrigin": true
  }
}
```

3. Serve with:

```bash
ng serve --port 4200 --proxy-config proxy.conf.json
```

Browser calls `http://localhost:4200/api/...` → Angular CLI forwards to Express `:4800`.  
That avoids many local CORS headaches.

**Production**

1. Set `environment.production.ts` → `apiBase: 'https://your-api.onrender.com'`
2. Angular `fetch(`${apiBase}/api/...`)` hits the real API host
3. Express must allow that SPA origin via **CORS** (`CORS_ORIGINS`)

### Step 7 — Understand CORS (why it matters)

- Browser only: page on origin A calling API on origin B
- Local proxy often hides CORS; **production does not**
- Express uses `cors` middleware and an allow-list of origins
- Set `CORS_ORIGINS=https://your-static-site.onrender.com` on the API

### Step 8 — Auth flow (optional but used here)

Typical pattern in this app:

1. User signs in (password JWT and/or Auth0 Google)
2. Angular stores a token
3. API client sends `Authorization: Bearer …`
4. Middleware (`authenticateToken` / `optionalAuth`) protects routes
5. Data is scoped per user / guest session

Auth0 checklist:

- SPA application type
- Allowed Callback / Logout / Web Origins for **local** and **deployed** URLs
- Same client id in Angular `environment*.ts` and backend Auth0 env vars

### Step 9 — Feature flow (example: Chat)

```text
User types / speaks in Angular Chat
        │
        ▼
Angular service → POST /api/chat  (or /api/claude/chat)
        │
        ▼
Express validates size / auth, may use live web_search
        │
        ▼
OpenAI / Claude reply (+ usedWebSearch flag)
        │
        ▼
Angular shows markdown (+ "Web" badge if searched)
        │
        ▼
Optional: POST /api/tts → Azure Speech → play audio
        │
        ▼
Optional: save thread → Mongo via /api/conversations
```

Same idea for YouTube, Images, RAG: **UI → `/api/...` → secrets + DB on server**.

### Step 10 — Run both processes locally

From the repo root (after installs):

```bash
npm install
npm --prefix backend/server install
npm run dev          # or: npm run dev:stable
```

- Angular: http://localhost:4200  
- Express: http://localhost:4800  

Restart the **Node** server after changing `server.js` / `.env` if you are not using nodemon (`dev:stable` uses plain `node`).

### Step 11 — Build the Angular SPA

```bash
npm run build
```

Output goes to `dist/...` — static HTML/JS/CSS for a Static Site host.

### Step 12 — Deploy (Render-style, like this project)

Use **two services**:

| Service | What you deploy | Notes |
|---------|-----------------|--------|
| **Web Service** | `backend/` (Docker or `node server.js`) | Env vars from dashboard; Mongo + API keys |
| **Static Site** | Angular `ng build` output | `apiBase` already baked to API URL |

Deploy checklist:

1. Push to GitHub  
2. Create API service → set env from `.env.example` names  
3. Set `CORS_ORIGINS` to the Static Site URL  
4. Build & publish the Angular static site  
5. Update Auth0 allowed URLs for production  
6. Hard-refresh the live site and test login + one `/api` call  

**Do not upload `.env` to Render.** Paste keys into the Environment tab.

---

## Local vs production request path

### Local

```text
Browser (localhost:4200)
  → /api/chat
  → Angular proxy
  → Express (localhost:4800)
  → MongoDB / OpenAI / Azure / …
```

### Production

```text
Browser (static site host)
  → https://api-host/api/chat
  → Express (CORS must allow static site origin)
  → MongoDB / OpenAI / Azure / …
```

---

## Suggested build order for a new app

1. Empty Angular shell + Express `GET /api/health`  
2. Mongo connection + one model  
3. Proxy + Angular service calling `/api/health`  
4. Auth (JWT) before sensitive data  
5. First real feature (e.g. chat)  
6. CORS + production `apiBase`  
7. Deploy API, then static site  
8. Add TTS / YouTube / RAG only after the base loop works  

---

## Common pitfalls

| Symptom | Likely cause |
|---------|----------------|
| CORS error in browser | Production SPA not listed in `CORS_ORIGINS` |
| `/api` 404 on `:4200` | Proxy not configured or wrong path |
| Works locally, fails on Render | Missing env vars on API service |
| Compass connects, API does not | Wrong `MONGODB_URI` in `.env`, or Atlas Network Access missing your IP |
| Empty DB in Compass after app use | Wrong database name in the URI, or feature never hit a save route |
| “API key” leak fear | Never put secrets in Angular `environment*.ts` except public Auth0 client id |
| Code change ignored | API process not restarted (`start` ≠ nodemon) |
| Web answers stale / no badge | Chat path not using live `web_search` (or Claude-only) |

---

## How this repo maps to the flow

| Piece | Location |
|-------|----------|
| Angular UI | `src/app/components/`, `src/app/services/` |
| Routes | `src/app/app.routes.ts` |
| Dev / prod API base | `src/environments/environment*.ts` |
| Local proxy | `proxy.conf.json` |
| Express entry | `backend/server/server.js` |
| Env template | `backend/server/.env.example` |
| Feature routers | `backend/server/routes/` |
| Models | `backend/server/models/` |
| One-command local | `npm run dev` / `npm run dev:stable` |

For day-to-day install commands, also see the root [README.md](../README.md).

---

## One-sentence summary

**Build Angular for the UI, Express for `/api` and secrets, MongoDB for data (browse it with Compass using the same URI), proxy locally, set CORS + `apiBase` for production, keep `.env` out of git, and deploy API and static site as two services.**

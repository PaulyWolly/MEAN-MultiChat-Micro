# Morphing MEAN-MultiChat into Microservices

This guide shows how to evolve **this** Angular + Express + MongoDB app from a **monolith API** into a **microservices** backend — without rewriting Angular from scratch.

**Remember:** Angular stays one SPA. Microservices live on the **server** side under `backend/`. The browser still uses `HttpClient` / Observables / `fetch`; only the URLs (and often a gateway) change.

### Why `backend/services/` (not repo-root `services/`)

Microservices are **backend Node processes** (HTTP APIs, secrets, Mongo, AI keys). They belong next to the monolith leftover:

| Path | Role |
|------|------|
| `src/` | Angular SPA only |
| `backend/server/` | Monolith leftover (`:4810`) — shrinks as you peel |
| `backend/services/*` | Deployable API processes (gateway, rag, …) |
| `backend/config`, `backend/utils` | Shared server assets the monolith (and later packages) use |

Keeping peels under `backend/` makes the boundary obvious: everything that talks to Mongo/OpenAI/Auth0 is server-side; the SPA never imports those packages.

---

## What you have today (monolith)

```text
┌──────────────────┐         /api/*          ┌──────────────────────────────┐
│  Angular SPA     │ ──────────────────────► │  One Express process         │
│  :4200           │                         │  backend/server/server.js    │
└──────────────────┘                         │  + routes/*.js               │
                                             └──────────────┬───────────────┘
                                                            │
                                                            ▼
                                                   ┌────────────────┐
                                                   │  MongoDB      │
                                                   └────────────────┘
```

Already modular (good split candidates):

| Mount / area | Files / routes | Natural service |
|--------------|----------------|-----------------|
| Auth + users | `/api/auth/*`, `/api/users` | **auth-service** |
| Chat (OpenAI) | `/api/chat`, `/api/conversations` | **chat-service** |
| Claude | `/api/claude` | **chat-service** (or claude-service) |
| Images | `/api/images`, `/api/analyze-image`, `/api/image-search` | **images-service** |
| RAG | `/api/rag` | **rag-service** |
| YouTube + playlists | `/api/youtube/*`, `/api/playlists` | **media-service** |
| TTS / voices | `/api/tts`, `/api/voices` | **speech-service** |
| Jokes | `/api/jokes/*` | **jokes-service** |
| Recipes | `/api/recipe` | **recipes-service** |
| Personal info / profile | `/api/personal-info` | **profile-service** |
| AI status / quotas | `/api/ai`, shared `aiLimits` | **usage-service** or shared lib first |

You already extracted several routers (`rag.routes.js`, `images.routes.js`, `claude.routes.js`, …). Microservices = those routers become **separate deployable Node apps**, not just files in one process.

---

## Target shape

```text
┌──────────────────┐
│  Angular SPA     │
│  (unchanged UI)  │
└────────┬─────────┘
         │  still calls /api/...
         ▼
┌──────────────────┐
│  API Gateway     │  ← thin Express (or nginx / Traefik)
│  CORS, JWT check │     routes traffic to services
│  path → service  │
└────────┬─────────┘
         │
    ┌────┼────┬──────┬─────┬───────┬────────┬───────┬─────────┬─────────┐
    ▼    ▼    ▼      ▼     ▼       ▼        ▼       ▼         ▼         ▼
  auth chat images  rag  media  speech  jokes  recipes  profile
    │    │      │      │     │       │        │       │         │         │
    └────┴──────┴──────┴─────┴───────┴────────┴───────┴─────────┴─────────┘
                         │
                    MongoDB Atlas
              (one cluster, many DBs
               or shared DB + collections)
```

Angular barely changes if the **gateway keeps the same paths** (`/api/chat`, `/api/rag`, …).

---

## Golden rule: strangler pattern (do not big-bang rewrite)

Morph **one domain at a time**. Leave everything else on the monolith until each slice is proven.

```text
Phase 0  Document boundaries + shared auth contract
Phase 1  Extract API gateway (same URLs, proxy to monolith)
Phase 2  Peel feature APIs (rag, images, chat, …)
Phase 3  Peel auth into auth-service; others verify JWT
Phase 4  Peel media / speech / jokes / recipes / profile
Phase 5  Shrink or retire the old monolith
```

---

## Phase 0 — Decide boundaries and contracts

### Shared JWT contract (do this first)

Today `authenticateToken` in `backend/server/middleware/auth.js` verifies a JWT and sets `req.user`.

In microservices:

1. **auth-service** issues JWTs on login (`/api/auth/login`, `/api/auth/oauth`, …).
2. Every other service (or the gateway) verifies the same `JWT_SECRET` (or public keys if you later move to asymmetric JWTs).
3. Services trust `req.user.id` / `dataKey` from the token — never from the client body alone for ownership.

Copy (or publish as an npm/workspace package) the auth middleware so services do not drift.

### What Angular must keep sending

Your client already attaches:

```text
Authorization: Bearer <token>
```

(`src/app/services/api/client.ts`)

That stays the same. Microservices do not change the Observable idea — only who answers `/api/...`.

---

## Phase 1 — Introduce a gateway (URLs stay stable)

> **Status:** Feature peels are live: auth, rag, images, chat, media, speech, jokes, recipes, profile (gateway `:4800`, services `:4801`–`:4809`, monolith leftover `:4810`, Angular `:4200`).
> Next leftover on monolith: **AI status / quotas**, **image-search**, datetime/logs/debug.

Create a thin gateway that:

- Owns CORS for the Angular origin
- Forwards `/api/*` to the current monolith (`localhost:4810` → later individual services)
- Optionally runs `optionalAuth` / `authenticateToken` once at the edge

### Run locally (Phase 1)

```bash
npm run dev:micro
# starts: gateway :4800 + monolith :4810 + Angular :4200
```

Useful scripts:

| Script | What it does |
|--------|----------------|
| `npm run start:gateway` | Gateway only (`:4800`) |
| `npm run start:auth` | Auth (`:4801`) |
| `npm run start:rag` | RAG (`:4802`) |
| `npm run start:images` | Images (`:4803`) |
| `npm run start:chat` | Chat (`:4804`) |
| `npm run start:media` | Media / YouTube (`:4805`) |
| `npm run start:speech` | TTS / voices (`:4806`) |
| `npm run start:jokes` | Jokes (`:4807`) |
| `npm run start:recipes` | Recipes (`:4808`) |
| `npm run start:profile` | Profile / personal-info (`:4809`) |
| `npm run start:monolith` | Monolith leftover on **4810** |
| `npm run start:server` | Monolith on **4800** (direct; no gateway — fallback) |
| `npm run dev:stable` | Direct monolith + client (legacy) |
| `npm run dev:micro` | Full micro stack + Angular |

Gateway env: copy `backend/services/gateway/.env.example` → `backend/services/gateway/.env`.

Smoke checks:

```bash
curl http://localhost:4800/healthz
curl http://localhost:4800/api/ai/status
```

Example gateway route map (concept — today everything still goes to monolith):

```js
// backend/services/gateway/server.js
// /api/auth|/api/users → auth-service :4801
// /api/rag             → rag-service :4802
// /api/images          → images-service :4803
// /api/analyze-image   → images-service :4803
// /api/chat|/api/claude|/api/conversations → chat-service :4804
// /api/youtube|/api/playlists → media-service :4805
// /api/*               → monolith :4810
```

**Angular change:** none if `environment.apiBase` / proxy points at the gateway.

Locally you can still use `proxy.conf.json` → gateway → services.

---

## Phase 2 — Extract the first real microservices

> **Status (Phase 2–4 implemented):**
> - `backend/services/rag-service` owns `/api/rag` (`:4802`).
> - `backend/services/images-service` owns `/api/images` + `/api/analyze-image` (`:4803`).
> - `backend/services/chat-service` owns `/api/chat` + `/api/claude` + `/api/conversations` (`:4804`).
> - `backend/services/auth-service` owns `/api/auth` + `/api/users` (`:4801`).
> - `backend/services/media-service` owns `/api/youtube` + `/api/playlists` (`:4805`).
> JWT auth is copied into each peel for now; a shared `backend/packages/auth-middleware`
> can dedupe later. Monolith no longer mounts those paths.
> `/api/image-search` remains on the monolith (not moved with YouTube).

### Best first candidates in *this* repo

| Service | Why first | Status |
|---------|-----------|--------|
| **rag-service** | Isolated router + OpenAI + Mongo collections | **Done** (`:4802`) |
| **images-service** | Router + quotas + OpenAI vision/generate | **Done** (`:4803`) |
| **chat-service** | OpenAI chat SSE + Claude + conversation history | **Done** (`:4804`) |
| **auth-service** | Login/register/oauth + users admin CRUD | **Done** (`:4801`) |
| **media-service** | YouTube + playlists + quota/cache helpers | **Done** (`:4805`) |

### What was done for RAG

1. Folder: `backend/services/rag-service/` (own `package.json`, `server.js`).
2. Routes/models: `routes/rag.routes.js`, `RagDocument`, `RagChunk`, plus `User` + auth middleware for JWT.
3. Loads secrets from `backend/server/.env` (same `MONGODB_URI` / `JWT_SECRET` / `OPENAI_API_KEY`).
4. Listens on **4802**.
5. Gateway: `/api/rag` → rag-service; rest → monolith.
6. Monolith RAG mount removed.

**Success check:** Angular RAG page with JWT login; `curl` without token → `401` via gateway.

### What was done for images

1. Folder: `backend/services/images-service/`.
2. Routes: `images.routes.js` (models + generate + daily quota via `AiUsage`), `analyze-image.routes.js` (SSE vision).
3. Same Mongo + JWT + OpenAI env as the monolith.
4. Listens on **4803**; JSON body limit raised for base64 uploads (`15mb`).
5. Gateway: `/api/images` and `/api/analyze-image` → images-service.
6. Monolith mounts removed (stubs throw if required).

**Success check:** Images page generate (JWT) + analyze; `/api/images/models` public; generate without token → `401`.

### What was done for chat

1. Folder: `backend/services/chat-service/`.
2. Routes: `chat.routes.js` (SSE heartbeat + streaming OpenAI chat), `claude.routes.js`, `chatHistory.routes.js` + `ChatConversation`.
3. Same Mongo + JWT + OpenAI / Anthropic env as the monolith (secrets from `backend/server/.env`).
4. Listens on **4804**.
5. Gateway: `/api/chat`, `/api/claude`, `/api/conversations` → chat-service.
6. Monolith mounts removed (stubs throw if required); datetime helpers stay on the monolith.

**Success check:** `POST /api/chat` with `{"message":"hi"}` returns SSE greeting without auth; conversations still require JWT.

### What was done for auth (Phase 3)

1. Folder: `backend/services/auth-service/`.
2. Routes: `auth.routes.js` (login, register, oauth, verify, …), `users.routes.js` (admin CRUD).
3. Copies `User` model + JWT middleware + Auth0 helpers; secrets from `backend/server/.env`.
4. Listens on **4801**.
5. Gateway: `/api/auth` and `/api/users` → auth-service.
6. Monolith auth/users handlers removed; `middleware/auth.js` kept for remaining routes.

**Success check:** `POST /api/auth/login` with empty body → `400`; gateway `/healthz` lists `upstream.auth`.

### What was done for media (Phase 4)

1. Folder: `backend/services/media-service/`.
2. Routes: `playlists.routes.js`, `youtubeHistory.routes.js`, `youtube.routes.js` (search, saved-searches, quota, cache, resolve-channel, pagetokens, …) + models `Playlist`, `YouTubeSearch`, `PageToken`.
3. Secrets from `backend/server/.env` (`MONGODB_URI`, `JWT_SECRET`, `GOOGLE_API_KEY`); lean local `.env` is `PORT` + `CORS_ORIGIN` only.
4. Listens on **4805**; quota file at `media-service/quota-tracking.json`.
5. Gateway: `/api/youtube` and `/api/playlists` → media-service.
6. Monolith mounts/handlers commented out (stubs throw if required); `/api/image-search` stays on monolith. Helpers are **copied** into media-service (commented duplicates remain in monolith `server.js` until a cleanup pass).

**Success check:** `GET /api/youtube/quota-status` → `200`; `GET /api/youtube/saved-searches` without token → `401`; gateway `/healthz` lists `upstream.media`.

Next peel leftover: **AI status / quotas**, **image-search**, and debug helpers.

### What was done for speech (Phase 4)

1. Folder: `backend/services/speech-service/`.
2. Routes: `tts.routes.js`, `voices.routes.js` (Azure Speech).
3. Secrets from `backend/server/.env` (`SPEECH_API_KEY`, `SPEECH_REGION`); lean local `.env` is `PORT` + `CORS_ORIGIN` only.
4. Listens on **4806**.
5. Gateway: `/api/tts` and `/api/voices` → speech-service.
6. Monolith TTS/voices handlers commented out.

**Success check:** gateway `/healthz` lists `upstream.speech`.

### What was done for jokes / recipes / profile (Phase 4)

1. **Separate** folders (never a combined content-service):
   - `backend/services/jokes-service/` — `/api/jokes/*` only, port **4807**
   - `backend/services/recipes-service/` — `/api/recipe` only, port **4808**
   - `backend/services/profile-service/` — `/api/personal-info*` only, port **4809**
2. Models copied as needed (`Joke`, `PersonalInfo` + `User` for JWT); recipes need no Mongo.
3. Lean local `.env` per service: `PORT` + `CORS_ORIGIN`; secrets from `backend/server/.env`.
4. Gateway proxies each path to its own upstream; `dev:micro` / `kill-dev` include all three.
5. Monolith handlers stubbed; `routes/{jokes,recipe,personal-info}.routes.js` throw if required.

**Success check:** healthz on each service; `GET /api/jokes/list-jokes` via gateway; `POST /api/recipe` without body → `400`; `GET /api/personal-info/all` without token → `401`.

---

## Suggested service map for MEAN-MultiChat

### 1. `auth-service` (port 4801) — **Done**

- `/api/auth/login`, `register`, `verify`, `oauth`, …
- `/api/users` (admin)
- Owns User model, password hashes, JWT signing
- Env: `JWT_SECRET`, `MONGODB_URI`, Auth0 vars (from monolith `.env`)

### 2. `chat-service` (port 4804) — **Done**

- `/api/chat`, `/api/claude`, `/api/conversations`
- Env: `OPENAI_API_KEY`, Anthropic key, `JWT_SECRET` (verify only)

### 3. `images-service` (port 4803) — **Done**

- `/api/images/*`, `/api/analyze-image` (`/api/image-search` still monolith)
- Env: `OPENAI_API_KEY`, quotas

### 4. `rag-service` (port 4802) — **Done**

- `/api/rag/*` (upload, ask, documents)
- Env: OpenAI embeddings/chat keys, Mongo for vectors/docs

### 5. `media-service` (port 4805) — **Done**

- `/api/youtube/*`, `/api/playlists`
- Env: `GOOGLE_API_KEY`, `JWT_SECRET`, `MONGODB_URI`, quota state

### 6. `speech-service` (port 4806) — **Done**

- `/api/tts`, `/api/voices`
- Env: Azure Speech keys (`SPEECH_API_KEY`, `SPEECH_REGION`)

### 7. `jokes-service` (port 4807) — **Done**

- `/api/jokes/*` (list, save, get, update, delete, search, migrate)
- Owns joke Mongo collections
- Matches the Angular **Jokes** tab — **own service** (not shared with recipes)

### 8. `recipes-service` (port 4808) — **Done**

- `/api/recipe` (and recipe-only helpers)
- Matches the Angular **Recipes** tab — **own service** (not shared with jokes)

### 9. `profile-service` (port 4809) — **Done**

- `/api/personal-info` (+ `/all`, `/:type` read/write)
- Owns per-user profile / personal-info documents (avatar, bio fields, etc.)
- Matches **Account** profile UI — separate from **auth-service**
  - **auth-service** keeps login, OAuth, JWT issue, and admin `/api/users`
  - **profile-service** keeps user-facing personal data keyed by `dataKey` / user id from JWT

### 10. `gateway` (port 4800 public)

- CORS, routing, maybe rate limits
- Angular talks only to gateway

### Later (still planned)

- **usage-service** / shared lib: `/api/ai` status + quotas
- `/api/image-search` may join **media-service** or stay on images/monolith until convenient

> **Why separate jokes, recipes, and profile:** each maps to a distinct SPA surface (Jokes tab, Recipes tab, Account/profile). Bundling them as one `content-service` would blur ownership and force unrelated deploys. Auth stays identity-only; profile is content about the signed-in user.

---

## What changes in Angular (usually little)

| Area | Monolith | Microservices |
|------|----------|---------------|
| Components / Material table | Same | Same |
| Observables / `HttpClient` | Same | Same |
| `api/client.ts` paths | `/api/chat`, `/api/rag` | **Keep same paths** via gateway |
| `environment.apiBase` | One API host | Gateway host |
| JWT storage / Bearer header | Same | Same |
| Direct service URLs | Avoid | Avoid (prefer gateway) |

Only if you skip a gateway and call services by host would you change services like:

```ts
// Prefer NOT doing this in every Angular service:
http.post('https://rag.example.com/ask', body)

// Prefer gateway so Angular stays:
http.post(`${apiBase}/api/rag/ask`, body)
```

Public demos (JSONPlaceholder) stay direct browser → public URL. No microservice needed.

---

## Data and MongoDB choices

### Start simple (recommended)

- One Atlas cluster
- Same database (or one DB per service with clear names: `mean_auth`, `mean_rag`, …)
- Services only touch **their** collections

### Later (true isolation)

- Separate databases or clusters per service
- No cross-service joins; call another service’s HTTP API if you need its data

Cross-cutting identity: prefer **user id / dataKey inside the JWT**, not “ask auth-service on every request” unless you need live user lookups.

---

## Local vs production layout

### Local (example)

```text
gateway         :4800   ← Angular proxy target  (npm run start:gateway)
auth-service    :4801   (npm run start:auth)
rag-service     :4802   (npm run start:rag)
images-service  :4803   (npm run start:images)
chat-service    :4804   (npm run start:chat)
media-service   :4805   (npm run start:media) — also image-search / image-proxy
speech-service  :4806   (npm run start:speech)
jokes-service   :4807   (npm run start:jokes)
recipes-service :4808   (npm run start:recipes)
profile-service :4809   (npm run start:profile)
monolith leftover :4810  (npm run start:monolith — health stub only)
usage-service   :4811   (npm run start:usage) — /api/ai
platform-service :4812  (npm run start:platform) — datetime, events, logs, debug
```

`proxy.conf.json` continues to send `/api` → `http://localhost:4800` (gateway).

Full stack: `npm run dev:micro`

### Production (e.g. Render)

- One **Static Site** = Angular build (unchanged idea)
- One **Web Service** = gateway (public URL)
- Private or public web services = each microservice
- Env vars per service (only the keys that service needs)
- CORS only on gateway (or gateway + services if exposed)

---

## Repo layout

```text
MEAN-MultiChat-Micro/
  src/                              # Angular SPA only
  docs/
  backend/
    server/                         # monolith leftover :4810 (health stub)
    services/
      gateway/                      # Phase 1 — public API edge :4800
      auth-service/                 # Phase 3 — :4801
      rag-service/                  # Phase 2 — :4802
      images-service/               # Phase 2 — :4803
      chat-service/                 # Phase 2 — :4804
      media-service/                # Phase 4–5 — :4805 (YouTube + image-search)
      speech-service/               # Phase 4 — :4806
      jokes-service/                # Phase 4 — :4807 (jokes only)
      recipes-service/              # Phase 4 — :4808 (recipe only)
      profile-service/              # Phase 4 — :4809
      usage-service/                # Phase 5 — :4811 (/api/ai)
      platform-service/             # Phase 5 — :4812 (datetime/events/logs/debug)
    packages/                       # optional shared server libs
      auth-middleware/              # shared JWT verify
      ai-limits/                    # shared quota helpers
    config/                         # shared config (monolith + peels as needed)
    utils/
```

**Rule of thumb:** if it runs Node, holds secrets, or talks to Mongo/AI — it goes under `backend/`. Only the SPA lives in `src/`.

You can use npm workspaces or separate repos later. Start with folders in one repo.

---

## Auth flow after split

```text
1. Angular POST /api/auth/login     → gateway → auth-service
2. auth-service returns JWT
3. Angular stores token (existing auth-storage)
4. Angular POST /api/rag/ask
      Header: Authorization: Bearer …
   → gateway → rag-service
5. rag-service authenticateToken → embed/ask → response
```

Same pattern you already use for `/api/images/generate` and `/api/rag`.

---

## Checklist: “Is this ready to peel?”

A route group is a good first microservice when:

- [ ] It already has its own `routes/*.js` file
- [ ] Secrets are clear (only that service needs them)
- [ ] Auth rule is clear (`authenticateToken` vs `optionalAuth`)
- [ ] It does not deeply reach into unrelated `server.js` helpers
- [ ] You can smoke-test one Angular feature page against it alone

---

## What *not* to do early

- Do **not** split Angular into micro-frontends just because the API is microservices.
- Do **not** give every Angular service a different base URL without a gateway.
- Do **not** put `OPENAI_API_KEY` in Angular — microservices do not change that rule.
- Do **not** extract everything at once; peel RAG or images first.

---

## Minimal first milestone (concrete)

1. ~~Add `backend/services/gateway` that proxies all `/api` → current monolith.~~ **Done**.
2. ~~Point Angular / proxy at the gateway.~~ **Done** (`proxy.conf.json` → `:4800`).
3. ~~Extract **rag-service** into `backend/services/rag-service`.~~ **Done** (`:4802`).
4. ~~Gateway: `/api/rag` → rag-service; rest → monolith.~~ **Done**.
5. Confirm Profile → RAG still works with JWT in the browser (`npm run dev:micro`).
6. ~~Extract **images-service**~~ **Done** (`:4803` — generate + analyze).
7. ~~Extract **chat-service**~~ **Done** (`:4804` — chat + claude + conversations).
8. ~~Extract **auth-service**~~ **Done** (`:4801` — `/api/auth` + `/api/users`).
9. ~~Extract **media-service**~~ **Done** (`:4805` — `/api/youtube` + `/api/playlists` + image-search/proxy).
10. ~~Extract **speech-service**~~ **Done** (`:4806` — `/api/tts` + `/api/voices`).
11. ~~Extract **jokes-service**~~ **Done** (`:4807` — `/api/jokes` only).
12. ~~Extract **recipes-service**~~ **Done** (`:4808` — `/api/recipe` only; separate from jokes).
13. ~~Extract **profile-service**~~ **Done** (`:4809` — `/api/personal-info`).
14. ~~Extract **usage-service**~~ **Done** (`:4811` — `/api/ai` status/quotas).
15. ~~Extract **platform-service**~~ **Done** (`:4812` — datetime, events, logs, quota scripts, debug).

**Leftover peels are done.** The monolith on `:4810` is a health stub (no product `/api` mounts). GitHub remote for a later push (do not push from this peel): https://github.com/PaulyWolly/MEAN-MultiChat-Micro

---

## One-sentence summary

**Keep Angular as one client; introduce a gateway that preserves `/api/...`; peel Express routers into separate Node services one domain at a time, sharing the same JWT contract.**

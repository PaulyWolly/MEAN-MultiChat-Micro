# MEAN-MultiChat-Micro

MEAN stack application with MongoDB, Express.js, and Node backend — AI tools for chat, image processing, and RAG. Angular frontend (same features as MERN-MultiChat, without React). All backend processes are Microservices.

## Layout

```text
src/app/components/   Angular UI, grouped by feature
  chat/
  youtube/
  recipes/
  jokes/
  images/
  rag/
  login/
  about/
  media/
  shared/
src/app/services/     Auth, toasts, API client
backend/server/       Express monolith (port 4810 in micro mode; 4800 for npm run dev)
backend/services/     Gateway + microservices (ports 4800–4812)
```

Task orchestration uses **Nx** (`nx.json` + per-service `project.json`). Folders stay where they are; Nx only runs the same start commands in parallel.

## Setup

1. Copy `backend/server/.env.example` to `backend/server/.env` and fill in keys.
  - **Only** `.env.example` **belongs in git.** `.env` is gitignored.
  - Do not put real secrets in `.env.example`.
2. Install:

```bash
npm install
npm run install:backend
```

1. Start the stack:

```bash
# Microservices + Angular (gateway :4800, client :4200)
npm run dev:micro

# Monolith Express on :4800 + Angular (simpler local mode)
npm run dev
```

Useful Nx commands:

```bash
npx nx show projects
npx nx serve gateway
npx nx serve mean-multichat-micro
npx nx graph
```

- Angular: [http://localhost:4200](http://localhost:4200)
- API gateway (micro): [http://localhost:4800](http://localhost:4800)

Angular proxies `/api` to the gateway/Express. Do not put API keys in the Angular client.

## Auth0 (Google / social login)

Use the **same Auth0 SPA application** as MERN-MultiChat (`pwconsulting.auth0.com`), and add MEAN’s URLs in the [Auth0 Dashboard](https://manage.auth0.com/) → **Applications** → your SPA → **Settings**.


| Setting                   | Local (`ng serve`)            | Render (after deploy)                         |
| ------------------------- | ----------------------------- | --------------------------------------------- |
| **Allowed Callback URLs** | `http://localhost:4200/login` | `https://YOUR-STATIC-SITE.onrender.com/login` |
| **Allowed Logout URLs**   | `http://localhost:4200/login` | `https://YOUR-STATIC-SITE.onrender.com/login` |
| **Allowed Web Origins**   | `http://localhost:4200`       | `https://YOUR-STATIC-SITE.onrender.com`       |


Application type: **Single Page Application**. The app uses the implicit hash flow (`response_type=token id_token`) and redirects back to `/login`.

**Backend** (`backend/server/.env` — already aligned with `.env.example`):

- `AUTH0_ISSUER_BASE_URL=https://pwconsulting.auth0.com`
- `AUTH0_CLIENT_ID=` (same SPA client id)
- `AUTH0_DOMAIN=pwconsulting.auth0.com`

**Frontend** — paste the same `AUTH0_CLIENT_ID` into:

- `src/environments/environment.development.ts` → `auth0ClientId`
- `src/environments/environment.production.ts` → `auth0ClientId` (before Render build)

Restart `npm run dev` after changing environment files. On Login, **Sign in with Google** should redirect to Auth0 and return to `http://localhost:4200/login#access_token=…`.

## Deploy (Render)

On Render, **do not commit or upload** `.env`. Copy each key from your local `.env` into the backend service **Environment** tab (same names as in `.env.example`).

Required at minimum:

- `MONGODB_URI`
- `OPENAI_API_KEY`
- `GOOGLE_API_KEY`
- `JWT_SECRET`
- `SPEECH_API_KEY` and `SPEECH_REGION` (Conversation Mode TTS)

Also set `CORS_ORIGINS` to your deployed frontend URL. Render assigns `PORT` automatically — do not hard-code it in the repo.

**Backend on Render (Docker):**

- Root directory: `backend`
- Dockerfile path: `Dockerfile`
- Add environment variables from `.env.example` in the Render dashboard (not from a committed `.env` file)

Local API image test:

```bash
npm run docker:api:build
docker run --rm -p 4800:4800 --env-file backend/server/.env mean-multichat-api
```


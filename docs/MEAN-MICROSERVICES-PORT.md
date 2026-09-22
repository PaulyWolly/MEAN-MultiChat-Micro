# MEAN-MultiChat → MEAN (microservices): complete change guide

Port checklist for another **MEAN-MultiChat** instance whose API is split into **microservices** (API gateway + speech/auth/chat/youtube services) instead of this monolith Express app (`backend/server`).

**Reference repo:** this monolith MEAN-MultiChat on `main`  
**Primary commit range:** `0bf41a9` … `ead3269` (mobile layout → Azure STT → UI polish → Auth0 → Playlist scroll → CM exit phrases)

Related shorter docs (same content, split by audience):

- [`MEAN-TO-MERN-MOBILE-SPEECH.md`](./MEAN-TO-MERN-MOBILE-SPEECH.md) — Conversation Mode / STT  
- [`MEAN-TO-MERN-UI-AUTH-MIC.md`](./MEAN-TO-MERN-UI-AUTH-MIC.md) — Recipes/Jokes/Playlists/Auth0/toolbar mic  

This document is the **single complete** guide for the microservices MEAN fork.

---

## 0. Microservices placement (read first)

Frontend changes are mostly **copy Angular files / CSS**. Backend changes must land in the **correct service**, then be exposed through the gateway with the **same public paths** the Angular client already calls.

| Public path (client) | Monolith file | Put in microservice… | Notes |
|----------------------|---------------|----------------------|--------|
| `POST /api/stt` | `backend/server/routes/stt.routes.js` | **Speech service** (same place as TTS) | `optionalAuth`; needs `SPEECH_API_KEY` + `SPEECH_REGION` |
| `POST /api/tts` | existing TTS | **Speech service** | Already present; warm DNS for STT host too |
| `POST /api/auth/oauth` (+ login/register/verify) | auth routes | **Auth service** | Auth0 return still creates app JWT here |
| `POST /api/chat`, Claude, etc. | chat routes | **Chat / AI service** | No STT change required |
| YouTube / playlists / jokes / recipes | feature routes | existing feature services | UI-only unless you lack routes |

**Gateway**

- Proxy `POST /api/stt` → speech service (multipart; do **not** parse body as JSON in the gateway).  
- Raise body/timeout limits for STT (~5MB, ~20–30s).  
- Forward `Authorization` when present.  
- CORS / cookie rules unchanged from other `/api/*` routes.

**Env (speech service)**

```env
SPEECH_API_KEY=...    # same key as TTS
SPEECH_REGION=...     # e.g. eastus
```

Optional: DNS warm `https://${SPEECH_REGION}.stt.speech.microsoft.com` on boot (same pattern as TTS).

**Client**

- Keep calling `${API_BASE}/api/stt` via the gateway (same as monolith `environment.apiBase` / proxy).  
- Do not point the browser at the speech service directly unless that is already your pattern for TTS.

---

## 1. Goals (what “done” looks like)

| Area | Expected |
|------|----------|
| Android Conversation Mode | No 5s earcon beep loop; silence quiet; speak → Hearing you → chat → TTS → listen again |
| Desktop Conversation Mode | Still `webkitSpeechRecognition` (not forced through Azure) |
| Toolbar mic (YouTube / Recipes / Jokes / Images) | Azure STT via WAV; **no** “Chrome needs internet to Google” toast |
| Guests | `/api/stt` and `/api/tts` work with `optionalAuth` |
| Phone layout | Usable nav; YouTube 2-col; sticky Chat compose + footer; Recipes/Jokes toolbar grids; Playlist videos-only scroll |
| Auth0 Google | Completes session (or shows clear error); no silent bounce to login chooser |
| Desktop layout | Wide toolbars unchanged; phone rules under `max-width: 991.98px` only |

---

## 2. Hard lessons (do not re-learn)

1. **No `SpeechRecognition` for Android Conversation Mode** — earcons + ~5s silence timeout.  
2. **Do not require `document.hasFocus()` on Android/iOS** for accepting voice — mobile Chrome often reports unfocused while the tab is visible.  
3. **Azure simple STT wants 16 kHz mono PCM WAV** — short MediaRecorder `webm` often returns empty `DisplayText`.  
4. **OpenAI Whisper is blocked** on this project key (`403` / no model access) — use **Azure Speech** with TTS credentials.  
5. **Auth0 SPA here uses implicit fragment tokens** (`token id_token` + `response_mode=fragment`). If Auth0 returns `?code=` only, enable Implicit or implement PKCE (monolith does **not** implement PKCE).  
6. **Wait for auth hydrate before reading OAuth hash** — otherwise tokens are cleared and the chooser reappears.  
7. **Playlist videos scroll:** the element with the scroll CSS must be the flex child that gets height (Angular: put scroll class on the **host**, not only an inner wrapper — see `playlist-scroll-area`).  
8. **Do not scroll the whole Playlist Manager modal on phone** — only the videos list (or dedicated scroll rail) scrolls.

---

## 3. Architecture

```
Desktop Conversation Mode
  └─ webkitSpeechRecognition
       └─ final → chat → Azure TTS → delay → listen again

Android Conversation Mode
  └─ getUserMedia + VAD + createPcmTap → 16 kHz WAV
       └─ POST /api/stt (gateway → speech service → Azure)
            └─ text → chat → Azure TTS → longer delay → VAD again

Toolbar mic (all platforms)
  └─ click → record (PCM WAV preferred) → POST /api/stt → fill field / search
```

---

## 4. Backend: `POST /api/stt` (speech microservice)

Copy logic from `backend/server/routes/stt.routes.js`.

| Rule | Detail |
|------|--------|
| Auth | `optionalAuth` (guests OK) |
| Body | `multipart/form-data`, field `file`; optional `language` (default `en-US`) |
| Limit | ~5MB memory upload |
| Tiny buffer | &lt; ~800 bytes → `{ success: true, text: "" }` |
| Format | Detect WAV via `RIFF`; Content-Type `audio/wav; codecs=audio/pcm; samplerate=16000` |
| Fallback | webm/ogg/mp3/m4a content-types as in monolith (weaker results) |
| Azure URL | `https://{region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language={lang}&format=simple` |
| Headers | `Ocp-Apim-Subscription-Key`, `Content-Type`, `Accept: application/json` |
| Success | `{ success: true, text: DisplayText }` |
| Errors | 401/403 → not configured; 429 → busy; else 502 generic |

**Client** (`src/app/services/api/client.ts` → `transcribeSpeech`):

```js
const form = new FormData()
form.append('file', new File([blob], 'speech.wav', { type: 'audio/wav' }))
form.append('language', language || 'en-US')
// Authorization Bearer if present; do NOT set Content-Type
await fetch(`${API_BASE}/api/stt`, { method: 'POST', headers: authHeaders, body: form })
```

Abort timeout ~20s.

**Curl smoke (through gateway):**

```bash
curl -sS -X POST "$API/api/stt" -F "file=@/tmp/stt-test.wav;type=audio/wav"
# Expect JSON success — not 404 from gateway / not 502 from Azure misconfig
```

---

## 5. Frontend speech stack (copy these files)

| Concern | Monolith path |
|---------|----------------|
| Android detect / resume delay | `src/app/components/shared/speech/speech.ts` → `isAndroidChrome()`, `listenResumeDelayMs()` |
| Mic + PCM/WAV + level meter | `src/app/components/shared/speech/mic-audio.ts` |
| Conversation Mode controller | `src/app/components/chat/conversation-mic.ts` |
| Voice allow / YouTube lock | `src/app/services/youtube-audio-lock.ts` → `isVoiceInputAllowed()` |
| STT upload | `src/app/services/api/client.ts` → `transcribeSpeech` |
| Toolbar mic | `src/app/components/shared/voice-mic-button/*` |
| Status / exit copy | `src/app/components/chat/messages.ts` |
| Chat wiring / exit mid-turn | `src/app/components/chat/chat.ts` |

### Platform helpers

```js
isAndroidChrome()  // Android + Chrome/CriOS
listenResumeDelayMs()  // Android 1400, else 650
```

### `isVoiceInputAllowed()`

- Block if YouTube audio lock or `document.hidden`  
- **Skip `document.hasFocus()` on Android/iOS**  
- Desktop: still require focus  

### Conversation Mode VAD (Android)

| Constant | Value |
|----------|-------|
| Start level | 16 |
| Stop level | 10 |
| Hold before start | 160ms |
| Silence to end | 900ms |
| Max record | 20s |
| Min WAV bytes | ~6000 |
| Echo ignore after TTS | 400–800ms |

### `createPcmTap`

1. `AudioContext` + `ScriptProcessor(4096, 1, 1)`  
2. ~0.45s pre-roll  
3. On stop: merge → resample **16000 Hz** → PCM16 LE WAV  
4. Mute tap output; dispose when CM ends  

Desktop CM: keep `SpeechRecognition`, `continuous = false`, restart on `onend` when still in mode.

### Exit phrases (CM)

- Honor exit phrases **mid-turn** (including after STT).  
- Strip STT punctuation when matching.  
- Uncheck Conversation Mode checkbox.  
- Speak goodbye / closing line (see `messages.ts` + `chat.ts`, commit `ead3269`).

---

## 6. Toolbar mic (YouTube / Recipes / Jokes / …)

Replace Chrome SpeechRecognition with Azure WAV STT on **all** platforms.

| Constant | Value |
|----------|-------|
| Max record | 15s |
| Silence after speech | 1400ms |
| Min record before silence stop | 1200ms |
| Speech level | 12 |
| Min blob bytes | 4000 |

UX: click → speak → pause or click again → `transcribeSpeech` → parent `onVoice`.  
Prefer `createPcmTap`; MediaRecorder webm fallback only.  
Never emit the old Google-network toast from this button.

---

## 7. Auth0 / Google login

**Files:** `oauth-login.ts`, `login.ts`, `login.html`

### Authorize

- `response_type=token id_token`  
- `response_mode=fragment`  
- `redirect_uri={origin}/login`  
- `connection=google-oauth2` for Google  

### Return

1. Wait until `auth.ready()` (up to ~8s) before parsing URL.  
2. Parse **hash and query** (`access_token`, `id_token`, `error`, `code`).  
3. Strip OAuth params from the URL after read.  
4. `code` without tokens → show Implicit/SPA callback error (not silent chooser).  
5. Exchange via `POST /api/auth/oauth` (auth microservice) → navigate home.  
6. Social step UI for errors + “Try Google again”.

### Auth0 dashboard

| Setting | Value |
|---------|--------|
| Type | SPA |
| Callbacks | monolith `http://localhost:4200/login` **and** microservices frontend origin(s) + production |
| Logout / Web Origins | matching origins |
| Grant Types | **Implicit** on (for fragment tokens) |

---

## 8. Mobile / responsive UI

Breakpoint: **`@media (max-width: 991.98px)`** (Bootstrap lg). Desktop rules stay outside that block.

### Shell

- `html/body/app-root`: `100dvh`, column flex, `overflow: hidden`  
- Header → body (`flex: 1`) → site footer (`flex: 0 0 auto`)  
- Custom elements `app-header` / `app-footer`: `display: block; flex: 0 0 auto`  
- Safe-area padding on header/footer  

### Header

- Logo → `/` (Chat)  
- Hamburger + profile in **same** actions group, ~36px controls, ~16px gap  
- Nav collapses under lg  

### Chat

- Messages `flex: 1; min-height: 0; overflow: auto`  
- Compose sticky at bottom of chat route  
- Copyright bar under compose (`min-height` ~2.75rem)  
- Empty state top-aligned on phone  

### YouTube

- Search: mic + input + search **one row** (override `.feature-form` column)  
- Actions: 3-col grid (Save | History | Playlists)  
- Hide intro hint on phone  
- Results: **2 columns**; player overlay full-bleed  

### Recipes / Jokes (chrome pattern)

```html
<div class="page-chrome">
  <div class="*-toolbar">
    <form class="*-search-form">mic + field (+ search)</form>
    <div class="*-toolbar-actions">buttons</div>
  </div>
  <p class="*-intro-hint">…</p>   <!-- hidden ≤992px -->
</div>
<div class="page-scroll *-results-scroll">…</div>
```

- Recipes actions: Print | Read aloud (2-col)  
- Jokes actions: Save | Read aloud | History (3-col); compose textarea in chrome  

### Playlist Manager

- Phone: full-bleed `100dvh` modal; body `overflow: hidden`  
- Playlists list: clamped height  
- **Only videos region scrolls**  
- Touch copy; hide drag icon; “Add to selected”  
- `.playlist-video-actions` (`display: contents` on desktop)  
- Custom scroll rail / host scroll (`playlist-scroll-area`, commits `f51bbe3`, `a84e6fd`) so mobile Chrome shows a usable thumb  
- Create: short label on phone  

### Scrollbars (14px)

Apply wider WebKit/Firefox scrollbars to:

- Playlist videos (and scroll rails)  
- `.youtube-results-scroll`  
- `.recipes-results-scroll`  
- `.jokes-results-scroll`  

### Login chooser

- Flex-start modal; scroll with `100dvh` + safe-area so options aren’t clipped  

---

## 9. CSS / markup source map

| Area | Where to copy |
|------|----------------|
| Global mobile + feature CSS | `src/styles.css` (search `991.98px`, `playlist-`, `recipes-`, `jokes-`, `youtube-`, `chat-route`, `voice-mic`) |
| Playlist modal | `playlist-manager-modal.html` / `.ts` |
| Playlist scroll host | `playlist-scroll-area/*` |
| Recipes / Jokes | `recipes.html`, `jokes.html` |
| YouTube | `youtube.html` |
| Header | `shared/header/header.html` |
| Chat shell | `chat.html` + chat route host styles |
| Login | `login.html`, `login.ts`, `oauth-login.ts` |

---

## 10. Ordered plan for the microservices MEAN instance

1. **Speech service** — Add `/api/stt` (Azure); set `SPEECH_*`; curl smoke.  
2. **Gateway** — Route multipart `/api/stt` → speech; timeouts/size.  
3. **Frontend helpers** — `isAndroidChrome`, `listenResumeDelayMs`, `isVoiceInputAllowed`.  
4. **mic-audio** — constraints + `createPcmTap` + level monitor.  
5. **Conversation Mode** — Android VAD+STT; desktop SpeechRecognition; exit phrases.  
6. **`transcribeSpeech`** — client FormData to gateway.  
7. **VoiceMicButton** — Azure WAV for toolbar mics.  
8. **Shell CSS** — sticky chat + footer + header spacing.  
9. **YouTube / Recipes / Jokes** — toolbar grids + results scroll.  
10. **Playlist Manager** — phone layout + videos-only scroll host/rail.  
11. **Auth0 return** — wait ready, hash+query, social errors; dashboard Implicit + callbacks for **this** frontend origin.  
12. **Device QA** — real Android Chrome against deployed gateway URL.

---

## 11. Verification matrix

| Test | Pass |
|------|------|
| Gateway `POST /api/stt` with WAV | 200 + JSON (not 404) |
| Android CM silence 20s | No beep loop |
| Android CM speak + pause | Transcript + spoken reply |
| After TTS | No immediate echo re-trigger |
| Desktop CM | SpeechRecognition still used |
| Guest STT/TTS | Works without JWT |
| Toolbar mic (Recipes) | Fills field; no Google-network toast |
| YouTube phone | 2-col; actions one row |
| Chat phone | Compose + copyright visible |
| Playlist phone | Videos list scrolls; chrome fixed |
| Auth0 Google | Lands in app or clear error |
| Desktop Recipes/Jokes/YouTube | One-row toolbars look original |

---

## 12. Commit map (monolith `main`)

| Commit | Theme |
|--------|--------|
| `0bf41a9` | Mobile breakpoints; quiet mic during TTS |
| `ba465f8` | Login chooser; Android listening / hasFocus |
| `68fdae3` | Stop silence beeping (VAD) |
| `87bf325`–`868eef3` | Whisper attempt (superseded) |
| `775fa46` | **Azure Speech STT** |
| `cc2eec2` | **16 kHz WAV PCM** from Android |
| `daf2241` | YouTube mobile + Material |
| `57414cb` | Header; sticky Chat + footer |
| `3313175` | Playlists/Recipes/Jokes polish; toolbar Azure mic; Auth0 return |
| `2b8545c` | MERN checklists (docs) |
| `f51bbe3` | Playlist scroll rails / videos panel |
| `a84e6fd` | Playlist scroll on Angular **host** |
| `ead3269` | CM exit phrases mid-turn + goodbye TTS |

Cherry-pick or diff these commits against the microservices fork; prefer **file-level port** of speech + CSS over blind whole-commit merges if backends diverge.

---

## 13. Out of scope

- Changing brand logo CSS unless asked  
- Full Bootstrap Reboot  
- Re-enabling Whisper (optional later)  
- Implementing Auth0 PKCE (unless you drop Implicit)  
- Desktop Conversation Mode forced onto Azure  

---

*Authoritative behavior: this monolith MEAN-MultiChat `main` through `ead3269`. When the microservices instance is updated, record its release/PR next to this range so both MEAN apps stay aligned.*

# Recent updates to port (MEAN / MERN MultiChat)

Source of truth: **MEAN-MultiChat-Micro** (`main`).  
Use this file when bringing the same UX/behavior into **MEAN-MultiChat** and **MERN-MultiChat**.

Related deep-dive (heartbeat only): [`docs/ADD_HEARTBEAT.md`](./ADD_HEARTBEAT.md).

Commits on Micro that introduced these (newest first):

| Commit | Summary |
|--------|---------|
| `d89ee6e` | Playlist Most Recent on play + Create/sort button contrast |
| `12f9197` | Close Playlist Manager when playing in-app |
| `cd957ba` / `d2651ca` / `09c38d4` | Heartbeat restore, harden, porting guide |
| `d90a593` | Remove `dev:stable` (**Micro only** — skip on monolith apps) |

---

## Port checklist (sibling apps)

- [ ] 1. Terminal heartbeat (if missing or broken) → see `ADD_HEARTBEAT.md`
- [ ] 2. Close Playlist Manager on “play in app”
- [ ] 3. Bump playlist “Most Recent” when playing from a playlist
- [ ] 4. Playlist button contrast (Create Playlist ready state + sort active/hover)
- [ ] 5. (Optional) Brand “Microservices” label on border — only if the app has that label

Skip Micro-only items below unless the target is also a gateway/micro stack.

---

## 1) Terminal heartbeat (♡ / ❤️ / 💗)

**Problem:** No in-place heartbeat as the latest server log line, or SSE never opens because the SPA only POSTs chat.

**Fix:** Keep `GET /api/chat` SSE open from the SPA; animate with `\r` on the process you watch.

**Port:** Follow **[`ADD_HEARTBEAT.md`](./ADD_HEARTBEAT.md)** end-to-end.

Monolith (MEAN / MERN):

- Put classic `\r` SSE on the main Express `GET /api/chat`.
- Add Angular `ChatHeartbeatService` + `start()` in root `App` / `AppComponent`.
- Prefer `EventSource` straight to the API host in local dev (avoid Vite proxy `ECONNRESET`).

Micro (already done here): heartbeat on **gateway** `GET /api/chat`; POST still proxies to chat-service.

**Reference files (this repo):**

- `docs/ADD_HEARTBEAT.md`
- `src/app/services/chat-heartbeat.service.ts`
- `src/app/app.ts`
- `backend/services/gateway/server.js` (Micro) or monolith `server.js` `app.get('/api/chat')`
- `src/environments/environment.development.ts` → `gatewayBase` / API base for SSE

---

## 2) Close Playlist Manager when playing in-app

**Problem:** “Click to play in app” starts the player but leaves the Playlist Manager modal open over the video.

**Fix:** When opening the in-app player, if the playlist modal is open, close it.

**MEAN / MERN (typical Angular YouTube component):**

```ts
openVideoPlayer(videoId: string) {
  if (!videoId) return;
  this.hushAppAudio(); // if present
  this.player.set({ kind: 'video', videoId: String(videoId) });
  // Playing from Playlist Manager should dismiss the modal so the player is visible.
  if (this.playlistOpen()) {
    this.closePlaylists();
  }
}
```

Wire the modal the same way:

```html
<app-playlist-manager-modal
  [open]="playlistOpen()"
  (closed)="closePlaylists()"
  (playVideo)="openVideoPlayer($event)"
/>
```

**Reference file:** `src/app/components/youtube/youtube.ts` (`openVideoPlayer`).

---

## 3) “Most Recent” playlists should rise when you play from them

**Problem:** “Most Recent” only reflected video *adds*. Playing from Hillsong left Joe Walsh on top.

**Fix:** Persist `lastAccessedAt` when the user plays from a playlist; sort “Most Recent” by that first.

### 3a) Playlist model

Add field (Mongoose example from Micro media-service):

```js
/** Set when user plays/opens a playlist — preferred for "Most Recent". */
lastAccessedAt: { type: Date },
```

Index (optional): `{ userId: 1, lastAccessedAt: -1 }`.

### 3b) API — touch endpoint

`POST /api/playlists/:playlistId/touch` (auth + same user scope as other playlist routes):

```js
router.post('/:playlistId/touch', requireAuth, async (req, res) => {
  try {
    const now = new Date();
    const playlist = await Playlist.findOneAndUpdate(
      { _id: req.params.playlistId, userId: req.userId },
      { $set: { lastAccessedAt: now } },
      { new: true },
    );
    if (!playlist) {
      return res.status(404).json({ error: 'Playlist not found' });
    }
    res.json({ success: true, playlist });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update playlist activity' });
  }
});
```

List sort (server), prefer access then add then update:

```js
.sort({ lastAccessedAt: -1, lastVideoAddedAt: -1, updatedAt: -1 })
```

Use `updateOne` / `findOneAndUpdate` so cosmetic saves do not fight activity stamps.

### 3c) Client API helper

```ts
export async function touchPlaylist(playlistId) {
  const { res, data } = await playlistRequest(
    `/api/playlists/${encodeURIComponent(playlistId)}/touch`,
    { method: 'POST', body: JSON.stringify({}) },
  );
  if (!res.ok) throw new Error(/* … */);
  return data;
}
```

### 3d) Activity time used by “Most Recent” UI sort

Prefer `lastAccessedAt`, then `lastVideoAddedAt`, then existing `updatedAt` / fallbacks:

```ts
function playlistActivityTime(playlist, secondCounts) {
  const lastAccess = toTime(playlist.lastAccessedAt);
  if (lastAccess > 0) return lastAccess;
  const lastAdd = toTime(playlist.lastVideoAddedAt);
  if (lastAdd > 0) return lastAdd;
  // … existing mass-stamp / video / createdAt fallbacks …
}
```

### 3e) Call touch before emit play

In playlist manager modal:

```ts
async playFromPlaylist(videoId: string) {
  const id = this.selectedId();
  if (id) {
    try {
      const data = await touchPlaylist(id);
      const updated = data?.playlist;
      if (updated?._id) {
        this.playlists.update((list) =>
          list.map((p) => (p._id === updated._id ? { ...p, ...updated } : p)),
        );
      }
    } catch {
      // Still play even if activity stamp fails.
    }
  }
  this.playVideo.emit(String(videoId || ''));
}
```

Template:

```html
(click)="playFromPlaylist(v.videoId)"
```

**Reference files:**

- `backend/services/media-service/models/Playlist.js`
- `backend/services/media-service/routes/playlists.routes.js`
- `src/app/services/api/playlists.ts`
- `src/app/components/youtube/playlist-manager-modal.ts`
- `src/app/components/youtube/playlist-manager-modal.html`

On MEAN/MERN monolith, the same routes live under `backend/server/routes/playlists.routes.js` (or equivalent) and the shared Playlist model.

---

## 4) Playlist button contrast (Create Playlist + Most Recent)

**Problem:** Light accent blue (`#abcafa`) + white text looked disabled.

**Fix:**

- **Create Playlist:** muted until the name field has text; then **dark text** (`#08060d`) on accent, stronger hover; `disabled` when empty.
- **Sort buttons (Most Recent active):** dark text on accent, not white; clearer hover on active/inactive.

### HTML

```html
<button
  type="submit"
  class="playlist-create-btn"
  [class.is-ready]="!!newName().trim()"
  [disabled]="!newName().trim()"
>
  Create Playlist
</button>
```

### CSS (essentials)

```css
.playlist-create-form button {
  border: 1px solid var(--border);
  background: var(--accent-bg);
  color: var(--text-h);
  cursor: not-allowed;
  opacity: 0.72;
  transition: background 0.15s ease, color 0.15s ease, opacity 0.15s ease,
    border-color 0.15s ease, box-shadow 0.15s ease;
}

.playlist-create-form button.is-ready {
  opacity: 1;
  cursor: pointer;
  background: var(--accent);
  color: #08060d;
  border-color: var(--accent-border);
  font-weight: 700;
}

.playlist-create-form button.is-ready:hover {
  background: #9bbcf5;
  color: #000;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.18);
}

.playlist-sort-btn.is-active {
  border-color: var(--accent-border);
  background: var(--accent);
  color: #08060d; /* was #fff — too low contrast on light accent */
  font-weight: 700;
}

.playlist-sort-btn.is-active:hover {
  background: #9bbcf5;
  color: #000;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.16);
}
```

**Reference:** `src/styles.css` (`.playlist-create-form button`, `.playlist-sort-btn`), `playlist-manager-modal.html`.

Apply the same contrast pattern anywhere else that uses `background: var(--accent); color: #fff` on light accent (history sort toggles, etc.) if they look “disabled.”

---

## 5) Optional — “Microservices” label on brand border

**Problem:** Small MICROSERVICES chip sat inside the brand box; wanted it centered **on** the bottom border line.

**Fix:**

```css
.header-text h1 .header-micro-label {
  position: absolute;
  right: 16px;
  bottom: 0;
  transform: translateY(50%);
  /* … existing font / background … */
}
```

Only port if the sibling app has `.header-micro-label` (or rename for that product).

**Reference:** `src/styles.css`, `src/app/components/shared/header/header.html`.

---

## Micro-only (do not port to classic MEAN / MERN unless intentional)

These belong to the microservices repo, not the monolith apps:

| Change | Why skip on MEAN/MERN |
|--------|------------------------|
| Gateway owns `GET /api/chat` heartbeat; pathFilter excludes GET from chat proxy | No gateway |
| `gatewayBase` + SSE bypass of Vite; uncaughtException keep-alive; optional `restart-on-crash.mjs` | Monolith is a single API process |
| Leftover monolith default `PORT=4810`; `start:server` forces `PORT=4800` | Different port layout |
| Remove `dev:stable` | Monolith apps may still want a stable script |
| Document title `MEAN-MultiChat-Micro` | Product naming |

For Auth0 / social login failures on Micro: run **`npm run dev:micro`**, not a stub monolith on `:4800`. Classic MEAN/MERN keep their normal `dev` / server scripts.

---

## Suggested port order on MEAN-MultiChat / MERN-MultiChat

1. Playlist modal close-on-play (tiny, instant UX win).
2. Button contrast CSS + Create Playlist `is-ready`.
3. `lastAccessedAt` + `/touch` + `playFromPlaylist` (needs API + model + UI).
4. Heartbeat via `ADD_HEARTBEAT.md` if that app is missing it or only logs on POST chat.
5. Brand label tweak only if applicable.

After porting, smoke-test:

1. Open Playlist Manager → play a video → modal closes; player visible.
2. Play again from playlist B → reopen modal with **Most Recent** → playlist B is first.
3. Empty Create Playlist looks muted; typing a name turns label dark and enables click.
4. With the SPA open, server terminal shows cycling `💓 Heartbeat … ♡/❤️/💗`.

---

## File map (Micro → sibling)

| Micro path | Likely MEAN / MERN path |
|------------|-------------------------|
| `docs/ADD_HEARTBEAT.md` | Copy into `docs/` |
| `docs/RECENT_UPDATES.md` | This file — copy into `docs/` |
| `src/app/services/chat-heartbeat.service.ts` | Same under `src/app/services/` |
| `src/app/app.ts` | Root app / `app.component.ts` |
| `src/app/components/youtube/youtube.ts` | Same feature folder |
| `src/app/components/youtube/playlist-manager-modal.*` | Same |
| `src/app/services/api/playlists.ts` | Playlist API client |
| `backend/services/media-service/.../Playlist.js` | `backend/server/models/Playlist.js` |
| `backend/services/media-service/.../playlists.routes.js` | `backend/server/routes/playlists.routes.js` |
| `src/styles.css` (playlist + header label sections) | Global styles / feature CSS |

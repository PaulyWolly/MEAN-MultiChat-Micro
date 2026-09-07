// @ts-nocheck
/**
 * Playlist API — same backend as Node-AI PlaylistManager.
 * sessionId = logged-in dataKey (or legacy guest key).
 */
import { getActiveDataKey, getStoredToken } from "../../components/login/auth-storage"
import { environment } from "../../../environments/environment"

const API_BASE = String(environment.apiBase || "").replace(/\/$/, "")

/** @deprecated Prefer getActiveDataKey() — legacy Paul bucket. */
export const PLAYLIST_SESSION_ID = "global-persistent-storage-001-v1"

function playlistErrorMessage(data, fallback) {
  const raw =
    data?.message || data?.error || data?.detail || data?.details || ""
  const text = String(raw || "").trim()
  if (
    /access token required|invalid or expired token|missing a data scope/i.test(
      text
    )
  ) {
    return "Session expired or not signed in — please sign out and sign back in, then try again."
  }
  return text || fallback
}

async function playlistRequest(path, options = {}) {
  const sessionId = getActiveDataKey()
  const sep = path.includes("?") ? "&" : "?"
  const url = `${API_BASE}${path}${sep}sessionId=${encodeURIComponent(sessionId)}`
  const token = getStoredToken()
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  })
  const data = await res.json().catch(() => ({}))
  return { res, data }
}

export async function listPlaylists() {
  const { res, data } = await playlistRequest("/api/playlists")
  if (!res.ok) throw new Error(playlistErrorMessage(data, "Failed to fetch playlists"))
  return data.playlists || []
}

export async function createPlaylist(name) {
  const { res, data } = await playlistRequest("/api/playlists", {
    method: "POST",
    body: JSON.stringify({ name }),
  })
  if (res.status === 409 && data.error === "DUPLICATE_NAME") {
    return { duplicate: true, playlist: data.playlist }
  }
  if (!res.ok) throw new Error(playlistErrorMessage(data, "Failed to create playlist"))
  return data
}

export async function addVideoToPlaylist(playlistId, video) {
  const { res, data } = await playlistRequest(
    `/api/playlists/${encodeURIComponent(playlistId)}/videos`,
    {
      method: "POST",
      body: JSON.stringify({
        videoId: video.videoId || video.id,
        title: video.title || "Untitled Video",
        thumbnail: video.thumbnail || "",
        duration: video.duration || "",
        channelTitle: video.channelTitle || video.channel || "",
      }),
    }
  )
  if (res.status === 409) {
    const err = new Error("DUPLICATE_VIDEO")
    err.code = "DUPLICATE_VIDEO"
    throw err
  }
  if (!res.ok) throw new Error(playlistErrorMessage(data, "Failed to add video"))
  return data
}

export async function removeVideoFromPlaylist(playlistId, videoEntryId) {
  const { res, data } = await playlistRequest(
    `/api/playlists/${encodeURIComponent(playlistId)}/videos/${encodeURIComponent(videoEntryId)}`,
    { method: "DELETE" }
  )
  if (!res.ok) throw new Error(playlistErrorMessage(data, "Failed to remove video"))
  return data
}

/** Move a video entry from one playlist to another (cleanup). */
export async function moveVideoToPlaylist(
  sourcePlaylistId,
  videoEntryId,
  targetPlaylistId
) {
  const { res, data } = await playlistRequest(
    `/api/playlists/${encodeURIComponent(sourcePlaylistId)}/move`,
    {
      method: "POST",
      body: JSON.stringify({ videoEntryId, targetPlaylistId }),
    }
  )
  if (!res.ok) {
    throw new Error(
      playlistErrorMessage(data, data.message || "Failed to move video")
    )
  }
  return data
}

export async function touchPlaylist(playlistId) {
  const { res, data } = await playlistRequest(
    `/api/playlists/${encodeURIComponent(playlistId)}/touch`,
    { method: "POST", body: JSON.stringify({}) }
  )
  if (!res.ok) throw new Error(playlistErrorMessage(data, "Failed to update playlist"))
  return data
}

export async function deletePlaylist(playlistId) {
  const { res, data } = await playlistRequest(
    `/api/playlists/${encodeURIComponent(playlistId)}`,
    { method: "DELETE" }
  )
  if (!res.ok) throw new Error(playlistErrorMessage(data, "Failed to delete playlist"))
  return data
}

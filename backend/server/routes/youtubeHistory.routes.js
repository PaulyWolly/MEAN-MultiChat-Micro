/**
 * YouTube history routes — MOVED to backend/services/media-service/routes/youtubeHistory.routes.js.
 * The monolith no longer mounts /api/youtube/history; the gateway proxies that path to :4805.
 */
throw new Error(
  'youtubeHistory.routes.js has moved to backend/services/media-service — do not mount from the monolith'
);

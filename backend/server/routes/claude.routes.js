/**
 * Claude routes — MOVED to backend/services/chat-service/routes/claude.routes.js.
 * The monolith no longer mounts /api/claude; the gateway proxies that path to :4804.
 */
throw new Error(
  'claude.routes.js has moved to backend/services/chat-service — do not mount from the monolith'
)

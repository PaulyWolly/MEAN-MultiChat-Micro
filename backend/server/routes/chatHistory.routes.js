/**
 * Chat history routes — MOVED to backend/services/chat-service/routes/chatHistory.routes.js.
 * The monolith no longer mounts /api/conversations; the gateway proxies that path to :4804.
 */
throw new Error(
  'chatHistory.routes.js has moved to backend/services/chat-service — do not mount from the monolith'
)

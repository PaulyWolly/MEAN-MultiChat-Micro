// @ts-nocheck
/**
 * Browser Claude SDK removed — chat goes through Express:
 * POST /api/claude/chat (see backend/server/routes/claude.routes.js)
 *
 * Kept as a thin re-export so old imports keep working.
 */
export { chatWithClaudeApi as chatWithClaude } from "../../services/api/client"

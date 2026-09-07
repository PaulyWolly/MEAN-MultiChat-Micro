/**
 * Single source of truth for every AI guard rail.
 *
 * Each limit is read from an environment variable so the caps can be retuned on
 * Render without a redeploy. Nothing else in the server should hardcode a cap —
 * routes enforce these values and GET /api/ai/status publishes them to the UI,
 * so the number a user is told is always the number the server applies.
 */

const MB = 1024 * 1024

function intFromEnv(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name]
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback

  const parsed = Number.parseInt(String(raw).trim(), 10)
  if (!Number.isFinite(parsed)) {
    console.warn(`[aiLimits] ${name}="${raw}" is not a number — using default ${fallback}`)
    return fallback
  }
  if (parsed < min || parsed > max) {
    console.warn(`[aiLimits] ${name}=${parsed} is outside ${min}..${max} — using default ${fallback}`)
    return fallback
  }
  return parsed
}

/**
 * Resolve every AI limit from the environment.
 * Read on each call so tests and scripts can mutate process.env.
 */
function getAiLimits() {
  const imageMaxUploadMb = intFromEnv('AI_IMAGE_MAX_UPLOAD_MB', 10, { min: 1, max: 200 })
  const ragMaxUploadMb = intFromEnv('AI_RAG_MAX_UPLOAD_MB', 50, { min: 1, max: 200 })

  return {
    chat: {
      maxChars: intFromEnv('AI_CHAT_MAX_CHARS', 8000, { min: 100 }),
    },
    tts: {
      maxChars: intFromEnv('AI_TTS_MAX_CHARS', 5000, { min: 100 }),
    },
    image: {
      // 0 disables generation entirely; any positive number is a per-user daily cap.
      // Deliberately low: generation is the only feature that bills per call, so
      // a missing or malformed env var must not raise spend.
      dailyLimit: intFromEnv('AI_IMAGE_DAILY_LIMIT', 5, { min: 0, max: 10000 }),
      maxPromptChars: intFromEnv('AI_IMAGE_MAX_PROMPT_CHARS', 4000, { min: 10 }),
      maxUploadMb: imageMaxUploadMb,
      maxUploadBytes: imageMaxUploadMb * MB,
    },
    rag: {
      maxDocs: intFromEnv('AI_RAG_MAX_DOCS', 20, { min: 1, max: 1000 }),
      maxUploadMb: ragMaxUploadMb,
      maxUploadBytes: ragMaxUploadMb * MB,
      maxQuestionChars: intFromEnv('AI_RAG_MAX_QUESTION_CHARS', 2000, { min: 10 }),
    },
  }
}

/** Log the active caps once at boot so deployed values are visible in Render logs. */
function logAiLimits(log = console.log) {
  const limits = getAiLimits()
  log('[aiLimits] active caps:', JSON.stringify({
    chatMaxChars: limits.chat.maxChars,
    ttsMaxChars: limits.tts.maxChars,
    imageDailyLimit: limits.image.dailyLimit,
    imageMaxUploadMb: limits.image.maxUploadMb,
    ragMaxDocs: limits.rag.maxDocs,
    ragMaxUploadMb: limits.rag.maxUploadMb,
  }))
}

module.exports = { getAiLimits, logAiLimits, MB }

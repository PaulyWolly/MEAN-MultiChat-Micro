const express = require('express')
const OpenAI = require('openai')

const { authenticateToken } = require('../middleware/auth')
const { getAiLimits } = require('../lib/aiLimits')
const {
  claimImageGeneration,
  releaseImageGeneration,
} = require('../services/aiUsage.service')

const router = express.Router()

const MODEL_PRESETS = {
  cheap: {
    id: 'cheap',
    label: 'Fast & inexpensive',
    model: process.env.OPENAI_IMAGE_MODEL_CHEAP || 'gpt-image-1-mini',
    quality: 'low',
  },
  quality: {
    id: 'quality',
    label: 'Better quality',
    model: process.env.OPENAI_IMAGE_MODEL_QUALITY || 'gpt-image-2',
    quality: 'medium',
  },
}

const ALLOWED_SIZES = new Set(['1024x1024', '1024x1536', '1536x1024'])

function getOpenAI() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set on the server')
  }
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
}

/** List available generate presets for the UI. */
router.get('/models', (_req, res) => {
  res.json({
    success: true,
    models: Object.values(MODEL_PRESETS).map(({ id, label, model, quality }) => ({
      id,
      label,
      model,
      defaultQuality: quality,
    })),
  })
})

/**
 * POST /api/images/generate
 * body: { prompt, preset?: 'cheap'|'quality', size?: '1024x1024'|..., quality?: 'low'|'medium'|'high'|'auto' }
 *
 * Sign-in required: this is the only route that spends money per call, and the
 * daily quota has to count against an identity the client cannot reset.
 */
router.post('/generate', authenticateToken, async (req, res) => {
  const limits = getAiLimits().image
  let claim = null

  try {
    const prompt = String(req.body?.prompt || '').trim()
    if (!prompt) {
      return res.status(400).json({ success: false, error: 'Prompt is required' })
    }
    if (prompt.length > limits.maxPromptChars) {
      return res.status(400).json({
        success: false,
        error: `Prompt is too long (max ${limits.maxPromptChars} characters)`,
      })
    }

    // Reserve the slot before the paid call so parallel requests cannot both
    // consume the last one.
    claim = await claimImageGeneration(req.user)
    if (!claim.ok) {
      const message =
        claim.reason === 'disabled'
          ? 'Image generation is currently disabled'
          : `Daily image limit reached (${claim.limit} per day). Your quota resets at 00:00 UTC.`
      return res.status(claim.reason === 'disabled' ? 503 : 429).json({
        success: false,
        error: message,
        reason: claim.reason,
        usage: {
          limit: claim.limit,
          used: claim.used,
          remaining: claim.remaining,
          resetsInMs: claim.resetsInMs,
        },
      })
    }

    const presetKey = String(req.body?.preset || 'cheap')
    const preset = MODEL_PRESETS[presetKey] || MODEL_PRESETS.cheap
    const size = ALLOWED_SIZES.has(req.body?.size) ? req.body.size : '1024x1024'
    const quality = ['low', 'medium', 'high', 'auto'].includes(req.body?.quality)
      ? req.body.quality
      : preset.quality

    const openai = getOpenAI()
    const started = Date.now()

    const result = await openai.images.generate({
      model: preset.model,
      prompt,
      n: 1,
      size,
      quality,
    })

    const item = result?.data?.[0]
    const b64 = item?.b64_json
    if (!b64) {
      // No image came back, so the slot was not really spent.
      await releaseImageGeneration(req.user)
      claim = null
      return res.status(502).json({
        success: false,
        error: 'Image API returned no image data',
      })
    }

    const mime = 'image/png'
    const image = `data:${mime};base64,${b64}`

    res.json({
      success: true,
      image,
      model: preset.model,
      preset: preset.id,
      quality,
      size,
      revisedPrompt: item.revised_prompt || null,
      durationMs: Date.now() - started,
      usage: {
        limit: claim.limit,
        used: claim.used,
        remaining: claim.remaining,
      },
    })
  } catch (err) {
    // A provider failure should not cost the user one of their daily images.
    if (claim?.ok) await releaseImageGeneration(req.user)

    console.error('[images/generate]', err?.message || err)
    const status = err?.status && Number.isInteger(err.status) ? err.status : 500
    res.status(status >= 400 && status < 600 ? status : 500).json({
      success: false,
      error: err?.message || 'Image generation failed',
    })
  }
})

module.exports = router

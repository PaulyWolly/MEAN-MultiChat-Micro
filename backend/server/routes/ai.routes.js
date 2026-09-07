const express = require('express')

const { optionalAuth } = require('../middleware/auth')
const { getAiLimits } = require('../lib/aiLimits')
const { getImageUsage } = require('../services/aiUsage.service')

const router = express.Router()

/**
 * GET /api/ai/status
 *
 * The single endpoint the UI reads to learn what it is allowed to do. Every cap
 * the server enforces is published here, so help text and inline hints can never
 * drift from the values the routes actually apply.
 *
 * Anonymous and guest callers get the limits but no usage figures.
 */
router.get('/status', optionalAuth, async (req, res) => {
  try {
    const limits = getAiLimits()
    const signedIn = Boolean(req.user?.id)

    const usage = signedIn
      ? { image: await getImageUsage(req.user) }
      : { image: null }

    res.json({
      success: true,
      signedIn,
      limits,
      usage,
      // Generation costs money per call, so it is the one feature that requires
      // an account the server can meter.
      requiresSignIn: { imageGenerate: true },
    })
  } catch (err) {
    console.error('[ai/status]', err?.message || err)
    res.status(500).json({ success: false, error: 'Could not load AI status' })
  }
})

module.exports = router

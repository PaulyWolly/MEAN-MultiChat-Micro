const express = require('express')
const axios = require('axios')
const fetch = require('node-fetch')
const { getAiLimits } = require('../lib/aiLimits')
const { upstreamHttpsAgent } = require('../lib/upstreamAgent')

const router = express.Router()

/** GET /api/voices — Azure neural voice catalog */
router.get('/', async (_req, res) => {
  console.log('[voices] Fetching voices from Azure...')
  try {
    if (!process.env.SPEECH_API_KEY) {
      throw new Error('SPEECH_API_KEY is not set in the environment variables')
    }

    const region = process.env.SPEECH_REGION || 'eastus'
    const response = await axios.get(
      `https://${region}.tts.speech.microsoft.com/cognitiveservices/voices/list`,
      {
        headers: {
          'Ocp-Apim-Subscription-Key': process.env.SPEECH_API_KEY,
        },
        timeout: 10000,
      },
    )
    console.log('[voices] fetched:', response.data.length)
    res.json(response.data)
  } catch (error) {
    console.error('[voices]', error?.message || error)
    res.status(500).json({
      error: 'Failed to fetch voices',
      details: error.message,
    })
  }
})

module.exports = router

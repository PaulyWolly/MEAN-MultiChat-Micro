const express = require('express')
const fetch = require('node-fetch')
const { getAiLimits } = require('../lib/aiLimits')
const { upstreamHttpsAgent } = require('../lib/upstreamAgent')

const router = express.Router()

/**
 * POST /api/tts
 * body: { text, voice }
 * Returns audio/mpeg from Azure Speech.
 */
router.post('/', async (req, res) => {
  console.log('\n=== TTS Request Started ===')
  console.log('- SPEECH_API_KEY present:', !!process.env.SPEECH_API_KEY)
  console.log('- SPEECH_REGION:', process.env.SPEECH_REGION)

  try {
    const { text, voice } = req.body || {}
    if (!text || !voice) {
      throw new Error('Missing text or voice parameter')
    }

    const ttsMaxChars = getAiLimits().tts.maxChars
    if (String(text).length > ttsMaxChars) {
      return res.status(400).json({
        success: false,
        error: `Text is too long to read aloud (max ${ttsMaxChars} characters)`,
      })
    }

    if (!process.env.SPEECH_API_KEY || !process.env.SPEECH_REGION) {
      throw new Error('SPEECH_API_KEY / SPEECH_REGION must be set')
    }

    const ssml = `
            <speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">
                <voice name="${voice}">
                    ${text}
                </voice>
            </speak>`

    const endpoint = `https://${process.env.SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': process.env.SPEECH_API_KEY,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-16khz-32kbitrate-mono-mp3',
        'User-Agent': 'ChatApp',
      },
      body: ssml,
      agent: upstreamHttpsAgent,
    })

    if (!response.ok) {
      throw new Error(`Azure API error: ${response.status} ${response.statusText}`)
    }

    const audioBuffer = await response.arrayBuffer()
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Content-Length': audioBuffer.byteLength,
    })
    res.end(Buffer.from(audioBuffer))
  } catch (error) {
    console.error('[tts]', error?.message || error)
    res.status(500).json({
      error: 'Text-to-speech failed',
      details: error.message,
    })
  }
})

module.exports = router

const express = require('express')
const OpenAI = require('openai')
const { optionalAuth } = require('../middleware/auth')
const { getAiLimits } = require('../lib/aiLimits')

const router = express.Router()

function getOpenAI() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set on the server')
  }
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
}

/** OpenAI accepts image/jpeg — not the common alias image/jpg. */
function normalizeDataUrlForOpenAI(dataUrl) {
  return String(dataUrl || '')
    .replace(/^data:image\/jpg(;|,)/i, 'data:image/jpeg$1')
    .replace(/^data:image\/pjpeg(;|,)/i, 'data:image/jpeg$1')
}

/**
 * POST /api/analyze-image
 * body: { image: data URL, prompt?, systemPrompt? }
 * Streams SSE chunks (same contract as the former monolith handler).
 */
router.post('/', optionalAuth, async (req, res) => {
  try {
    const { prompt, systemPrompt } = req.body || {}
    const image = normalizeDataUrlForOpenAI(req.body?.image)
    if (!image) {
      return res.status(400).json({ error: 'No image provided' })
    }

    if (!image.startsWith('data:image')) {
      return res.status(400).json({ error: 'Invalid image format' })
    }

    const imageLimits = getAiLimits().image
    const base64Length = image.length - (image.indexOf(',') + 1)
    const approxBytes = Math.floor((base64Length * 3) / 4)
    if (approxBytes > imageLimits.maxUploadBytes) {
      return res.status(413).json({
        error: `Image is too large (max ${imageLimits.maxUploadMb}MB)`,
      })
    }

    const openai = getOpenAI()
    const startTime = Date.now()
    let tokenCount = 0

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt || 'Analyze the following image in detail.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt || "What's in this image?" },
            {
              type: 'image_url',
              image_url: {
                url: image,
                // high detail on huge uploads often fails / times out; auto is safer
                detail: approxBytes > 2 * 1024 * 1024 ? 'low' : 'auto',
              },
            },
          ],
        },
      ],
      max_tokens: 500,
      stream: true,
    })

    for await (const chunk of response) {
      if (chunk.choices[0]?.delta?.content) {
        const content = chunk.choices[0].delta.content
        tokenCount += Math.ceil(content.length / 4)

        const data = {
          response: content,
          metrics: {
            duration: Date.now() - startTime,
            promptTokens: Math.ceil((prompt?.length || 0) / 4) || 0,
            completionTokens: tokenCount,
            totalTokens: (Math.ceil((prompt?.length || 0) / 4) || 0) + tokenCount,
            model: 'gpt-4o',
            startTime,
            endTime: Date.now(),
          },
        }

        res.write(`data: ${JSON.stringify(data)}\n\n`)
      }
    }

    const finalData = {
      done: true,
      metrics: {
        duration: Date.now() - startTime,
        promptTokens: Math.ceil((prompt?.length || 0) / 4) || 0,
        completionTokens: tokenCount,
        totalTokens: (Math.ceil((prompt?.length || 0) / 4) || 0) + tokenCount,
        model: 'gpt-4o',
        startTime,
        endTime: Date.now(),
      },
    }

    res.write(`data: ${JSON.stringify(finalData)}\n\n`)
    res.end()
  } catch (error) {
    console.error('[analyze-image]', error?.message || error)
    if (!res.headersSent) {
      return res.status(500).json({
        error: 'Failed to analyze image',
        details: error.message,
      })
    }
    try {
      res.write(
        `data: ${JSON.stringify({
          error: 'Failed to analyze image',
          message: error.message,
          done: true,
        })}\n\n`,
      )
    } catch {
      /* ignore write failures on a closed stream */
    }
    res.end()
  }
})

module.exports = router

/**
 * OpenAI chat routes — peeled from backend/server/server.js (/api/chat).
 * GET /  — SSE heartbeat
 * POST / — streaming chat (optionalAuth; greetings/time/date local; else OpenAI)
 */
const express = require('express')
const OpenAI = require('openai')
const { optionalAuth } = require('../middleware/auth')
const { getAiLimits } = require('../lib/aiLimits')
const {
  chatPatterns,
  getHoliday,
  formatTimeDateStr,
  getTimeOfDay,
  chatTodayLabel,
  needsLiveWebSearch,
  didUseOpenAIWebSearch,
  formatRecipeText,
  handleGPT4oMiniResponse,
} = require('../lib/chatHelpers')

const router = express.Router()

function getOpenAI() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set on the server')
  }
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
}

router.get('/', (req, res) => {
  let isConnected = false
  let connectionAttempts = 0
  const maxAttempts = 5

  console.log('\n━━━━━━━━━━━ SSE Connection Request ━━━━━━━━━━━')
  console.log('Time:', new Date().toLocaleTimeString())
  console.log('Client:', req.headers['user-agent'])
  console.log('Session:', req.query.sessionId)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')

  res.write(`data: ${JSON.stringify({ type: 'connection', status: 'established' })}\n\n`)
  isConnected = true

  // Direct hits to :4804 still animate; browser traffic uses gateway GET /api/chat.
  let heartPhase = 0
  const heartbeatInterval = setInterval(() => {
    if (!isConnected) {
      console.log('Attempting to restore connection...')
      connectionAttempts++
      if (connectionAttempts > maxAttempts) {
        console.log('Max reconnection attempts reached')
        clearInterval(heartbeatInterval)
        return
      }
    }

    const hearts = ['♡', '❤️', '💗']
    const heart = hearts[heartPhase]
    process.stdout.write(`\r\u001b[?25l`)
    process.stdout.write(
      `💓 Heartbeat ${new Date().toLocaleTimeString()} ${heart}                \u001b[?25l`,
    )
    heartPhase = (heartPhase + 1) % 3

    try {
      res.write(`data: ${JSON.stringify({ type: 'heartbeat' })}\n\n`)
      isConnected = true
      connectionAttempts = 0
    } catch (error) {
      console.log('Heartbeat error:', error.message)
      isConnected = false
    }
  }, 500)

  req.on('close', () => {
    process.stdout.write(`\u001b[?25h`)
    process.stdout.write('\n')
    console.log('\n━━━━━━━━━━━ SSE Connection Closed ━━━━━━━━━━━')
    console.log('Time:', new Date().toLocaleTimeString())
    console.log('Session:', req.query.sessionId)
    console.log('Final connection state:')
    console.log(JSON.stringify({ isConnected, attempts: connectionAttempts }, null, 4))
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
    clearInterval(heartbeatInterval)
  })
})

router.post('/', optionalAuth, async (req, res) => {
  try {
    const { message, history, model, systemPrompt, timezone, temperature, top_p } = req.body
    const tz = (timezone && String(timezone).trim()) || 'UTC'

    console.log('Chat request received:')
    console.log(
      JSON.stringify(
        {
          messageLength: message?.length,
          historyLength: history?.length,
          model: model,
          hasSystemPrompt: !!systemPrompt,
          timezone: tz,
          temperature: temperature,
          top_p: top_p,
        },
        null,
        4,
      ),
    )

    if (!message) {
      throw new Error('Message is required')
    }

    const chatMaxChars = getAiLimits().chat.maxChars
    if (String(message).length > chatMaxChars) {
      return res.status(400).json({
        success: false,
        error: `Message is too long (max ${chatMaxChars} characters)`,
      })
    }

    const startTime = Date.now()

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')

    if (chatPatterns.greetings.some((pattern) => pattern.test(message.toLowerCase()))) {
      const timeOfDay = getTimeOfDay(tz)
      const response = `Good ${timeOfDay}! How can I help you today?`
      res.write(`data: ${JSON.stringify({ response })}\n\n`)
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`)
      res.end()
      return
    }

    const isTimeQuery = chatPatterns.time.some((pattern) => pattern.test(message.toLowerCase()))
    const isDateQuery = chatPatterns.date.some((pattern) => pattern.test(message.toLowerCase()))
    const isDateTimeQuery = chatPatterns.dateTime.some((pattern) =>
      pattern.test(message.toLowerCase()),
    )

    if (isTimeQuery || isDateQuery || isDateTimeQuery) {
      const now = new Date()
      const formattedTime = formatTimeDateStr(now, tz)
      let response

      if (isTimeQuery) {
        response = `The current time is ${formattedTime.timeStr} (${tz}).`
      } else if (isDateQuery) {
        response = `Today is ${formattedTime.dateStr} (${tz}).`
      } else {
        response = `It is ${formattedTime.timeStr} on ${formattedTime.dateStr} (${tz}).`
      }

      const holiday = getHoliday(now)
      if (holiday) {
        response += `. ${holiday.greeting}`
      }

      res.write(`data: ${JSON.stringify({ response })}\n\n`)
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`)
      res.end()
      return
    }

    if (model === 'gpt-4o-mini' || !model) {
      const openai = getOpenAI()
      let finalSystemPrompt = systemPrompt || 'You are a helpful assistant.'
      const isRecipeRequest =
        message.toLowerCase().includes('recipe for') ||
        message.toLowerCase().includes('how to make')

      if (isRecipeRequest) {
        finalSystemPrompt +=
          "\n\nIMPORTANT: When providing a recipe, do NOT capitalize the title. For example, instead of 'LIMONCELLO', write 'Limoncello'."
      }

      finalSystemPrompt += `\n\nToday's date is ${chatTodayLabel()}. When the question is about who currently holds an office, news, prices, currency exchange rates, scores, weather, or anything that changes over time, use live web search results — do not answer from training memory alone. For currency conversions, look up the live rate and give a concrete amount.`

      const forceWeb = needsLiveWebSearch(message)
      const responseInput = [
        ...(Array.isArray(history)
          ? history.map((m) => ({
              role: m.role === 'assistant' ? 'assistant' : 'user',
              content: String(m.content || ''),
            }))
          : []),
        { role: 'user', content: String(message) },
      ]
      const tryWebSearch = async (toolType) => {
        const response = await openai.responses.create({
          model: 'gpt-4o-mini',
          instructions: finalSystemPrompt,
          input: responseInput,
          tools: [{ type: toolType }],
          tool_choice: forceWeb ? 'required' : 'auto',
          temperature: typeof temperature === 'number' ? temperature : 1.0,
        })

        let text = String(response.output_text || '').trim()
        if (isRecipeRequest && text) text = formatRecipeText(text)
        const usedWebSearch = didUseOpenAIWebSearch(response)

        if (!res.writableEnded) {
          res.write(
            `data: ${JSON.stringify({
              response: text || '(No response)',
              usedWebSearch,
              metrics: {
                duration: Date.now() - startTime,
                model: 'gpt-4o-mini',
                webSearch: usedWebSearch,
              },
            })}\n\n`,
          )
          res.write(
            `data: ${JSON.stringify({
              done: true,
              complete: true,
              usedWebSearch,
              metrics: {
                duration: Date.now() - startTime,
                model: 'gpt-4o-mini',
                webSearch: usedWebSearch,
              },
            })}\n\n`,
          )
          res.end()
        }
      }

      try {
        await tryWebSearch('web_search')
        return
      } catch (webErr) {
        console.warn(
          '[chat] OpenAI web_search failed; trying web_search_preview:',
          webErr?.message || webErr,
        )
        try {
          await tryWebSearch('web_search_preview')
          return
        } catch (previewErr) {
          console.warn(
            '[chat] OpenAI web_search_preview failed; falling back to Chat Completions:',
            previewErr?.message || previewErr,
          )
        }
      }

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: finalSystemPrompt },
          ...(Array.isArray(history) ? history : []),
          { role: 'user', content: message },
        ],
        stream: true,
        temperature: typeof temperature === 'number' ? temperature : 1.0,
      })

      await handleGPT4oMiniResponse(completion, res, message, startTime)
    } else {
      throw new Error(`Unsupported model: ${model}. Currently only supporting gpt-4o-mini`)
    }
  } catch (error) {
    console.error('Chat endpoint error:')
    console.error(
      JSON.stringify(
        {
          name: error.name,
          message: error.message,
          stack: error.stack,
          time: new Date().toISOString(),
        },
        null,
        4,
      ),
    )

    if (!res.headersSent) {
      res.status(500).json({
        error: 'Chat processing failed',
        message: error.message,
        details: error.name,
        timestamp: new Date().toISOString(),
      })
    } else {
      res.write(
        `data: ${JSON.stringify({
          error: 'Chat processing failed',
          message: error.message,
          details: error.name,
          timestamp: new Date().toISOString(),
        })}\n\n`,
      )
      res.end()
    }
  }
})

module.exports = router

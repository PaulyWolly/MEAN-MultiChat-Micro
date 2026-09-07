/**
 * Chat helpers peeled from the Express monolith (backend/server/server.js).
 * Keep in sync with getHoliday / formatTimeDateStr still used by /api/datetime on the monolith.
 */

const chatPatterns = {
  greetings: [/^hi$/i, /^hello$/i, /^hey$/i],
  time: [
    /what(?:'s| is)(?: the)?(?: local)? time/i,
    /what time is it/i,
    /^what time\b/i,
    /tell me(?: the)?(?: local)? time/i,
    /current time/i,
    /do you know what time it is/i,
  ],
  date: [
    /what(?:'s| is)(?: the)?(?: current)? date/i,
    /what day is it/i,
    /tell me(?: the)? date/i,
    /today'?s date/i,
  ],
  dateTime: [/date and time/i, /time and date/i],
}

function getHoliday(date) {
  const month = date.getMonth() + 1
  const day = date.getDate()
  const year = date.getFullYear()

  console.log('Checking holiday for:', { month, day, year })

  if (month === 11) {
    console.log('November detected, calculating Thanksgiving...')

    const thanksgiving = new Date(year, 10, 1)
    console.log('Starting with:', thanksgiving.toDateString())

    while (thanksgiving.getDay() !== 4) {
      thanksgiving.setDate(thanksgiving.getDate() + 1)
    }
    console.log('First Thursday:', thanksgiving.toDateString())

    thanksgiving.setDate(thanksgiving.getDate() + 21)
    console.log('Fourth Thursday:', thanksgiving.toDateString())

    console.log('Detailed comparison:', {
      thanksgivingDate: thanksgiving.getDate(),
      currentDay: day,
      thanksgivingMonth: thanksgiving.getMonth() + 1,
      currentMonth: month,
      thanksgivingYear: thanksgiving.getFullYear(),
      currentYear: year,
      isExactMatch: day === thanksgiving.getDate() && month === thanksgiving.getMonth() + 1,
    })

    if (day === thanksgiving.getDate()) {
      console.log('MATCH FOUND - Returning Thanksgiving greeting')
      return {
        name: 'Thanksgiving Day',
        greeting: 'Happy Thanksgiving!',
      }
    }
    console.log('No match - Thanksgiving date differs')
  }

  const holidays = {
    '1/1': "New Year's Day",
    '7/4': 'Independence Day',
    '12/24': 'Christmas Eve',
    '12/25': 'Christmas Day',
    '12/31': "New Year's Eve",
  }

  const dateKey = `${month}/${day}`
  console.log('Checking fixed holiday dateKey:', dateKey)

  if (holidays[dateKey]) {
    console.log('Found fixed holiday:', holidays[dateKey])
    return {
      name: holidays[dateKey],
      greeting: `Happy ${holidays[dateKey]}!`,
    }
  }

  console.log('No holiday found for this date')
  return null
}

function formatTimeDateStr(date, timezone = 'America/Los_Angeles') {
  return {
    timeStr: date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: timezone,
    }),
    dateStr: date.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: timezone,
    }),
  }
}

function getTimeOfDay(timezone = 'America/Los_Angeles') {
  const hour = new Date().toLocaleString('en-US', {
    hour: 'numeric',
    hour12: false,
    timeZone: timezone,
  })

  const hourNum = parseInt(hour, 10)

  if (hourNum >= 5 && hourNum < 12) {
    return 'morning'
  }
  if (hourNum >= 12 && hourNum < 17) {
    return 'afternoon'
  }
  return 'evening'
}

function chatTodayLabel() {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

/** Questions that must hit live web search (not training memory). */
function needsLiveWebSearch(message) {
  const t = String(message || '').toLowerCase()
  if (!t.trim()) return false
  return (
    /\b(who\s+is|who'?s|who\s+was|current|currently|right\s+now|as\s+of|latest|breaking|news|headline)\b/i.test(
      t,
    ) ||
    /\b(potus|president|prime\s+minister|governor|mayor|ceo|winner|election|weather|forecast|score|standings|stock|ticker)\b/i.test(
      t,
    ) ||
    /\b(today|tonight|this\s+week|this\s+month|this\s+year)\b/i.test(t) ||
    /[£$€¥]|gbp|usd|eur|cad|aud|jpy|cny|bitcoin|btc|eth\b/i.test(t) ||
    /\b(exchange\s*rate|convert|conversion|in\s+usd|in\s+dollars|in\s+pounds|in\s+euros|worth\s+in)\b/i.test(
      t,
    ) ||
    /\b(how\s+much\s+(?:is|are|would|does|do)|price\s+of|cost\s+of)\b/i.test(t)
  )
}

function didUseOpenAIWebSearch(response) {
  const output = response?.output
  if (!Array.isArray(output)) return false
  return output.some((item) => {
    if (!item || typeof item !== 'object') return false
    if (item.type === 'web_search_call') return true
    if (item.type !== 'message' || !Array.isArray(item.content)) return false
    return item.content.some(
      (part) => Array.isArray(part?.annotations) && part.annotations.length > 0,
    )
  })
}

function formatRecipeText(text) {
  if (!text) return text
  let processed = text
    .replace(/(Ingredients:)/i, '\n$1')
    .replace(/(Instructions:)/i, '\n$1')
  processed = processed.replace(/^([A-Z ]{4,})\n/, (match, p1) => {
    return p1.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) + '\n'
  })
  let lines = processed
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l)
  if (lines.length === 1) {
    lines = processed
      .split('. ')
      .map((l) => l.trim())
      .filter((l) => l)
    processed = lines.join('\n')
  }
  return processed
}

async function handleGPT4oMiniResponse(response, res, message, startTime) {
  console.log('Starting GPT-4o-mini response handling')
  let tokenCount = 0
  let fullResponse = ''
  let currentParagraph = ''
  let lastSentContent = ''
  let isEnded = false
  const isRecipeRequest =
    message.toLowerCase().includes('recipe for') ||
    message.toLowerCase().includes('how to make')
  try {
    for await (const chunk of response) {
      if (isEnded) break
      if (!chunk || !chunk.choices || !Array.isArray(chunk.choices) || chunk.choices.length === 0) {
        continue
      }
      if (chunk.choices[0]?.delta?.content) {
        const content = chunk.choices[0].delta.content
        fullResponse += content
        currentParagraph += content
        tokenCount += Math.ceil(content.length / 4)
        if (
          content.includes('[/P1]') ||
          content.includes('[/P2]') ||
          content.includes('[/P3]') ||
          content.includes('[/IMG]') ||
          content.includes('\n\n')
        ) {
          let cleanParagraph = currentParagraph
            .replace(/\[P1\]|\[P2\]|\[P3\]|\[IMG\]|\[\/P1\]|\[\/P2\]|\[\/P3\]|\[\/IMG\]/g, '')
            .trim()
          if (cleanParagraph && cleanParagraph !== lastSentContent) {
            if (isRecipeRequest) {
              cleanParagraph = formatRecipeText(cleanParagraph)
            }
            if (!res.writableEnded) {
              res.write(
                `data: ${JSON.stringify({
                  response: cleanParagraph + '\n\n',
                  tokenCount: tokenCount,
                  metrics: {
                    duration: Date.now() - startTime,
                    promptTokens: Math.ceil(fullResponse.length / 4),
                    completionTokens: tokenCount,
                    totalTokens: Math.ceil(fullResponse.length / 4) + tokenCount,
                    model: 'gpt-4o-mini',
                  },
                })}\n\n`,
              )
            }
            lastSentContent = cleanParagraph
            currentParagraph = ''
          }
        }
      }
    }
    if (currentParagraph.trim() && currentParagraph.trim() !== lastSentContent) {
      let toSend = currentParagraph.trim()
      if (isRecipeRequest) {
        toSend = formatRecipeText(toSend)
      }
      if (!res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({
            response: toSend,
            tokenCount: tokenCount,
            metrics: {
              duration: Date.now() - startTime,
              promptTokens: Math.ceil(fullResponse.length / 4),
              completionTokens: tokenCount,
              totalTokens: Math.ceil(fullResponse.length / 4) + tokenCount,
              model: 'gpt-4o-mini',
            },
          })}\n\n`,
        )
      }
    }
    if (!res.writableEnded) {
      res.write(
        `data: ${JSON.stringify({
          done: true,
          complete: true,
          response: null,
          metrics: {
            duration: Date.now() - startTime,
            promptTokens: Math.ceil(message.length / 4),
            completionTokens: tokenCount,
            totalTokens: Math.ceil(message.length / 4) + tokenCount,
            model: 'gpt-4o-mini',
          },
        })}\n\n`,
      )
      res.end()
      isEnded = true
    }
  } catch (error) {
    console.error('Error in handleGPT4oMiniResponse:', error)
    if (!res.writableEnded) {
      res.write(
        `data: ${JSON.stringify({
          error: error.message,
          done: true,
          complete: true,
        })}\n\n`,
      )
      res.end()
    }
    throw error
  }
}

module.exports = {
  chatPatterns,
  getHoliday,
  formatTimeDateStr,
  getTimeOfDay,
  chatTodayLabel,
  needsLiveWebSearch,
  didUseOpenAIWebSearch,
  formatRecipeText,
  handleGPT4oMiniResponse,
}

// @ts-nocheck
/** Local time/date replies — each visitor's browser clock, not the LLM or a fixed zone. */

import { formatTimezoneLabel, resolveClientTimezone } from '../../utils/client-timezone'

const TIME_PATTERNS = [
  /what(?:'s| is)(?: the)?(?: local)? time/i,
  /what time is it/i,
  /^what time\b/i,
  /tell me(?: the)?(?: local)? time/i,
  /current time/i,
  /do you know what time it is/i,
  /what time is it (?:for me|where i am|in my (?:time )?zone)/i,
]

const DATE_PATTERNS = [
  /what(?:'s| is)(?: the)?(?: current)? date/i,
  /what day is it/i,
  /what day is today/i,
  /tell me(?: the)? date/i,
  /today'?s date/i,
]

const DATE_TIME_PATTERNS = [/date and time/i, /time and date/i]

export { resolveClientTimezone }

export function matchChatDateTimeQuery(text) {
  const q = String(text || '').trim()
  if (!q) return null
  if (DATE_TIME_PATTERNS.some((re) => re.test(q))) return 'datetime'
  if (TIME_PATTERNS.some((re) => re.test(q))) return 'time'
  if (DATE_PATTERNS.some((re) => re.test(q))) return 'date'
  return null
}

export function formatChatDateTimeReply(kind, timezone = resolveClientTimezone()) {
  const now = new Date()
  const timeStr = now.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: timezone,
  })
  const dateStr = now.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: timezone,
  })
  const tzLabel = formatTimezoneLabel(now, timezone)

  if (kind === 'time') return `The current time is ${timeStr} (${tzLabel}).`
  if (kind === 'date') return `Today is ${dateStr}.`
  return `It is ${timeStr} on ${dateStr} (${tzLabel}).`
}

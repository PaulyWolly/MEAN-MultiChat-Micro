// @ts-nocheck
const WEEKDAY =
  "Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday"
const WEEKDAY_SHORT = "Mon|Tue|Wed|Thu|Fri|Sat|Sun"
const MONTH =
  "January|February|March|April|May|June|July|August|September|October|November|December"
const MONTH_SHORT = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec"

/**
 * Matches calendar days and dates in prose (longest forms first).
 * Used to wrap matches in markdown **bold** before rendering.
 */
const DATE_OR_DAY_RE = new RegExp(
  [
    // Monday, July 27, 2026
    String.raw`\b(?:${WEEKDAY})(?:,)?\s+(?:${MONTH})\s+\d{1,2}(?:st|nd|rd|th)?(?:,)?\s+\d{4}\b`,
    // Mon, Jul 27, 2026
    String.raw`\b(?:${WEEKDAY_SHORT})(?:,)?\s+(?:${MONTH_SHORT})\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,)?\s+\d{4}\b`,
    // July 27, 2026
    String.raw`\b(?:${MONTH})\s+\d{1,2}(?:st|nd|rd|th)?(?:,)?\s+\d{4}\b`,
    // Jul 27, 2026 · Jul 27, 9:28 AM · Jul 27
    String.raw`\b(?:${MONTH_SHORT})\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,)?(?:\s+\d{4})?(?:,?\s+\d{1,2}:\d{2}(?:\s*[AaPp][Mm])?)?\b`,
    // 7/27/2026
    String.raw`\b\d{1,2}/\d{1,2}/\d{2,4}\b`,
    // 2026-07-27
    String.raw`\b\d{4}-\d{2}-\d{2}\b`,
    // Standalone weekday names
    String.raw`\b(?:${WEEKDAY})\b`,
  ].join("|"),
  "gi"
)

function alreadyBold(text, start, end) {
  const before = text.slice(Math.max(0, start - 2), start)
  const after = text.slice(end, end + 2)
  return before === "**" || after === "**"
}

/**
 * Wrap day/date phrases in markdown bold (**…**).
 * Safe to pass through ReactMarkdown.
 */
export function boldDatesInMarkdown(text) {
  if (!text || typeof text !== "string") return text
  return text.replace(DATE_OR_DAY_RE, (match, offset) => {
    if (alreadyBold(text, offset, offset + match.length)) return match
    return `**${match}**`
  })
}

// @ts-nocheck
/**
 * Each visitor's local timezone from the browser/OS — not tied to any one user or profile.
 * Used for time/date chat replies and sent to the API so greetings match local time of day.
 */

const FALLBACK_TIMEZONE = 'UTC'

/** IANA timezone for the current browser (e.g. America/New_York, Europe/London). */
export function resolveClientTimezone() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    return tz && String(tz).trim() ? tz : FALLBACK_TIMEZONE
  } catch {
    return FALLBACK_TIMEZONE
  }
}

export function formatTimezoneLabel(date, timezone = resolveClientTimezone()) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'long',
    }).formatToParts(date)
    return parts.find((p) => p.type === 'timeZoneName')?.value || timezone
  } catch {
    return timezone
  }
}

// @ts-nocheck
/**
 * Bot identity: Andrew (Azure TTS voice) + OpenAI for chat.
 * Intercept "who are you" so the model never introduces itself as Claude.
 */

export const ANDREW_IDENTITY_REPLY =
  "I am Andrew, and I am provided by Azure TTS. This bot uses OpenAI for user interaction."

/** System-prompt block so follow-up identity questions stay consistent. */
export const ANDREW_IDENTITY_SYSTEM = `You are Andrew, a helpful conversational assistant in MEAN-MultiChat.
When asked who you are, your name, or what you are, answer like this:
"${ANDREW_IDENTITY_REPLY}"
You may then offer to help. Do not identify as Claude, Anthropic, ChatGPT, or GPT.
The speaking voice is Azure Neural TTS (Andrew). Chat replies are generated with OpenAI.
You cannot hear the user's room, speakers, TV, or other browser tabs.
Never comment on music, songs, lyrics, videos, or audio playing in the background.
If a message looks like overheard media rather than a question the user asked you, do not treat it as something you heard.`

const WHO_ARE_YOU = [
  /^who are you\b/i,
  /^who(?:'re| are) you(?: anyway)?\??$/i,
  /^what(?:'s| is) your name\??$/i,
  /^what are you\??$/i,
  /^tell me (?:about )?yourself\??$/i,
  /^introduce yourself\??$/i,
  /^who is (?:this|andrew)\??$/i,
]

export function isWhoAreYouQuery(text) {
  const q = String(text || "").trim()
  return WHO_ARE_YOU.some((re) => re.test(q))
}

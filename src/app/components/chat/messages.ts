// @ts-nocheck
/**
 * Status / conversation copy ported from the original MultiChat frontend (MESSAGES).
 * Keep this in sync mentally with the reference until the ref folder is removed.
 */
export const MESSAGES = {
  STATUS: {
    DEFAULT:
      "Check Conversation Mode to talk, or type a message and press Send.",
    MIC_WARMUP: "Getting ready…",
    STARTING_MIC: "Starting microphone…",
    LISTENING: "Listening...",
    MIC_RECYCLE: "Reconnecting microphone…",
    MIC_NETWORK:
      "Mic needs internet (Chrome speech service). Check your connection, then Restart mic.",
    THINKING: "Thinking...",
    LOOKING_AT_IMAGE: "Looking at your image…",
    AISPEAKING: "AI is speaking...",
    READY: "Ready",
    ERROR: "Error occurred. Please try again.",
    INACTIVITY_PROMPT: "Waiting for you to continue…",
  },
  CONVERSATION: {
    ENABLE: "Conversation Mode enabled. Say 'exit' to end the conversation.",
    DISABLE:
      "Conversation Mode disabled. You can still type or use the mic for a single turn.",
    EXIT: "Conversation ended",
    READY: "Conversation Mode ready. Speak whenever you're ready — say \"exit\" to end.",
  },
  CLOSINGS: {
    EXIT: "OK. Bye for now. We'll chat later!",
    TIMEOUT: (minutes) =>
      `I haven't heard anything for ${minutes} minute${minutes === 1 ? "" : "s"}, so I'll end our conversation now. Feel free to restart Conversation Mode when you'd like to chat again!`,
  },
  INACTIVITY: {
    TITLE: "Still there?",
    MESSAGE: (minutes) =>
      `No activity for ${minutes} minute${minutes === 1 ? "" : "s"}. Continue the conversation before the timer runs out, or it will end.`,
    CONTINUE: "Continue",
    END: "End conversation",
  },
}

/** Inactivity timeout before prompting to continue (ms) */
export const INACTIVITY_MS = 5 * 60 * 1000 // 5 minutes

/** How long the continue prompt waits before ending if the user does not respond */
export const INACTIVITY_PROMPT_MS = 2 * 60 * 1000 // 2 minutes

export function formatCountdown(totalSeconds) {
  const s = Math.max(0, Math.floor(Number(totalSeconds) || 0))
  const mm = Math.floor(s / 60)
  const ss = String(s % 60).padStart(2, "0")
  return `${mm}:${ss}`
}

export function isExitPhrase(text) {
  const t = String(text || '').trim().toLowerCase().replace(/[.!?]+$/, '');
  return (
    t === 'exit' ||
    t === 'quit' ||
    t === 'goodbye' ||
    t === 'good bye' ||
    t === 'bye' ||
    t === 'exit conversation'
  );
}

// @ts-nocheck
import { fetchTtsAudioUrl, playTtsAudioUrl, stopCurrentTtsAudio, pauseCurrentTtsAudio, resumeCurrentTtsAudio, isCurrentTtsAudioPaused } from "../../../services/api/client"
import { isYouTubeAudioLocked } from "../../../services/youtube-audio-lock"
import { splitIntoSpeechChunks } from "./sentence-chunks"
import { stripForSpeech } from "./tts-prep"

/**
 * Mic helpers + speak via Express /api/tts (Node-AI Azure Neural).
 */

const VOICE_STORAGE_KEY = "claude-chatbot-voice-id"
const MODEL_STORAGE_KEY = "multichat-chat-model"
const LEGACY_MODEL_STORAGE_KEY = "claude-chatbot-model"
const DEFAULT_MODEL = "openai"
const THEME_STORAGE_KEY = "multichat-theme"
const SPEECH_LANG_KEY = "multichat-speech-lang"
const CONVERSATION_MODE_PREF_KEY = "multichat-conversation-mode"
const DEFAULT_VOICE = "en-US-AndrewNeural"
const DEFAULT_SPEECH_LANG = "en-US"

/** Common Azure neural voices (same family as Node-AI). */
export const SERVER_VOICES = [
  { id: "en-US-AndrewNeural", label: "Andrew (US)" },
  { id: "en-US-JennyNeural", label: "Jenny (US)" },
  { id: "en-US-GuyNeural", label: "Guy (US)" },
  { id: "en-US-AriaNeural", label: "Aria (US)" },
  { id: "en-US-DavisNeural", label: "Davis (US)" },
  { id: "en-GB-SoniaNeural", label: "Sonia (UK)" },
  { id: "en-GB-RyanNeural", label: "Ryan (UK)" },
]

const VALID_VOICE_IDS = new Set(SERVER_VOICES.map((v) => v.id))

export function isValidAzureVoice(id) {
  return typeof id === "string" && VALID_VOICE_IDS.has(id)
}

const liveRecognizers = new Set()

export function getSpeechRecognition() {
  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition
  if (!SpeechRecognition) return null
  const recognition = new SpeechRecognition()
  liveRecognizers.add(recognition)
  const drop = () => liveRecognizers.delete(recognition)
  try {
    recognition.addEventListener("end", drop)
    recognition.addEventListener("error", drop)
  } catch {
    /* ignore */
  }
  return recognition
}

export function abortAllSpeechRecognition() {
  for (const recognition of [...liveRecognizers]) {
    try {
      recognition.abort?.()
    } catch {
      try {
        recognition.stop?.()
      } catch {
        /* ignore */
      }
    }
    liveRecognizers.delete(recognition)
  }
}

export function isSpeechRecognitionSupported() {
  return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition)
}

export function speechErrorMessage(code) {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone permission was denied. Allow the mic for this site in Chrome, then click Restart mic."
    case "no-speech":
      return ""
    case "audio-capture":
      return "No microphone was found. Check Windows sound settings / default input device."
    case "network":
      return "Chrome speech recognition needs internet access to Google. Check your network/VPN/firewall, then click Restart mic."
    case "aborted":
      return ""
    default:
      return code ? `Microphone error: ${code}` : "Microphone error."
  }
}

export function getSavedVoiceId() {
  try {
    const stored = localStorage.getItem(VOICE_STORAGE_KEY)
    if (isValidAzureVoice(stored)) return stored
    // Migrate stale ids (e.g. openai:nova) so Preview uses Andrew, not browser TTS
    if (stored) localStorage.setItem(VOICE_STORAGE_KEY, DEFAULT_VOICE)
    return DEFAULT_VOICE
  } catch {
    return DEFAULT_VOICE
  }
}

export function saveVoiceId(id) {
  try {
    if (!isValidAzureVoice(id)) return
    localStorage.setItem(VOICE_STORAGE_KEY, id)
  } catch {
    /* ignore */
  }
}

export function getSavedModel() {
  try {
    const stored = localStorage.getItem(MODEL_STORAGE_KEY)
    if (stored === "openai" || stored === "claude") return stored
    // Old default was Claude; production uses cheaper OpenAI (gpt-4o-mini).
    const legacy = localStorage.getItem(LEGACY_MODEL_STORAGE_KEY)
    localStorage.removeItem(LEGACY_MODEL_STORAGE_KEY)
    if (legacy === "openai") {
      localStorage.setItem(MODEL_STORAGE_KEY, "openai")
      return "openai"
    }
    return DEFAULT_MODEL
  } catch {
    return DEFAULT_MODEL
  }
}

export function saveModel(model) {
  try {
    localStorage.setItem(MODEL_STORAGE_KEY, model)
  } catch {
    /* ignore */
  }
}

export function getSavedTheme() {
  try {
    const t = localStorage.getItem(THEME_STORAGE_KEY)
    if (t === "light" || t === "dark") return t
  } catch {
    /* ignore */
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light"
}

export function saveTheme(theme) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    /* ignore */
  }
}

export function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme)
}

/** BCP-47 language for SpeechRecognition (e.g. en-US). */
export function getSavedSpeechLang() {
  try {
    const stored = localStorage.getItem(SPEECH_LANG_KEY)
    if (stored && /^[a-z]{2}(-[A-Za-z0-9]+)*$/.test(stored)) return stored
  } catch {
    /* ignore */
  }
  return DEFAULT_SPEECH_LANG
}

export function saveSpeechLang(lang) {
  try {
    if (!lang || typeof lang !== "string") return
    localStorage.setItem(SPEECH_LANG_KEY, lang)
  } catch {
    /* ignore */
  }
}

/**
 * Remember Conversation Mode checkbox preference only.
 * Do NOT cache live mic flags (isListening / warming) — always re-arm after reload.
 */
export function getSavedConversationModePref() {
  try {
    return localStorage.getItem(CONVERSATION_MODE_PREF_KEY) === "1"
  } catch {
    return false
  }
}

export function saveConversationModePref(enabled) {
  try {
    localStorage.setItem(CONVERSATION_MODE_PREF_KEY, enabled ? "1" : "0")
  } catch {
    /* ignore */
  }
}

/** True when no TTS audio is playing (or playback just finished / was stopped). */
let spokenAudioComplete = true
const spokenAudioCompleteListeners = new Set()

export function isSpokenAudioComplete() {
  return spokenAudioComplete
}

/** Subscribe to spoken-audio completion (fires when playback ends or is stopped). */
export function onSpokenAudioComplete(listener) {
  spokenAudioCompleteListeners.add(listener)
  return () => spokenAudioCompleteListeners.delete(listener)
}

function setSpokenAudioComplete(complete) {
  const wasComplete = spokenAudioComplete
  spokenAudioComplete = complete
  // Only notify on false → true so enabling Conversation Mode / stopSpeaking
  // doesn't re-enter listening in a loop when already complete.
  if (!complete || wasComplete) return
  for (const listener of spokenAudioCompleteListeners) {
    try {
      listener()
    } catch {
      /* ignore */
    }
  }
}

export function stopSpeaking({ markComplete = true, bumpGeneration = true } = {}) {
  if (bumpGeneration) speakGeneration += 1
  window.speechSynthesis?.cancel()
  stopCurrentTtsAudio()
  if (activeTtsHandle) {
    try {
      activeTtsHandle.stop()
    } catch {
      /* ignore */
    }
    activeTtsHandle = null
  }
  if (markComplete) setSpokenAudioComplete(true)
}

/**
 * Pause / resume the current TTS reply without ending the turn.
 * @returns {"paused"|"resumed"|"idle"}
 */
export function togglePauseSpeaking() {
  if (activeTtsHandle?.isPaused?.()) {
    const ok = activeTtsHandle.resume?.() ?? resumeCurrentTtsAudio()
    return ok ? "resumed" : "idle"
  }
  if (isCurrentTtsAudioPaused()) {
    return resumeCurrentTtsAudio() ? "resumed" : "idle"
  }
  if (activeTtsHandle?.pause) {
    const ok = activeTtsHandle.pause()
    return ok ? "paused" : "idle"
  }
  return pauseCurrentTtsAudio() ? "paused" : "idle"
}

export function isSpeakingPaused() {
  if (activeTtsHandle?.isPaused) return activeTtsHandle.isPaused()
  return isCurrentTtsAudioPaused()
}

let activeTtsHandle = null
/** Bumps on each speakText / stopSpeaking so stale playback can't flip the complete flag. */
let speakGeneration = 0

/** How many chunks to synthesise ahead of the one currently playing. */
const TTS_LOOKAHEAD = 2

function discardAudioUrl(promise) {
  Promise.resolve(promise)
    .then((url) => {
      if (url) URL.revokeObjectURL(url)
    })
    .catch(() => {
      /* already failed — nothing to release */
    })
}

/**
 * Speak via Azure Neural on Express /api/tts.
 *
 * The reply is split into sentence-sized chunks and synthesised in a pipeline:
 * playback of the first chunk starts as soon as it is ready, while later chunks
 * render in the background. Sending the whole reply as one request meant
 * waiting for the entire thing to synthesise before hearing anything, which is
 * several seconds on a long answer.
 *
 * Clears spokenAudioComplete for the whole run — not per chunk — so the mic does
 * not re-arm between sentences. Sets it true when the last chunk ends, or on
 * stop or error. Call stopSpeaking() to interrupt.
 */
export async function speakText(text, { voiceId, onEnd } = {}) {
  if (isYouTubeAudioLocked()) {
    stopSpeaking({ markComplete: true, bumpGeneration: true })
    onEnd?.()
    return
  }
  const requested = voiceId || getSavedVoiceId()
  const voice = isValidAzureVoice(requested) ? requested : DEFAULT_VOICE
  const gen = ++speakGeneration
  // Don't mark complete yet — we're about to start new audio
  stopSpeaking({ markComplete: false, bumpGeneration: false })
  setSpokenAudioComplete(false)

  const chunks = splitIntoSpeechChunks(stripForSpeech(text))
  if (!chunks.length) {
    setSpokenAudioComplete(true)
    onEnd?.()
    return
  }

  const stale = () => gen !== speakGeneration
  const pending = new Map()

  const queueFetch = (index) => {
    if (index >= chunks.length || pending.has(index)) return
    const promise = fetchTtsAudioUrl(chunks[index], voice)
    // Attach a catch now so a chunk we never await cannot surface as an
    // unhandled rejection; the real error is handled at the await site.
    promise.catch(() => {})
    pending.set(index, promise)
  }

  const releasePending = () => {
    for (const promise of pending.values()) discardAudioUrl(promise)
    pending.clear()
  }

  for (let i = 0; i <= TTS_LOOKAHEAD && i < chunks.length; i += 1) queueFetch(i)

  let spokeAnything = false
  let lastError = null

  try {
    for (let i = 0; i < chunks.length; i += 1) {
      if (stale() || isYouTubeAudioLocked()) {
        if (isYouTubeAudioLocked()) {
          stopSpeaking({ markComplete: true, bumpGeneration: true })
        }
        return
      }

      let url
      try {
        url = await pending.get(i)
      } catch (err) {
        // One chunk failing should not silence the rest of the reply.
        lastError = err
        pending.delete(i)
        queueFetch(i + TTS_LOOKAHEAD)
        continue
      }
      pending.delete(i)

      if (stale()) {
        if (url) URL.revokeObjectURL(url)
        return
      }

      // Start rendering further ahead before playing, so the network work
      // overlaps with playback rather than following it.
      queueFetch(i + TTS_LOOKAHEAD)

      const handle = await playTtsAudioUrl(url)
      if (stale()) {
        try {
          handle.stop()
        } catch {
          /* ignore */
        }
        return
      }

      activeTtsHandle = handle
      spokeAnything = true
      await handle.done
      if (activeTtsHandle === handle) activeTtsHandle = null
      if (stale()) return
    }

    if (!spokeAnything && lastError) throw lastError

    setSpokenAudioComplete(true)
    onEnd?.()
  } catch (err) {
    if (stale()) return
    activeTtsHandle = null
    setSpokenAudioComplete(true)
    onEnd?.()
    throw err
  } finally {
    releasePending()
  }
  // Note: a stale run deliberately leaves spokenAudioComplete alone. Either the
  // user stopped playback, in which case stopSpeaking() already set it, or a
  // newer reply superseded this one and now owns the flag — marking it complete
  // here would re-arm the mic in the middle of the new reply.
}

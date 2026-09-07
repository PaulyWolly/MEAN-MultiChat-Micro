/**
 * While YouTube is open in this app (this tab or another), chat must not
 * listen or speak. Also used to decide whether Conversation Mode may hear.
 */
const STORAGE_KEY = 'mean-multichat-youtube-audio-lock'
const CHANNEL_NAME = 'mean-multichat-youtube-audio'

let claimedHere = false
let channel: BroadcastChannel | null = null
const listeners = new Set<() => void>()

function notify() {
  for (const fn of listeners) {
    try {
      fn()
    } catch {
      /* ignore */
    }
  }
}

function writeLock() {
  try {
    localStorage.setItem(STORAGE_KEY, '1')
  } catch {
    /* ignore */
  }
}

function clearLockStorage() {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* ignore */
  }
}

function ensureChannel() {
  if (channel || typeof BroadcastChannel === 'undefined') return channel
  try {
    channel = new BroadcastChannel(CHANNEL_NAME)
    channel.onmessage = (event) => {
      const type = event?.data?.type
      if (type === 'ping' && claimedHere) {
        try {
          channel?.postMessage({ type: 'pong' })
        } catch {
          /* ignore */
        }
        return
      }
      if (claimedHere) return
      notify()
    }
  } catch {
    channel = null
  }
  return channel
}

export function isYouTubeAudioLocked() {
  if (claimedHere) return true
  try {
    return localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

/** True only when chat is allowed to listen (focused Chat tab, no YouTube). */
export function isVoiceInputAllowed() {
  if (typeof document === 'undefined') return false
  if (isYouTubeAudioLocked()) return false
  if (document.hidden) return false
  if (typeof document.hasFocus === 'function' && !document.hasFocus()) return false
  return true
}

export function onYouTubeAudioLockChange(listener: () => void) {
  ensureChannel()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function claimYouTubeAudioLock() {
  claimedHere = true
  ensureChannel()
  writeLock()
  try {
    channel?.postMessage({ type: 'locked' })
  } catch {
    /* ignore */
  }
  notify()
}

export function releaseYouTubeAudioLock() {
  if (!claimedHere) return
  claimedHere = false
  clearLockStorage()
  try {
    channel?.postMessage({ type: 'unlocked' })
  } catch {
    /* ignore */
  }
  notify()
}

/**
 * If a crashed YouTube tab left the lock stuck, clear it when nobody answers.
 */
export function pingYouTubeAudioLock(timeoutMs = 400) {
  if (claimedHere) return Promise.resolve(true)
  if (!isYouTubeAudioLocked()) return Promise.resolve(false)
  const ch = ensureChannel()
  if (!ch) return Promise.resolve(true)

  return new Promise((resolve) => {
    let done = false
    const finish = (alive: boolean) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        ch.removeEventListener('message', onMsg as any)
      } catch {
        /* ignore */
      }
      if (!alive) {
        clearLockStorage()
        notify()
      }
      resolve(alive)
    }
    const onMsg = (event: MessageEvent) => {
      if (event?.data?.type === 'pong') finish(true)
    }
    try {
      ch.addEventListener('message', onMsg as any)
      ch.postMessage({ type: 'ping' })
    } catch {
      finish(true)
      return
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
  })
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY) return
    if (claimedHere) return
    notify()
  })
  window.addEventListener('pagehide', () => {
    if (claimedHere) releaseYouTubeAudioLock()
  })
}

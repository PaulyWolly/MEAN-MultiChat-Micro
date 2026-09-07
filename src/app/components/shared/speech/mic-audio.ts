// @ts-nocheck
/**
 * Microphone capture helpers.
 *
 * Chrome SpeechRecognition has NO sensitivity/gain API — it uses Google's cloud STT.
 * We can still:
 *  - request autoGainControl + softer noise/echo processing on the device stream
 *  - keep that stream open during Conversation Mode (helps Windows/Chrome AGC)
 *  - show a live input level so you know if the OS hears you at all
 */

/** Favor quieter speech: AGC on, noise suppression off (gates soft voices). */
export const MIC_CAPTURE_CONSTRAINTS = {
  audio: {
    echoCancellation: true,
    autoGainControl: true,
    noiseSuppression: false,
    channelCount: 1,
    // Chrome-specific extras when supported (ignored elsewhere)
    googAutoGainControl: true,
    googNoiseSuppression: false,
    googEchoCancellation: true,
    googHighpassFilter: false,
  },
}

export async function requestMicStream() {
  return navigator.mediaDevices.getUserMedia(MIC_CAPTURE_CONSTRAINTS)
}

export function stopMicStream(stream) {
  if (!stream) return
  try {
    stream.getTracks().forEach((t) => t.stop())
  } catch {
    /* ignore */
  }
}

/**
 * Live RMS level 0–100. Call returned fn to stop.
 * Display uses a modest software boost so quiet speech still moves the bar.
 */
export function startMicLevelMonitor(stream, onLevel) {
  if (!stream) return () => {}

  let ctx
  try {
    ctx = new AudioContext()
  } catch {
    return () => {}
  }

  if (ctx.state === "suspended") {
    void ctx.resume().catch(() => {})
  }

  const source = ctx.createMediaStreamSource(stream)
  // Soft boost for the meter only — does not change Chrome SpeechRecognition gain
  const gain = ctx.createGain()
  gain.gain.value = 2.4
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 512
  analyser.smoothingTimeConstant = 0.5
  source.connect(gain)
  gain.connect(analyser)

  const data = new Uint8Array(analyser.fftSize)
  let raf = 0

  const tick = () => {
    analyser.getByteTimeDomainData(data)
    let sum = 0
    for (let i = 0; i < data.length; i += 1) {
      const v = (data[i] - 128) / 128
      sum += v * v
    }
    const rms = Math.sqrt(sum / data.length)
    // Quiet speech ~0.02–0.08; scale so normal talk fills the bar more
    const level = Math.min(100, Math.round(rms * 700))
    onLevel(level)
    raf = requestAnimationFrame(tick)
  }

  raf = requestAnimationFrame(tick)

  return () => {
    if (raf) cancelAnimationFrame(raf)
    try {
      source.disconnect()
      gain.disconnect()
      analyser.disconnect()
      ctx.close()
    } catch {
      /* ignore */
    }
  }
}

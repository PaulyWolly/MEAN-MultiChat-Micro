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

function isAndroid() {
  return typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent || '')
}

/** Favor quieter speech: AGC on. Android uses NS + AEC to cut speaker echo. */
export function micCaptureConstraints() {
  const android = isAndroid()
  return {
    audio: {
      echoCancellation: true,
      autoGainControl: true,
      noiseSuppression: android,
      channelCount: 1,
      googAutoGainControl: true,
      googNoiseSuppression: android,
      googEchoCancellation: true,
      googHighpassFilter: false,
    },
  }
}

/** @deprecated Use micCaptureConstraints() — kept for existing imports. */
export const MIC_CAPTURE_CONSTRAINTS = micCaptureConstraints()

export async function requestMicStream() {
  return navigator.mediaDevices.getUserMedia(micCaptureConstraints())
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

const PCM_PREROLL_SEC = 0.45
const WAV_RATE = 16000

function mergeFloat32(chunks) {
  let total = 0
  for (const chunk of chunks) total += chunk.length
  const out = new Float32Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

function resampleMono(input, inRate, outRate) {
  if (!input.length) return input
  if (inRate === outRate) return input
  const ratio = inRate / outRate
  const outLen = Math.max(1, Math.floor(input.length / ratio))
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i += 1) {
    const src = i * ratio
    const i0 = Math.floor(src)
    const i1 = Math.min(i0 + 1, input.length - 1)
    const frac = src - i0
    out[i] = input[i0] * (1 - frac) + input[i1] * frac
  }
  return out
}

function encodeWavPcm16k(float32, inRate) {
  const samples = resampleMono(float32, inRate, WAV_RATE)
  const pcm = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  const data = new Uint8Array(pcm.buffer)
  const header = new ArrayBuffer(44)
  const view = new DataView(header)
  const write = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i))
  }
  write(0, "RIFF")
  view.setUint32(4, 36 + data.length, true)
  write(8, "WAVE")
  write(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, WAV_RATE, true)
  view.setUint32(28, WAV_RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  write(36, "data")
  view.setUint32(40, data.length, true)
  return new Blob([header, data], { type: "audio/wav" })
}

/**
 * Continuous PCM tap for Android Conversation Mode. Keeps a short pre-roll so
 * Azure STT gets the start of the utterance, then encodes 16 kHz WAV.
 */
export function createPcmTap(stream) {
  if (!stream || typeof AudioContext === "undefined") return null

  let ctx
  try {
    ctx = new AudioContext()
  } catch {
    return null
  }

  const makeProcessor = ctx.createScriptProcessor || ctx.createJavaScriptNode
  if (typeof makeProcessor !== "function") {
    try {
      ctx.close()
    } catch {
      /* ignore */
    }
    return null
  }

  if (ctx.state === "suspended") {
    void ctx.resume().catch(() => {})
  }

  const source = ctx.createMediaStreamSource(stream)
  const processor = makeProcessor.call(ctx, 4096, 1, 1)
  const mute = ctx.createGain()
  mute.gain.value = 0

  let preroll = []
  let prerollSamples = 0
  let recording = null

  processor.onaudioprocess = (event) => {
    const copy = new Float32Array(event.inputBuffer.getChannelData(0))
    if (recording) {
      recording.push(copy)
      return
    }
    preroll.push(copy)
    prerollSamples += copy.length
    const want = Math.ceil(PCM_PREROLL_SEC * ctx.sampleRate)
    while (preroll.length > 1 && prerollSamples - preroll[0].length > want) {
      prerollSamples -= preroll.shift().length
    }
  }

  source.connect(processor)
  processor.connect(mute)
  mute.connect(ctx.destination)

  return {
    startSegment() {
      recording = preroll.slice()
    },
    get recording() {
      return !!recording
    },
    cancelSegment() {
      recording = null
    },
    async stopSegment() {
      const parts = recording || []
      const rate = ctx.sampleRate
      recording = null
      preroll = []
      prerollSamples = 0
      return encodeWavPcm16k(mergeFloat32(parts), rate)
    },
    dispose() {
      recording = null
      preroll = []
      prerollSamples = 0
      try {
        processor.disconnect()
        source.disconnect()
        mute.disconnect()
        void ctx.close()
      } catch {
        /* ignore */
      }
    },
  }
}

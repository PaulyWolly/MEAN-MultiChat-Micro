// @ts-nocheck
import {
  abortAllSpeechRecognition,
  getSavedSpeechLang,
  getSpeechRecognition,
  isAndroidChrome,
  isSpeechRecognitionSupported,
  speechErrorMessage,
} from '../shared/speech/speech';
import { MESSAGES } from './messages';
import {
  createPcmTap,
  requestMicStream,
  startMicLevelMonitor,
  stopMicStream,
} from '../shared/speech/mic-audio';
import {
  isVoiceInputAllowed,
  isYouTubeAudioLocked,
  pingYouTubeAudioLock,
} from '../../services/youtube-audio-lock';
import { transcribeSpeech } from '../../services/api/client';

const MIC_WARMUP_MIN_MS = 250;
const MIC_WARMUP_MAX_MS = 700;
const ANDROID_VAD_START = 16;
const ANDROID_VAD_STOP = 10;
const ANDROID_VAD_HOLD_MS = 160;
const ANDROID_SILENCE_MS = 900;
const ANDROID_MAX_RECORD_MS = 20000;
const ANDROID_MIN_BLOB_BYTES = 6000;

type MicBusyRefs = {
  isLoading: () => boolean;
  isSpeaking: () => boolean;
  spokenAudioComplete: () => boolean;
  inactivityPromptActive: () => boolean;
};

function pickRecorderMime() {
  if (typeof MediaRecorder === 'undefined') return '';
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  return types.find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

export class ConversationMicController {
  conversationMode = false;
  isListening = false;
  micWarming = false;
  micLevel = 0;
  statusText = MESSAGES.STATUS.DEFAULT;
  micError = '';
  readonly voiceSupported = isSpeechRecognitionSupported() || isAndroidChrome();

  private readonly onTranscript: (text: string) => void;
  private readonly busy: MicBusyRefs;
  private conversationModeRef = false;
  private micWarmingRef = false;
  private micArmedRef = false;
  private recognition: any = null;
  private isListeningRef = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private warmupTimer: ReturnType<typeof setTimeout> | null = null;
  private warmupStartedAt = 0;
  private micStream: MediaStream | null = null;
  private stopLevelMonitor: (() => void) | null = null;
  private onChange: () => void = () => {};
  private pausedForBackground = false;
  private turnLockedRef = false;
  private echoIgnoreUntil = 0;
  private vadHoldStarted = 0;
  private silenceStarted = 0;
  private recordStartedAt = 0;
  private mediaRecorder: MediaRecorder | null = null;
  private recordedChunks: Blob[] = [];
  private pcmTap: ReturnType<typeof createPcmTap> | null = null;
  private recording = false;
  private transcribing = false;
  private readonly onForegroundChange = () => this.handleForegroundChange();

  constructor(busy: MicBusyRefs, onTranscript: (text: string) => void) {
    this.busy = busy;
    this.onTranscript = onTranscript;
    document.addEventListener('visibilitychange', this.onForegroundChange);
    window.addEventListener('blur', this.onForegroundChange);
    window.addEventListener('focus', this.onForegroundChange);
  }

  setOnChange(fn: () => void) {
    this.onChange = fn;
  }

  private notify() {
    this.onChange();
  }

  private clearRestartTimer() {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  private clearWarmupTimer() {
    if (this.warmupTimer) {
      clearTimeout(this.warmupTimer);
      this.warmupTimer = null;
    }
  }

  private releaseMicCapture() {
    this.stopAndroidRecording({ submit: false });
    this.pcmTap?.dispose();
    this.pcmTap = null;
    this.stopLevelMonitor?.();
    this.stopLevelMonitor = null;
    stopMicStream(this.micStream);
    this.micStream = null;
    this.micLevel = 0;
    this.vadHoldStarted = 0;
    this.silenceStarted = 0;
  }

  private async beginMicCapture() {
    this.releaseMicCapture();
    const stream = await requestMicStream();
    this.micStream = stream;
    if (isAndroidChrome()) this.pcmTap = createPcmTap(stream);
    this.stopLevelMonitor = startMicLevelMonitor(stream, (level) => {
      this.micLevel = level;
      this.notify();
      this.onAndroidLevel(level);
    });
    return stream;
  }

  private onAndroidLevel(level: number) {
    if (!isAndroidChrome()) return;
    if (!this.canRestart() || this.transcribing) {
      this.vadHoldStarted = 0;
      return;
    }
    if (Date.now() < this.echoIgnoreUntil) {
      this.vadHoldStarted = 0;
      return;
    }

    if (this.recording) {
      if (level < ANDROID_VAD_STOP) {
        if (!this.silenceStarted) this.silenceStarted = Date.now();
        else if (Date.now() - this.silenceStarted >= ANDROID_SILENCE_MS) {
          this.stopAndroidRecording({ submit: true });
        }
      } else {
        this.silenceStarted = 0;
      }
      if (this.recordStartedAt && Date.now() - this.recordStartedAt >= ANDROID_MAX_RECORD_MS) {
        this.stopAndroidRecording({ submit: true });
      }
      return;
    }

    if (level >= ANDROID_VAD_START) {
      if (!this.vadHoldStarted) this.vadHoldStarted = Date.now();
      else if (Date.now() - this.vadHoldStarted >= ANDROID_VAD_HOLD_MS) {
        this.vadHoldStarted = 0;
        this.startAndroidRecording();
      }
    } else {
      this.vadHoldStarted = 0;
    }
  }

  private startAndroidRecording() {
    if (!isAndroidChrome() || this.recording || this.transcribing) return;
    if (this.pcmTap) {
      this.pcmTap.startSegment();
      this.recording = true;
      this.recordStartedAt = Date.now();
      this.silenceStarted = 0;
      this.statusText = MESSAGES.STATUS.LISTENING;
      this.notify();
      return;
    }
    if (!this.micStream || typeof MediaRecorder === 'undefined') {
      this.micError = 'This browser cannot record microphone audio.';
      this.notify();
      return;
    }
    const mime = pickRecorderMime();
    try {
      this.recordedChunks = [];
      this.mediaRecorder = mime
        ? new MediaRecorder(this.micStream, { mimeType: mime })
        : new MediaRecorder(this.micStream);
    } catch (err: any) {
      this.micError = err?.message || 'Could not start microphone recording.';
      this.notify();
      return;
    }
    this.mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size) this.recordedChunks.push(event.data);
    };
    this.mediaRecorder.onstop = () => {
      const chunks = this.recordedChunks;
      const type = this.mediaRecorder?.mimeType || chunks[0]?.type || 'audio/webm';
      this.recordedChunks = [];
      this.mediaRecorder = null;
      this.recording = false;
      if (!this._submitRecording) return;
      this._submitRecording = false;
      const blob = new Blob(chunks, { type });
      void this.submitAndroidRecording(blob);
    };
    this._submitRecording = false;
    this.recording = true;
    this.recordStartedAt = Date.now();
    this.silenceStarted = 0;
    this.mediaRecorder.start(250);
    this.statusText = MESSAGES.STATUS.LISTENING;
    this.notify();
  }

  private _submitRecording = false;

  private stopAndroidRecording({ submit = false } = {}) {
    if (!this.recording) return;
    if (this.pcmTap?.recording) {
      this.recording = false;
      if (!submit) {
        this.pcmTap.cancelSegment();
        return;
      }
      this.transcribing = true;
      void this.pcmTap
        .stopSegment()
        .then((blob) => {
          void this.submitAndroidRecording(blob);
        })
        .catch(() => {
          this.transcribing = false;
          this.statusText = MESSAGES.STATUS.LISTENING;
          this.notify();
        });
      return;
    }
    if (!this.mediaRecorder) {
      this.recording = false;
      return;
    }
    this._submitRecording = submit;
    this.recording = false;
    try {
      if (this.mediaRecorder.state === 'recording') {
        try {
          this.mediaRecorder.requestData();
        } catch {
          /* older Chrome */
        }
        this.mediaRecorder.stop();
      }
    } catch {
      this._submitRecording = false;
    }
  }

  private async submitAndroidRecording(blob: Blob) {
    if (!this.conversationModeRef || this.turnLockedRef) {
      this.transcribing = false;
      return;
    }
    if (!blob || blob.size < ANDROID_MIN_BLOB_BYTES) {
      this.transcribing = false;
      this.statusText = MESSAGES.STATUS.LISTENING;
      this.notify();
      return;
    }
    this.transcribing = true;
    this.statusText = 'Hearing you…';
    this.notify();
    try {
      const text = await transcribeSpeech(blob, getSavedSpeechLang());
      if (text && this.conversationModeRef && !this.turnLockedRef) {
        this.onTranscript(text);
      } else if (this.conversationModeRef) {
        this.statusText = "Didn't catch that. Speak again.";
      }
    } catch (err: any) {
      this.micError = err?.message || 'Could not hear that. Try again.';
      this.statusText = MESSAGES.STATUS.LISTENING;
    } finally {
      this.transcribing = false;
      this.notify();
    }
  }

  private canRestart() {
    return (
      this.conversationModeRef &&
      this.micArmedRef &&
      !this.turnLockedRef &&
      !this.micWarmingRef &&
      !this.busy.isLoading() &&
      !this.busy.isSpeaking() &&
      !this.busy.inactivityPromptActive() &&
      isVoiceInputAllowed()
    );
  }

  private disposeRecognition() {
    this.clearRestartTimer();
    this.isListeningRef = false;
    try {
      this.recognition?.abort?.();
    } catch {
      try {
        this.recognition?.stop();
      } catch {
        /* ignore */
      }
    }
    this.recognition = null;
  }

  private initializeSpeechRecognition() {
    if (isAndroidChrome()) return null;
    if (!isSpeechRecognitionSupported()) return null;

    let recognition;
    try {
      recognition = getSpeechRecognition();
    } catch {
      return null;
    }
    if (!recognition) return null;

    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = getSavedSpeechLang() || 'en-US';

    recognition.onstart = () => {
      this.isListeningRef = true;
      this.isListening = true;
      if (this.micWarmingRef) {
        const elapsed = Date.now() - (this.warmupStartedAt || Date.now());
        const remaining = Math.max(0, MIC_WARMUP_MIN_MS - elapsed);
        this.clearWarmupTimer();
        if (remaining === 0) this.finishWarmup('onstart');
        else {
          this.warmupTimer = setTimeout(() => {
            this.warmupTimer = null;
            this.finishWarmup('onstart');
          }, remaining);
        }
      } else if (this.micArmedRef) {
        this.statusText = MESSAGES.STATUS.LISTENING;
      }
      this.notify();
    };

    recognition.onend = () => {
      this.isListeningRef = false;
      if (!this.canRestart()) {
        this.isListening = false;
        this.notify();
        return;
      }
      this.statusText = MESSAGES.STATUS.LISTENING;
      this.clearRestartTimer();
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        if (this.canRestart()) this.startListening();
        else {
          this.isListening = false;
          this.notify();
        }
      }, 100);
      this.notify();
    };

    recognition.onerror = (event: any) => {
      const code = event.error;
      if (code === 'no-speech' || code === 'aborted') return;
      this.isListeningRef = false;
      this.isListening = false;
      const message = speechErrorMessage(code);
      if (message) this.micError = message;
      this.recognition = null;
      this.clearRestartTimer();
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        if (this.conversationModeRef && this.canRestart()) {
          this.initializeSpeechRecognition();
          this.startListening();
        }
      }, 1000);
      this.notify();
    };

    recognition.onresult = (event: any) => {
      if (!this.conversationModeRef) return;
      if (!isVoiceInputAllowed()) return;
      if (this.micWarmingRef || !this.micArmedRef || this.turnLockedRef) return;
      if (this.busy.isLoading() || this.busy.isSpeaking()) return;
      if (Date.now() < this.echoIgnoreUntil) return;
      const result = event.results?.[event.results.length - 1];
      if (!result?.isFinal) return;
      const transcript = result[0]?.transcript?.trim();
      if (!transcript) return;
      this.onTranscript(transcript);
    };

    this.recognition = recognition;
    return recognition;
  }

  private finishWarmup(reason = 'timer') {
    if (!this.conversationModeRef || !this.micWarmingRef) return;
    this.clearWarmupTimer();
    this.micWarmingRef = false;
    this.micArmedRef = true;
    this.micWarming = false;
    this.statusText = MESSAGES.STATUS.LISTENING;
    this.echoIgnoreUntil = Date.now() + (isAndroidChrome() ? 400 : 0);
    this.isListening = true;
    if (!isAndroidChrome() && !this.isListeningRef) this.startListening();
    this.notify();
  }

  startListening() {
    if (!this.conversationModeRef) return;
    if (!isVoiceInputAllowed()) return;
    if (isAndroidChrome()) {
      this.isListening = true;
      this.statusText = MESSAGES.STATUS.LISTENING;
      this.notify();
      return;
    }
    if (!this.micWarmingRef && !this.canRestart() && this.micArmedRef) return;
    if (!this.recognition) this.initializeSpeechRecognition();
    if (!this.recognition) {
      this.micError = 'Speech recognition needs Chrome or Edge.';
      this.notify();
      return;
    }
    if (this.isListeningRef) return;
    try {
      this.recognition.start();
      this.isListeningRef = true;
      this.isListening = true;
      if (this.micArmedRef && !this.micWarmingRef) {
        this.statusText = MESSAGES.STATUS.LISTENING;
      }
      this.notify();
    } catch (err: any) {
      const message = err?.message || String(err);
      if (/already started/i.test(message)) {
        this.isListeningRef = true;
        this.isListening = true;
        this.notify();
        return;
      }
      this.isListeningRef = false;
      this.isListening = false;
      this.recognition = null;
      this.clearRestartTimer();
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        if (this.conversationModeRef) {
          this.initializeSpeechRecognition();
          this.startListening();
        }
      }, 1000);
      this.notify();
    }
  }

  pauseForTurn() {
    this.turnLockedRef = true;
    this.clearRestartTimer();
    this.vadHoldStarted = 0;
    this.isListening = false;
    this.stopAndroidRecording({ submit: false });
    this.disposeRecognition();
    if (isAndroidChrome()) this.releaseMicCapture();
    this.notify();
  }

  async enterListeningMode() {
    if (!this.conversationModeRef) return;
    if (!isVoiceInputAllowed()) return;
    if (this.busy.inactivityPromptActive()) return;
    if (this.micWarmingRef) {
      this.startListening();
      return;
    }
    if (
      this.busy.isLoading() ||
      this.busy.isSpeaking() ||
      !this.busy.spokenAudioComplete()
    ) {
      return;
    }
    this.turnLockedRef = false;
    this.echoIgnoreUntil = Date.now() + (isAndroidChrome() ? 800 : 250);
    if (!this.micStream) {
      try {
        await this.beginMicCapture();
      } catch (err: any) {
        this.micError =
          'Microphone access was lost. Turn Conversation Mode off and on again.';
        this.notify();
        return;
      }
    }
    this.statusText = MESSAGES.STATUS.LISTENING;
    this.isListening = true;
    if (!isAndroidChrome()) {
      this.disposeRecognition();
      this.initializeSpeechRecognition();
      this.startListening();
    }
    this.notify();
  }

  stopListening() {
    this.clearWarmupTimer();
    this.micWarmingRef = false;
    this.micArmedRef = false;
    this.micWarming = false;
    this.isListening = false;
    this.transcribing = false;
    this.disposeRecognition();
    this.releaseMicCapture();
    this.notify();
  }

  async handleConversationModeChange(checked: boolean) {
    this.micError = '';
    if (!checked) {
      this.clearWarmupTimer();
      this.clearRestartTimer();
      this.conversationModeRef = false;
      this.conversationMode = false;
      this.turnLockedRef = false;
      this.stopListening();
      this.statusText = MESSAGES.STATUS.DEFAULT;
      this.notify();
      return;
    }
    if (!this.voiceSupported) {
      this.micError = 'Speech recognition needs Chrome or Edge (not the IDE preview).';
      this.notify();
      return;
    }
    if (isYouTubeAudioLocked()) {
      const alive = await pingYouTubeAudioLock();
      if (alive) {
        this.micError = 'Turn off YouTube playback before using Conversation Mode.';
        this.notify();
        return;
      }
    }
    this.clearWarmupTimer();
    this.clearRestartTimer();
    this.disposeRecognition();
    this.conversationModeRef = true;
    this.conversationMode = true;
    this.micArmedRef = false;
    this.micWarmingRef = true;
    this.micWarming = true;
    this.statusText = MESSAGES.STATUS.MIC_WARMUP;
    this.warmupStartedAt = Date.now();
    this.warmupTimer = setTimeout(() => {
      this.warmupTimer = null;
      this.finishWarmup('max');
    }, MIC_WARMUP_MAX_MS);
    this.notify();

    const failMic = () => {
      this.micError =
        'Microphone access is required for Conversation Mode. Enable it in your browser settings.';
      this.conversationModeRef = false;
      this.conversationMode = false;
      this.micWarmingRef = false;
      this.micArmedRef = false;
      this.micWarming = false;
      this.clearWarmupTimer();
      this.disposeRecognition();
      this.statusText = MESSAGES.STATUS.DEFAULT;
      this.notify();
    };

    void this.beginMicCapture()
      .then(() => {
        if (!this.conversationModeRef) return;
        this.isListening = true;
        if (!isAndroidChrome()) {
          this.initializeSpeechRecognition();
          this.startListening();
        }
        this.notify();
      })
      .catch(failMic);
  }

  private handleForegroundChange() {
    if (!this.conversationModeRef) return;
    if (!isVoiceInputAllowed()) {
      this.pausedForBackground = true;
      abortAllSpeechRecognition();
      this.pauseForTurn();
      this.releaseMicCapture();
      this.statusText = 'Mic paused';
      this.notify();
      return;
    }
    if (this.pausedForBackground) {
      this.pausedForBackground = false;
      void this.enterListeningMode();
    }
  }

  destroy() {
    document.removeEventListener('visibilitychange', this.onForegroundChange);
    window.removeEventListener('blur', this.onForegroundChange);
    window.removeEventListener('focus', this.onForegroundChange);
    this.conversationModeRef = false;
    this.conversationMode = false;
    this.micArmedRef = false;
    this.micWarmingRef = false;
    this.micWarming = false;
    this.isListening = false;
    this.clearWarmupTimer();
    this.clearRestartTimer();
    this.disposeRecognition();
    abortAllSpeechRecognition();
    this.releaseMicCapture();
  }
}

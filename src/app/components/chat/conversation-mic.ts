// @ts-nocheck
import {
  abortAllSpeechRecognition,
  getSavedSpeechLang,
  getSpeechRecognition,
  isSpeechRecognitionSupported,
  speechErrorMessage,
} from '../shared/speech/speech';
import { MESSAGES } from './messages';
import {
  requestMicStream,
  startMicLevelMonitor,
  stopMicStream,
} from '../shared/speech/mic-audio';
import {
  isVoiceInputAllowed,
  isYouTubeAudioLocked,
  pingYouTubeAudioLock,
} from '../../services/youtube-audio-lock';

const MIC_WARMUP_MIN_MS = 250;
const MIC_WARMUP_MAX_MS = 700;

type MicBusyRefs = {
  isLoading: () => boolean;
  isSpeaking: () => boolean;
  spokenAudioComplete: () => boolean;
  inactivityPromptActive: () => boolean;
};

export class ConversationMicController {
  conversationMode = false;
  isListening = false;
  micWarming = false;
  micLevel = 0;
  statusText = MESSAGES.STATUS.DEFAULT;
  micError = '';
  readonly voiceSupported = isSpeechRecognitionSupported();

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
    this.stopLevelMonitor?.();
    this.stopLevelMonitor = null;
    stopMicStream(this.micStream);
    this.micStream = null;
    this.micLevel = 0;
  }

  private async beginMicCapture() {
    this.releaseMicCapture();
    const stream = await requestMicStream();
    this.micStream = stream;
    this.stopLevelMonitor = startMicLevelMonitor(stream, (level) => {
      this.micLevel = level;
      this.notify();
    });
    return stream;
  }

  private canRestart() {
    return (
      this.conversationModeRef &&
      this.micArmedRef &&
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
      if (this.micWarmingRef || !this.micArmedRef) return;
      if (this.busy.isLoading() || this.busy.isSpeaking()) return;
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
    if (!this.isListeningRef) this.startListening();
    this.notify();
  }

  startListening() {
    if (!this.conversationModeRef) return;
    if (!isVoiceInputAllowed()) return;
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
    this.isListening = false;
    this.disposeRecognition();
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
    this.disposeRecognition();
    this.initializeSpeechRecognition();
    this.statusText = MESSAGES.STATUS.LISTENING;
    this.startListening();
    this.notify();
  }

  stopListening() {
    this.clearWarmupTimer();
    this.micWarmingRef = false;
    this.micArmedRef = false;
    this.micWarming = false;
    this.isListening = false;
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
    void this.beginMicCapture().catch(() => {
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
    });
    this.initializeSpeechRecognition();
    this.startListening();
    this.warmupTimer = setTimeout(() => {
      this.warmupTimer = null;
      this.finishWarmup('max');
    }, MIC_WARMUP_MAX_MS);
    this.notify();
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

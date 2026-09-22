import { Component, OnDestroy, input, output } from '@angular/core';
import { transcribeSpeech } from '../../../services/api/client';
import {
  createPcmTap,
  requestMicStream,
  startMicLevelMonitor,
  stopMicStream,
} from '../speech/mic-audio';
import { getSavedSpeechLang } from '../speech/speech';

const MAX_RECORD_MS = 15000;
const SILENCE_AFTER_SPEECH_MS = 1400;
const MIN_RECORD_BEFORE_SILENCE_MS = 1200;
const SPEECH_LEVEL = 12;
const MIN_BLOB_BYTES = 4000;

function pickRecorderMime() {
  if (typeof MediaRecorder === 'undefined') return '';
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  return types.find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

@Component({
  selector: 'app-voice-mic-button',
  templateUrl: './voice-mic-button.html',
})
export class VoiceMicButtonComponent implements OnDestroy {
  disabled = input(false);
  transcript = output<string>();
  failed = output<string>();

  listening = false;
  busy = false;
  readonly supported =
    typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

  private stream: MediaStream | null = null;
  private pcmTap: ReturnType<typeof createPcmTap> | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private stopLevelMonitor: (() => void) | null = null;
  private maxTimer: ReturnType<typeof setTimeout> | null = null;
  private heardSpeech = false;
  private silenceStarted = 0;
  private recordStartedAt = 0;
  private submitOnStop = false;
  private finishing = false;

  ngOnDestroy() {
    this.teardown({ submit: false });
  }

  stopListening() {
    this.teardown({ submit: false });
  }

  toggle() {
    if (this.busy || this.disabled() || this.finishing) return;
    if (this.listening) {
      void this.finishRecording();
      return;
    }
    void this.startRecording();
  }

  private clearMaxTimer() {
    if (this.maxTimer) {
      clearTimeout(this.maxTimer);
      this.maxTimer = null;
    }
  }

  private async startRecording() {
    if (!this.supported) {
      this.failed.emit('Voice search needs a browser that can use the microphone.');
      return;
    }
    this.teardown({ submit: false });
    try {
      this.stream = await requestMicStream();
    } catch {
      this.failed.emit('Microphone permission was denied. Allow the mic for this site, then try again.');
      return;
    }

    this.heardSpeech = false;
    this.silenceStarted = 0;
    this.submitOnStop = false;
    this.finishing = false;
    this.recordStartedAt = Date.now();
    this.listening = true;

    this.pcmTap = createPcmTap(this.stream);
    if (this.pcmTap) {
      this.pcmTap.startSegment();
    } else if (typeof MediaRecorder !== 'undefined') {
      if (!this.startMediaRecorderFallback()) {
        this.listening = false;
        this.releaseStream();
        this.failed.emit('Could not start microphone recording.');
        return;
      }
    } else {
      this.listening = false;
      this.releaseStream();
      this.failed.emit('Could not start microphone recording.');
      return;
    }

    this.stopLevelMonitor = startMicLevelMonitor(this.stream, (level: number) => this.onLevel(level));
    this.maxTimer = setTimeout(() => void this.finishRecording(), MAX_RECORD_MS);
  }

  private startMediaRecorderFallback() {
    if (!this.stream) return false;
    const mime = pickRecorderMime();
    try {
      this.chunks = [];
      this.recorder = mime
        ? new MediaRecorder(this.stream, { mimeType: mime })
        : new MediaRecorder(this.stream);
    } catch {
      this.recorder = null;
      return false;
    }
    this.recorder.ondataavailable = (event) => {
      if (event.data?.size) this.chunks.push(event.data);
    };
    this.recorder.onstop = () => {
      const chunks = this.chunks;
      const type = this.recorder?.mimeType || chunks[0]?.type || 'audio/webm';
      this.chunks = [];
      this.recorder = null;
      const shouldSubmit = this.submitOnStop;
      this.submitOnStop = false;
      this.listening = false;
      this.finishing = false;
      if (!shouldSubmit) {
        this.releaseStream();
        return;
      }
      void this.submitBlob(new Blob(chunks, { type }));
    };
    this.recorder.start(200);
    return true;
  }

  private onLevel(level: number) {
    if (!this.listening || this.finishing) return;
    if (level >= SPEECH_LEVEL) {
      this.heardSpeech = true;
      this.silenceStarted = 0;
      return;
    }
    if (!this.heardSpeech) return;
    if (Date.now() - this.recordStartedAt < MIN_RECORD_BEFORE_SILENCE_MS) return;
    if (!this.silenceStarted) this.silenceStarted = Date.now();
    else if (Date.now() - this.silenceStarted >= SILENCE_AFTER_SPEECH_MS) {
      void this.finishRecording();
    }
  }

  private async finishRecording() {
    if (!this.listening || this.finishing) return;
    this.finishing = true;
    this.clearMaxTimer();
    this.stopLevelMonitor?.();
    this.stopLevelMonitor = null;

    if (this.pcmTap?.recording) {
      this.listening = false;
      try {
        const blob = await this.pcmTap.stopSegment();
        this.pcmTap = null;
        this.finishing = false;
        await this.submitBlob(blob);
      } catch {
        this.pcmTap = null;
        this.finishing = false;
        this.releaseStream();
        this.failed.emit("Couldn't finish microphone recording.");
      }
      return;
    }

    if (this.recorder && this.recorder.state === 'recording') {
      this.submitOnStop = true;
      try {
        try {
          this.recorder.requestData();
        } catch {
          /* older Chrome */
        }
        this.recorder.stop();
      } catch {
        this.submitOnStop = false;
        this.listening = false;
        this.finishing = false;
        this.releaseStream();
        this.failed.emit("Couldn't finish microphone recording.");
      }
      return;
    }

    this.listening = false;
    this.finishing = false;
    this.releaseStream();
    this.failed.emit('No speech heard — click the mic, speak, then pause or click again.');
  }

  private async submitBlob(blob: Blob) {
    this.releaseStream();
    if (!blob || blob.size < MIN_BLOB_BYTES) {
      this.failed.emit('No speech heard — click the mic, speak clearly, then pause.');
      return;
    }
    this.busy = true;
    try {
      const text = await transcribeSpeech(blob, getSavedSpeechLang());
      const cleaned = this.clean(text);
      if (cleaned) this.transcript.emit(cleaned);
      else this.failed.emit('Could not understand that — speak a bit louder and try again.');
    } catch (err: any) {
      this.failed.emit(err?.message || 'Voice transcription failed.');
    } finally {
      this.busy = false;
    }
  }

  private releaseStream() {
    this.stopLevelMonitor?.();
    this.stopLevelMonitor = null;
    this.pcmTap?.dispose();
    this.pcmTap = null;
    stopMicStream(this.stream);
    this.stream = null;
  }

  private teardown({ submit }: { submit: boolean }) {
    this.clearMaxTimer();
    this.stopLevelMonitor?.();
    this.stopLevelMonitor = null;
    this.finishing = false;
    if (this.pcmTap?.recording) {
      if (submit) {
        void this.finishRecording();
        return;
      }
      this.pcmTap.cancelSegment();
      this.pcmTap = null;
    }
    if (this.recorder && this.listening) {
      this.submitOnStop = submit;
      try {
        if (this.recorder.state === 'recording') this.recorder.stop();
      } catch {
        /* ignore */
      }
    } else {
      this.recorder = null;
    }
    this.listening = false;
    if (!submit) {
      this.releaseStream();
      this.busy = false;
    }
  }

  private clean(transcript: string) {
    let q = String(transcript || '').trim();
    if (!q) return '';
    q = q.replace(
      /^(please\s+)?(can\s+you\s+)?(search\s+(on\s+)?(youtube|google|bing|the\s+web)?\s*(for\s+)?|look\s+up\s+|find\s+(me\s+)?|show\s+me\s+|get\s+me\s+)/i,
      '',
    );
    q = q.replace(/^(a\s+)?(recipe\s+for\s+|images?\s+of\s+|pictures?\s+of\s+)/i, '');
    return q.replace(/[.?!]+$/, '').trim() || String(transcript).trim();
  }
}

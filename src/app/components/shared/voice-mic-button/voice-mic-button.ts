import { Component, OnDestroy, input, output } from '@angular/core';
import {
  getSpeechRecognition,
  isSpeechRecognitionSupported,
  speechErrorMessage,
} from '../speech/speech';

@Component({
  selector: 'app-voice-mic-button',
  templateUrl: './voice-mic-button.html',
})
export class VoiceMicButtonComponent implements OnDestroy {
  disabled = input(false);
  transcript = output<string>();
  failed = output<string>();

  listening = false;
  supported = isSpeechRecognitionSupported();
  private recognition: any = null;

  ngOnDestroy() {
    this.stop();
  }

  stopListening() {
    this.stop();
  }

  toggle() {
    if (this.listening) this.stop();
    else this.start();
  }

  private stop() {
    try {
      this.recognition?.stop();
    } catch {
      /* ignore */
    }
    this.recognition = null;
    this.listening = false;
  }

  private start() {
    if (!this.supported) {
      this.failed.emit('Voice search needs Chrome or Edge with microphone permission.');
      return;
    }
    this.stop();
    const recognition = getSpeechRecognition();
    if (!recognition) {
      this.failed.emit('Voice search needs Chrome or Edge with microphone permission.');
      return;
    }
    this.recognition = recognition;
    recognition.lang = 'en-US';
    recognition.interimResults = false;
    recognition.continuous = false;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => {
      this.listening = true;
    };
    recognition.onresult = (event: any) => {
      const raw = event.results[0]?.[0]?.transcript?.trim() || '';
      const cleaned = this.clean(raw);
      if (cleaned) this.transcript.emit(cleaned);
    };
    recognition.onerror = (event: any) => {
      this.listening = false;
      const message = speechErrorMessage(event.error);
      if (message) this.failed.emit(message);
    };
    recognition.onend = () => {
      this.listening = false;
      this.recognition = null;
    };
    try {
      recognition.start();
    } catch {
      this.listening = false;
      this.failed.emit("Couldn't start the microphone.");
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

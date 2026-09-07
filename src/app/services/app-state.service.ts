import { Injectable, signal } from '@angular/core';
import {
  applyTheme,
  getSavedModel,
  getSavedTheme,
  getSavedVoiceId,
  saveModel,
  saveTheme,
} from '../components/shared/speech/speech';

@Injectable({ providedIn: 'root' })
export class AppStateService {
  readonly theme = signal(getSavedTheme());
  readonly selectedModel = signal(getSavedModel());
  readonly selectedVoiceId = signal(getSavedVoiceId());
  readonly clearChat = signal(0);

  constructor() {
    applyTheme(this.theme());
  }

  toggleTheme() {
    const next = this.theme() === 'dark' ? 'light' : 'dark';
    this.theme.set(next);
    applyTheme(next);
    saveTheme(next);
  }

  setModel(model: string) {
    this.selectedModel.set(model);
    saveModel(model);
  }

  setVoiceId(id: string) {
    this.selectedVoiceId.set(id);
  }

  requestClearChat() {
    this.clearChat.update((n) => n + 1);
  }
}

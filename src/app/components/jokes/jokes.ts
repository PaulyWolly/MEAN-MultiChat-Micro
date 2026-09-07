import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ClearableInputComponent } from '../shared/clearable-input/clearable-input';
import { VoiceMicButtonComponent } from '../shared/voice-mic-button/voice-mic-button';
import { ToastService } from '../../services/toast.service';
import { listJokes, saveJoke } from '../../services/api/client';
import { getSavedVoiceId, speakText, stopSpeaking } from '../shared/speech/speech';
import { JokesHistoryModalComponent, dedupeJokesByTitle } from './jokes-history-modal';

@Component({
  selector: 'app-jokes',
  imports: [FormsModule, ClearableInputComponent, VoiceMicButtonComponent, JokesHistoryModalComponent],
  templateUrl: './jokes.html',
})
export class JokesComponent implements OnInit {
  readonly toast = inject(ToastService);

  jokes = signal<any[]>([]);
  title = signal('');
  content = '';
  selected = signal<any>(null);
  historyOpen = signal(false);
  loading = signal(false);
  saving = signal(false);
  speaking = signal(false);

  ngOnInit() {
    void this.load();
  }

  async load() {
    this.loading.set(true);
    try {
      const data = await listJokes({ showAll: false });
      this.jokes.set(dedupeJokesByTitle(data.jokes || []));
    } catch (err: any) {
      this.toast.show(err?.message || 'Could not load jokes', 'error');
    } finally {
      this.loading.set(false);
    }
  }

  async save(event: Event) {
    event.preventDefault();
    if (!this.title().trim() || !this.content.trim()) return;
    this.saving.set(true);
    try {
      await saveJoke({ title: this.title().trim(), content: this.content.trim() });
      this.title.set('');
      this.content = '';
      this.selected.set(null);
      await this.load();
      this.toast.show('Joke saved.', 'success');
    } catch (err: any) {
      this.toast.show(err?.message || 'Could not save joke', 'error');
    } finally {
      this.saving.set(false);
    }
  }

  select(joke: any) {
    this.selected.set(joke);
    this.title.set(joke.title || '');
    this.content = joke.content || '';
    this.historyOpen.set(false);
  }

  async toggleSpeak() {
    const joke = this.selected() || { title: this.title().trim(), content: this.content.trim() };
    const text = [joke.title, joke.content].filter(Boolean).join('. ');
    if (!text) {
      this.toast.show('Enter a title and content first.', 'error');
      return;
    }
    if (this.speaking()) {
      stopSpeaking();
      this.speaking.set(false);
      return;
    }
    this.speaking.set(true);
    try {
      await speakText(text, { voiceId: getSavedVoiceId() });
    } catch (err: any) {
      this.toast.show(err?.message || 'Could not read the joke aloud.', 'error');
    } finally {
      this.speaking.set(false);
    }
  }

  onVoice(transcript: string) {
    const q = transcript.toLowerCase();
    const match = this.jokes().find((j) => String(j.title || '').toLowerCase().includes(q));
    if (match) {
      this.select(match);
      void this.toggleSpeak();
      return;
    }
    this.content = this.content ? `${this.content} ${transcript}` : transcript;
    this.toast.show(`No saved joke matched “${transcript}”. Spoken text was added to content.`, 'info');
  }
}

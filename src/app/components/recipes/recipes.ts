import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MarkdownPipe } from '../../pipes/markdown.pipe';
import { ClearableInputComponent } from '../shared/clearable-input/clearable-input';
import { SearchIconButtonComponent } from '../shared/search-icon-button/search-icon-button';
import { VoiceMicButtonComponent } from '../shared/voice-mic-button/voice-mic-button';
import { ToastService } from '../../services/toast.service';
import { chatWithOpenAI, parseRecipe, searchImages } from '../../services/api/client';
import { getSavedVoiceId, speakText, stopSpeaking } from '../shared/speech/speech';
import { boldDatesInMarkdown } from './bold-dates';

@Component({
  selector: 'app-recipes',
  imports: [FormsModule, MarkdownPipe, ClearableInputComponent, SearchIconButtonComponent, VoiceMicButtonComponent],
  templateUrl: './recipes.html',
})
export class RecipesComponent {
  readonly toast = inject(ToastService);
  prompt = signal('');
  recipeText = signal('');
  recipeImage = signal('');
  loading = signal(false);
  speaking = signal(false);
  imageLoading = signal(false);

  get displayMarkdown() {
    return boldDatesInMarkdown(this.recipeText());
  }

  async generate(query = this.prompt()) {
    const trimmed = query.trim();
    if (!trimmed) return;
    stopSpeaking();
    this.speaking.set(false);
    this.loading.set(true);
    this.recipeImage.set('');
    try {
      const { text } = await chatWithOpenAI({
        message: `Give me a complete recipe for: ${trimmed}. Use markdown with Ingredients and Instructions.`,
        systemPrompt:
          'You are a helpful chef. Start with the dish title as a heading, then Ingredients, then Instructions.',
      });
      this.recipeText.set(text);
      const heading = text.match(/^#{1,3}\s+(.+)$/m);
      void this.loadImage(heading?.[1]?.trim() || trimmed);
    } catch (err: any) {
      this.toast.show(err?.message || 'Recipe failed', 'error');
    } finally {
      this.loading.set(false);
    }
  }

  onSubmit(event: Event) {
    event.preventDefault();
    void this.generate();
  }

  onVoice(text: string) {
    this.prompt.set(text);
    void this.generate(text);
  }

  print() {
    window.print();
  }

  async toggleSpeak() {
    if (!this.recipeText()) return;
    if (this.speaking()) {
      stopSpeaking();
      this.speaking.set(false);
      return;
    }
    this.speaking.set(true);
    try {
      await speakText(this.recipeText(), { voiceId: getSavedVoiceId() });
    } catch (err: any) {
      this.toast.show(err?.message || 'Azure TTS failed', 'error');
    } finally {
      this.speaking.set(false);
    }
  }

  private async loadImage(subject: string) {
    this.imageLoading.set(true);
    try {
      const data = await searchImages(subject);
      const list = data?.images || data?.items || data?.results || [];
      const first = list[0] || {};
      const url = first.thumbnail || first.url || first.link || '';
      this.recipeImage.set(url);
    } catch {
      this.recipeImage.set('');
    } finally {
      this.imageLoading.set(false);
    }
  }
}

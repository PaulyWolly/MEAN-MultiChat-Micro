import { Component, OnDestroy, computed, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { HelpButtonComponent } from '../shared/help/help-button';
import { ClearableInputComponent } from '../shared/clearable-input/clearable-input';
import { ToastService } from '../../services/toast.service';
import { AiStatusService } from '../../services/ai-status.service';
import { analyzeImage, generateImage } from '../../services/api/client';
import { getSavedVoiceId, speakText, stopSpeaking } from '../shared/speech/speech';
import { ImageExpandablePreviewComponent } from './image-expandable-preview';
import { ImageLightboxModalComponent } from './image-lightbox-modal';
import { dataUrlForVision, isLikelyImageFile, normalizeImageDataUrlMime } from './image-vision';

const MAX_BYTES = 10 * 1024 * 1024;

const IMAGE_PRESETS = [
  {
    id: 'cheap',
    title: 'Fast & inexpensive',
    detail: 'gpt-image-1-mini · low quality',
  },
  {
    id: 'quality',
    title: 'Better quality',
    detail: 'gpt-image-2 · medium quality',
  },
] as const;

const IMAGE_SIZES = [
  { id: '1024x1024', label: 'Square' },
  { id: '1536x1024', label: 'Landscape' },
  { id: '1024x1536', label: 'Portrait' },
] as const;

const EXAMPLE_PROMPT =
  'A watercolor image of a man and a woman holding hands.. and walking away from the Eiffel Tower in France.. in the background.. the sun is just going down and the street lights are starting to come on.';

function suggestFileName(promptText: string) {
  const base = String(promptText || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 72);
  return base || 'generated-image';
}

function toDownloadFileName(raw: string) {
  const cleaned = String(raw || '')
    .trim()
    .replace(/\.png$/i, '')
    .replace(/[<>:"/\\|?*]+/g, '')
    .split('')
    .filter((ch) => ch.charCodeAt(0) >= 32)
    .join('')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .slice(0, 80)
    .trim();
  return `${cleaned || 'generated-image'}.png`;
}

@Component({
  selector: 'app-images',
  imports: [
    RouterLink,
    HelpButtonComponent,
    ClearableInputComponent,
    ImageExpandablePreviewComponent,
    ImageLightboxModalComponent,
  ],
  templateUrl: './images.html',
})
export class ImagesComponent implements OnDestroy {
  readonly aiStatus = inject(AiStatusService);
  readonly toast = inject(ToastService);
  readonly presets = IMAGE_PRESETS;
  readonly sizes = IMAGE_SIZES;
  readonly examplePrompt = EXAMPLE_PROMPT;

  activeTab = signal<'create' | 'describe'>('create');
  genPrompt = signal('');
  genPreset = signal<(typeof IMAGE_PRESETS)[number]['id']>('quality');
  genSize = signal<(typeof IMAGE_SIZES)[number]['id']>('1536x1024');
  genImageUrl = signal('');
  genMeta = signal<{
    model?: string;
    quality?: string;
    size?: string;
    durationMs?: number;
  } | null>(null);
  genError = signal('');
  generating = signal(false);
  saveName = signal('');

  previewUrl = signal('');
  fileName = signal('');
  analysis = signal('');
  describeError = signal('');
  analyzing = signal(false);
  speaking = signal(false);
  lightboxOpen = signal(false);
  private speakGen = 0;

  readonly canGenerate = computed(() => Boolean(this.aiStatus.status()?.signedIn));
  readonly imageUsage = computed(() => this.aiStatus.status()?.usage?.image || null);
  readonly imageDailyLimit = computed(
    () => this.aiStatus.status()?.limits?.image?.dailyLimit ?? null,
  );
  readonly downloadName = computed(() => toDownloadFileName(this.saveName()));
  readonly lightboxSrc = computed(() =>
    this.activeTab() === 'create' ? this.genImageUrl() : this.previewUrl(),
  );
  readonly lightboxAlt = computed(() =>
    this.activeTab() === 'create'
      ? this.genPrompt() || 'Generated image'
      : this.fileName() || 'Selected image',
  );

  constructor() {
    effect(() => {
      const url = this.genImageUrl();
      untracked(() => {
        this.saveName.set(url ? suggestFileName(this.genPrompt()) : '');
      });
    });
  }

  ngOnDestroy() {
    this.stopSpeak();
  }

  setTab(tab: 'create' | 'describe') {
    if (tab !== 'describe') this.stopSpeak();
    this.activeTab.set(tab);
    this.lightboxOpen.set(false);
  }

  stopSpeak() {
    this.speakGen += 1;
    stopSpeaking();
    this.speaking.set(false);
  }

  toggleSpeak() {
    if (this.speaking()) {
      this.stopSpeak();
      return;
    }
    void this.speakAnalysis(this.analysis());
  }

  async speakAnalysis(text: string) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return;
    const gen = ++this.speakGen;
    this.speaking.set(true);
    try {
      await speakText(trimmed, { voiceId: getSavedVoiceId() });
    } catch (err: any) {
      if (gen === this.speakGen) {
        this.toast.show(err?.message || 'Azure TTS failed', 'error');
      }
    } finally {
      if (gen === this.speakGen) this.speaking.set(false);
    }
  }

  useExamplePrompt() {
    this.genPrompt.set(EXAMPLE_PROMPT);
  }

  onPromptKeyDown(event: KeyboardEvent) {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    if (this.generating() || !this.genPrompt().trim() || !this.canGenerate()) return;
    void this.generate();
  }

  clearGenerate() {
    this.genPrompt.set('');
    this.genImageUrl.set('');
    this.genMeta.set(null);
    this.genError.set('');
    this.generating.set(false);
    this.lightboxOpen.set(false);
  }

  async generate() {
    const prompt = this.genPrompt().trim();
    if (!prompt || !this.canGenerate()) return;
    this.generating.set(true);
    this.genError.set('');
    this.genImageUrl.set('');
    this.genMeta.set(null);
    try {
      const data = await generateImage({
        prompt,
        preset: this.genPreset(),
        size: this.genSize(),
      } as any);
      this.genImageUrl.set(data.image || '');
      this.genMeta.set({
        model: data.model,
        quality: data.quality,
        size: data.size,
        durationMs: data.durationMs,
      });
    } catch (err: any) {
      this.genError.set(
        err.reason === 'anonymous'
          ? 'Sign in to generate images — guest sessions do not have a generation allowance.'
          : err.message || 'Image generation failed',
      );
    } finally {
      this.generating.set(false);
      void this.aiStatus.refresh();
    }
  }

  onFile(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (!isLikelyImageFile(file)) {
      this.describeError.set('Please choose an image file (JPEG, PNG, WebP, etc.).');
      return;
    }
    if (file.size > MAX_BYTES) {
      this.describeError.set('That image is too large (max 10MB). Try a smaller photo.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = normalizeImageDataUrlMime(String(reader.result || ''));
      if (!dataUrl.startsWith('data:image')) {
        this.describeError.set('Could not read that image.');
        return;
      }
      this.describeError.set('');
      this.stopSpeak();
      this.analysis.set('');
      this.fileName.set(file.name);
      this.previewUrl.set(dataUrl);
    };
    reader.onerror = () => this.describeError.set('Could not read that image.');
    reader.readAsDataURL(file);
  }

  clearDescribe() {
    this.stopSpeak();
    this.previewUrl.set('');
    this.fileName.set('');
    this.analysis.set('');
    this.describeError.set('');
    this.lightboxOpen.set(false);
  }

  async describe() {
    if (!this.previewUrl()) return;
    this.stopSpeak();
    this.analyzing.set(true);
    this.describeError.set('');
    this.analysis.set('');
    try {
      // Re-encode to image/jpeg — OpenAI rejects image/jpg and some raw JPEGs.
      const visionImage = await dataUrlForVision(this.previewUrl());
      const text = await analyzeImage({
        image: visionImage,
        prompt: 'Describe this image in detail.',
      });
      const description = text || 'No description returned.';
      this.analysis.set(description);
      void this.speakAnalysis(description);
    } catch (err: any) {
      this.describeError.set(err?.message || 'Image analysis failed');
    } finally {
      this.analyzing.set(false);
    }
  }
}
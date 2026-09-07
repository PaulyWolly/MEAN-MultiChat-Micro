import { Component, OnInit, input, output, signal } from '@angular/core';
import { chatImageSrcCandidates } from './chat-images';

export type ChatGalleryImage = {
  url?: string;
  thumb?: string;
  originalUrl?: string;
  title?: string;
};

@Component({
  selector: 'app-chat-image-thumb',
  template: `
    @if (!hidden()) {
      <button
        type="button"
        class="chat-image-thumb"
        role="listitem"
        (click)="opened.emit()"
        [title]="img().title || 'Open image'"
      >
        <img
          [src]="currentSrc()"
          [alt]="img().title || 'Image ' + (index() + 1)"
          loading="eager"
          referrerpolicy="no-referrer"
          (load)="loaded.emit()"
          (error)="onError()"
        />
      </button>
    }
  `,
})
export class ChatImageThumbComponent implements OnInit {
  img = input.required<ChatGalleryImage>();
  index = input(0);

  opened = output();
  loaded = output();

  srcIndex = signal(0);
  hidden = signal(false);

  private candidates: string[] = [];

  ngOnInit() {
    this.candidates = chatImageSrcCandidates(this.img());
    if (this.candidates.length === 0) {
      this.hidden.set(true);
    }
  }

  currentSrc() {
    const list = this.candidates.length
      ? this.candidates
      : chatImageSrcCandidates(this.img());
    const i = this.srcIndex();
    return list[Math.min(i, list.length - 1)] || '';
  }

  onError() {
    const list = this.candidates.length
      ? this.candidates
      : chatImageSrcCandidates(this.img());
    if (this.srcIndex() + 1 < list.length) {
      this.srcIndex.update((n) => n + 1);
    } else {
      this.hidden.set(true);
    }
  }
}

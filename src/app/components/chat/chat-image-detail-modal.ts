import { DOCUMENT } from '@angular/common';
import {
  AfterViewInit,
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { ModalCloseButtonComponent } from '../shared/modal-close-button/modal-close-button';
import type { ChatGalleryImage } from './chat-image-thumb';

@Component({
  selector: 'app-chat-image-detail-modal',
  imports: [ModalCloseButtonComponent],
  template: `
    @if (image()) {
      <div
        class="chat-image-modal-backdrop"
        role="presentation"
        (click)="closeFromBackdrop($event)"
      >
        <div
          class="chat-image-modal"
          role="dialog"
          aria-modal="true"
          [attr.aria-label]="image()?.title || 'Image detail'"
          (click)="$event.stopPropagation()"
        >
          <header class="chat-image-modal-header">
            <h3>
              {{ image()?.title || 'Image' }}
              @if (hasGallery()) {
                <span class="chat-image-modal-count">
                  ({{ index() + 1 }} / {{ list().length }})
                </span>
              }
            </h3>
            <app-modal-close-button (close)="closed.emit()" />
          </header>
          <div class="chat-image-modal-body">
            @if (hasGallery()) {
              <button
                type="button"
                class="chat-image-nav chat-image-nav-prev"
                aria-label="Previous image"
                (click)="prev()"
              >
                ‹
              </button>
            }
            @if (src()) {
              @for (slide of [index()]; track slide) {
                <img
                  [src]="src()"
                  [alt]="image()?.title || ''"
                  class="chat-image-modal-img"
                  referrerpolicy="no-referrer"
                  [style.width.px]="box()?.w"
                  [style.height.px]="box()?.h"
                  style="max-width: min(95vw, 130%); max-height: 85vh"
                  (load)="onLoad($event)"
                  (error)="onError()"
                />
              }
            } @else {
              <p class="hint">Image unavailable.</p>
            }
            @if (hasGallery()) {
              <button
                type="button"
                class="chat-image-nav chat-image-nav-next"
                aria-label="Next image"
                (click)="next()"
              >
                ›
              </button>
            }
          </div>
        </div>
      </div>
    }
  `,
})
export class ChatImageDetailModalComponent implements AfterViewInit, OnDestroy {
  private readonly document = inject(DOCUMENT);
  private readonly host = inject(ElementRef<HTMLElement>);

  images = input<ChatGalleryImage[]>([]);
  initialIndex = input(0);
  closed = output();

  index = signal(0);
  src = signal('');
  box = signal<{ w: number; h: number } | null>(null);
  usedFallback = signal(false);

  list = signal<ChatGalleryImage[]>([]);
  image = signal<ChatGalleryImage | null>(null);
  hasGallery = signal(false);

  constructor() {
    effect(() => {
      const imgs = (this.images() || []).filter(Boolean);
      this.list.set(imgs);
      const i = Math.min(
        Math.max(0, this.initialIndex()),
        Math.max(0, imgs.length - 1),
      );
      this.index.set(i);
      this.hasGallery.set(imgs.length > 1);
      // syncImage reads index(); untracked so prev/next does not reset to initialIndex
      untracked(() => this.syncImage());
    });
  }

  ngAfterViewInit() {
    this.document.body.appendChild(this.host.nativeElement);
  }

  ngOnDestroy() {
    this.host.nativeElement.remove();
  }

  @HostListener('document:keydown.escape')
  onEscape() {
    this.closed.emit();
  }

  @HostListener('document:keydown.arrowleft')
  onArrowLeft() {
    if (this.hasGallery()) this.prev();
  }

  @HostListener('document:keydown.arrowright')
  onArrowRight() {
    if (this.hasGallery()) this.next();
  }

  closeFromBackdrop(event: MouseEvent) {
    if (event.target === event.currentTarget) this.closed.emit();
  }

  prev() {
    const len = this.list().length;
    if (len <= 1) return;
    this.index.update((i) => (i - 1 + len) % len);
    this.syncImage();
  }

  next() {
    const len = this.list().length;
    if (len <= 1) return;
    this.index.update((i) => (i + 1) % len);
    this.syncImage();
  }

  private syncImage() {
    const img = this.list()[this.index()] || null;
    this.image.set(img);
    this.box.set(null);
    this.usedFallback.set(false);
    this.src.set(img?.url || img?.thumb || '');
  }

  onLoad(event: Event) {
    const el = event.currentTarget as HTMLImageElement;
    this.box.set({
      w: Math.round(el.naturalWidth * 1.3),
      h: Math.round(el.naturalHeight * 1.3),
    });
  }

  onError() {
    const img = this.image();
    const current = this.src();
    if (!img || this.usedFallback()) return;
    const fallbacks = [img.thumb, img.originalUrl].filter(
      (u): u is string => Boolean(u && u !== current),
    );
    const next = fallbacks[0];
    if (next) {
      this.usedFallback.set(true);
      this.box.set(null);
      this.src.set(next);
    }
  }
}

import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  input,
  signal,
  viewChild,
} from '@angular/core';

function measureThumb(el: HTMLElement) {
  const { scrollTop, scrollHeight, clientHeight } = el;
  if (scrollHeight <= clientHeight + 2) {
    return { top: 0, height: 0, visible: false };
  }
  const track = Math.max(0, clientHeight - 8);
  const height = Math.max(36, (clientHeight / scrollHeight) * track);
  const maxTop = track - height;
  const scrollRange = scrollHeight - clientHeight;
  const top = scrollRange > 0 ? 4 + (scrollTop / scrollRange) * maxTop : 4;
  return { top, height, visible: true };
}

/**
 * Custom scroll rail for Playlist Manager.
 * Host element IS the .playlist-scroll-area panel (same as MERN root div).
 * Pass panel modifiers via class on the host, e.g. class="playlist-videos-scroll".
 */
@Component({
  selector: 'app-playlist-scroll-area',
  templateUrl: './playlist-scroll-area.html',
  host: {
    class: 'playlist-scroll-area',
    '[class.is-dragging]': 'dragging()',
  },
})
export class PlaylistScrollAreaComponent implements AfterViewInit, OnDestroy {
  viewportClass = input('');
  ariaLabel = input<string | undefined>(undefined);

  private readonly viewportRef = viewChild<ElementRef<HTMLElement>>('viewport');

  readonly thumbTop = signal(0);
  readonly thumbHeight = signal(0);
  readonly thumbVisible = signal(false);
  readonly dragging = signal(false);

  private ro: ResizeObserver | null = null;
  private mo: MutationObserver | null = null;
  private scrollEl: HTMLElement | null = null;
  private dragPointerId = -1;
  private dragStartY = 0;
  private dragStartScroll = 0;
  private onScroll = () => this.sync();

  ngAfterViewInit() {
    const el = this.viewportRef()?.nativeElement;
    if (!el) return;
    this.scrollEl = el;
    this.sync();
    el.addEventListener('scroll', this.onScroll, { passive: true });
    this.ro = new ResizeObserver(() => this.sync());
    this.ro.observe(el);
    const host = el.parentElement;
    if (host) this.ro.observe(host);
    this.mo = new MutationObserver(() => this.sync());
    this.mo.observe(el, { childList: true, subtree: true, characterData: true });
    requestAnimationFrame(() => this.sync());
  }

  ngOnDestroy() {
    this.scrollEl?.removeEventListener('scroll', this.onScroll);
    this.ro?.disconnect();
    this.mo?.disconnect();
    this.dragging.set(false);
  }

  onThumbPointerDown(event: PointerEvent) {
    const el = this.scrollEl;
    if (!el || !this.thumbVisible()) return;
    event.preventDefault();
    event.stopPropagation();
    this.dragging.set(true);
    this.dragPointerId = event.pointerId;
    this.dragStartY = event.clientY;
    this.dragStartScroll = el.scrollTop;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  onThumbPointerMove(event: PointerEvent) {
    const el = this.scrollEl;
    if (!this.dragging() || event.pointerId !== this.dragPointerId || !el) return;
    event.preventDefault();
    const maxTravel = this.thumbTravel(el);
    const scrollRange = el.scrollHeight - el.clientHeight;
    if (maxTravel <= 0 || scrollRange <= 0) return;
    const dy = event.clientY - this.dragStartY;
    el.scrollTop = this.dragStartScroll + (dy / maxTravel) * scrollRange;
  }

  endThumbDrag(event: PointerEvent) {
    if (event.pointerId !== this.dragPointerId) return;
    this.dragging.set(false);
    this.dragPointerId = -1;
  }

  onRailPointerDown(event: PointerEvent) {
    const el = this.scrollEl;
    if (!el || !this.thumbVisible() || event.button !== 0) return;
    const rail = event.currentTarget as HTMLElement;
    const y = event.clientY - rail.getBoundingClientRect().top;
    const maxTravel = this.thumbTravel(el);
    const scrollRange = el.scrollHeight - el.clientHeight;
    if (maxTravel <= 0 || scrollRange <= 0) return;
    const thumbTop = Math.min(maxTravel, Math.max(0, y - this.thumbHeight() / 2));
    el.scrollTop = (thumbTop / maxTravel) * scrollRange;
  }

  private thumbTravel(el: HTMLElement) {
    const track = Math.max(0, el.clientHeight - 8);
    return Math.max(1, track - this.thumbHeight());
  }

  private sync() {
    const el = this.scrollEl;
    if (!el) return;
    const m = measureThumb(el);
    this.thumbTop.set(m.top);
    this.thumbHeight.set(m.height);
    this.thumbVisible.set(m.visible);
  }
}

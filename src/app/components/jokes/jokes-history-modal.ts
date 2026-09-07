import { DOCUMENT } from '@angular/common';
import {
  AfterViewInit,
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { ClearableInputComponent } from '../shared/clearable-input/clearable-input';
import { ModalCloseButtonComponent } from '../shared/modal-close-button/modal-close-button';

function formatWhen(value: string | number | Date) {
  if (!value) return '';
  try {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

function normalizeJokeTitle(title: string) {
  return String(title || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Keep one row per title (newest wins). Same joke saved twice should not appear twice. */
export function dedupeJokesByTitle(items: any[]) {
  const byTitle = new Map<string, any>();
  for (const joke of items || []) {
    const key = normalizeJokeTitle(joke?.title) || String(joke?._id || '');
    if (!key) continue;
    const existing = byTitle.get(key);
    if (!existing) {
      byTitle.set(key, joke);
      continue;
    }
    const nextTime = new Date(joke.dateCreated || 0).getTime();
    const prevTime = new Date(existing.dateCreated || 0).getTime();
    if (nextTime >= prevTime) byTitle.set(key, joke);
  }
  return [...byTitle.values()];
}

@Component({
  selector: 'app-jokes-history-modal',
  imports: [ClearableInputComponent, ModalCloseButtonComponent],
  templateUrl: './jokes-history-modal.html',
})
export class JokesHistoryModalComponent implements AfterViewInit, OnDestroy {
  private readonly document = inject(DOCUMENT);
  private readonly host = inject(ElementRef<HTMLElement>);

  open = input(false);
  items = input<any[]>([]);
  activeId = input('');
  closed = output();
  selected = output<any>();
  refreshed = output();

  filter = signal('');
  sortMode = signal<'recent' | 'alpha'>('recent');

  constructor() {
    effect(() => {
      if (!this.open()) {
        this.filter.set('');
        this.sortMode.set('recent');
      }
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
    if (this.open()) this.closed.emit();
  }

  readonly uniqueItems = computed(() => dedupeJokesByTitle(this.items() || []));

  readonly filtered = computed(() => {
    const f = this.filter().trim().toLowerCase();
    let list = [...this.uniqueItems()];
    if (f) {
      list = list.filter((joke) => {
        const title = String(joke.title || '').toLowerCase();
        const content = String(joke.content || '').toLowerCase();
        return title.includes(f) || content.includes(f);
      });
    }
    if (this.sortMode() === 'alpha') {
      list.sort((a, b) =>
        String(a.title || '').localeCompare(String(b.title || ''), undefined, {
          sensitivity: 'base',
        }),
      );
    } else {
      list.sort(
        (a, b) =>
          new Date(b.dateCreated || 0).getTime() - new Date(a.dateCreated || 0).getTime(),
      );
    }
    return list;
  });

  formatWhen(value: string | number | Date) {
    return formatWhen(value);
  }

  preview(joke: any) {
    const full = String(joke?.content || '')
      .replace(/\s+/g, ' ')
      .trim();
    const max = 42;
    if (full.length <= max) return full;
    return `${full.slice(0, max).trimEnd()}…`;
  }

  isActive(joke: any) {
    const active = this.activeId();
    if (!active) return false;
    return String(joke._id) === String(active) || joke.title === active;
  }
}

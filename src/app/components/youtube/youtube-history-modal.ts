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
import { formatYouTubeHistoryLabel } from './youtube-query-clean';

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

@Component({
  selector: 'app-youtube-history-modal',
  imports: [ClearableInputComponent, ModalCloseButtonComponent],
  templateUrl: './youtube-history-modal.html',
})
export class YouTubeHistoryModalComponent implements AfterViewInit, OnDestroy {
  private readonly document = inject(DOCUMENT);
  private readonly host = inject(ElementRef<HTMLElement>);

  open = input(false);
  items = input<any[]>([]);
  activeQuery = input('');
  loadError = input('');
  closed = output();
  selected = output<any>();
  refreshed = output();
  saveRequested = output<any>();
  unsaveRequested = output<any>();
  deleteRequested = output<any>();

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

  readonly filtered = computed(() => {
    const f = this.filter().trim().toLowerCase();
    let list = [...(this.items() || [])];
    if (f) {
      list = list.filter((item) => {
        const label = this.itemLabel(item).toLowerCase();
        const query = String(item.query || '')
          .toLowerCase()
          .replace(/\./g, ' ');
        return label.includes(f) || query.includes(f);
      });
    }
    if (this.sortMode() === 'alpha') {
      list.sort((a, b) =>
        this.itemLabel(a).localeCompare(this.itemLabel(b), undefined, {
          sensitivity: 'base',
        }),
      );
    } else {
      list.sort(
        (a, b) =>
          new Date(b.lastSearched || b.dateCreated || 0).getTime() -
          new Date(a.lastSearched || a.dateCreated || 0).getTime(),
      );
    }
    return list;
  });

  itemLabel(item: any) {
    return formatYouTubeHistoryLabel(item) || 'Untitled';
  }

  formatWhen(value: string | number | Date) {
    return formatWhen(value);
  }

  isActive(item: any) {
    const active = this.activeQuery();
    if (!active) return false;
    const label = this.itemLabel(item);
    return (
      label.toLowerCase() === active.toLowerCase() ||
      String(item.query || '').toLowerCase() === active.toLowerCase()
    );
  }

  pageLabel(item: any) {
    const pages = Number(item?.totalPages);
    if (Number.isFinite(pages) && pages > 0) {
      return ` · ${pages} page${pages === 1 ? '' : 's'}`;
    }
    if (item?.videoCount != null) {
      return ` · ${item.videoCount} videos`;
    }
    return '';
  }

  onSaveToggle(item: any) {
    if (item?.isSaved) this.unsaveRequested.emit(item);
    else this.saveRequested.emit(item);
  }
}

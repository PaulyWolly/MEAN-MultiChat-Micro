import { DOCUMENT } from '@angular/common';
import {
  AfterViewInit,
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { ClearableInputComponent } from '../shared/clearable-input/clearable-input';
import { ModalCloseButtonComponent } from '../shared/modal-close-button/modal-close-button';

function formatWhen(value: string) {
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
  selector: 'app-chat-history-modal',
  imports: [ClearableInputComponent, ModalCloseButtonComponent],
  templateUrl: './chat-history-modal.html',
})
export class ChatHistoryModalComponent implements AfterViewInit, OnDestroy {
  private readonly document = inject(DOCUMENT);
  private readonly host = inject(ElementRef<HTMLElement>);

  open = input(false);
  items = input<any[]>([]);
  activeId = input('');
  loadError = input('');
  closed = output();
  selected = output<any>();
  refreshed = output();
  deleteRequested = output<any>();

  filter = signal('');
  sortMode = signal<'recent' | 'alpha'>('recent');

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
      list = list.filter((c) => {
        const title = String(c.title || '').toLowerCase();
        const preview = String(c.preview || '').toLowerCase();
        return title.includes(f) || preview.includes(f);
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
          new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime(),
      );
    }
    return list;
  });

  formatWhen(value: string) {
    return formatWhen(value);
  }

  isActive(item: any) {
    const id = this.activeId();
    return Boolean(id && String(item?._id) === String(id));
  }

  preview(item: any) {
    return String(item?.preview || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 90);
  }
}

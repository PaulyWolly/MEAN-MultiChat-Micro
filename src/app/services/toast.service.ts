import { Injectable, signal } from '@angular/core';

export type ToastTone = 'info' | 'success' | 'error';

export interface AppToast {
  id: string;
  message: string;
  tone: ToastTone;
}

@Injectable({ providedIn: 'root' })
export class ToastService {
  private seq = 0;
  private readonly timers = new Map<string, number>();
  readonly toasts = signal<AppToast[]>([]);

  show(message: string, tone: ToastTone = 'info', duration?: number) {
    const text = String(message || '').trim();
    if (!text) return null;

    const id = `toast-${++this.seq}`;
    const ms =
      typeof duration === 'number'
        ? duration
        : tone === 'error'
          ? 8000
          : tone === 'success'
            ? 20_000
            : 6000;

    this.toasts.update((prev) => [...prev.slice(-4), { id, message: text, tone }]);

    if (ms > 0) {
      const timer = window.setTimeout(() => this.dismiss(id), ms);
      this.timers.set(id, timer);
    }
    return id;
  }

  dismiss(id: string) {
    const timer = this.timers.get(id);
    if (timer) {
      window.clearTimeout(timer);
      this.timers.delete(id);
    }
    this.toasts.update((prev) => prev.filter((t) => t.id !== id));
  }
}

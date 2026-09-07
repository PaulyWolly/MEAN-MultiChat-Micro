import { Injectable, signal } from '@angular/core';
import { getAiStatus } from './api/client';

@Injectable({ providedIn: 'root' })
export class AiStatusService {
  readonly status = signal<any>(null);
  readonly error = signal('');
  readonly loading = signal(true);

  private inFlight: Promise<any> | null = null;

  constructor() {
    void this.refresh();
  }

  reset() {
    this.status.set(null);
    this.error.set('');
    this.loading.set(true);
    this.inFlight = null;
    void this.refresh();
  }

  async refresh() {
    if (this.inFlight) return this.inFlight;
    this.loading.set(true);
    this.inFlight = getAiStatus()
      .then((next: any) => {
        this.status.set(next);
        this.error.set('');
        return next;
      })
      .catch((err: any) => {
        this.error.set(err?.message || 'Could not load AI status');
        return null;
      })
      .finally(() => {
        this.loading.set(false);
        this.inFlight = null;
      });
    return this.inFlight;
  }
}

import { Injectable, inject, OnDestroy } from '@angular/core';
import { environment } from '../../environments/environment';
import { getActiveDataKey } from '../components/login/auth-storage';

/**
 * Opens GET /api/chat SSE so the gateway prints the familiar in-place
 * terminal heartbeat (♡ / ❤️ / 💗). Without this, the route never runs.
 */
@Injectable({ providedIn: 'root' })
export class ChatHeartbeatService implements OnDestroy {
  private source: EventSource | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.source?.close();
    this.source = null;
  }

  ngOnDestroy() {
    this.stop();
  }

  private connect() {
    if (this.stopped || typeof EventSource === 'undefined') return;
    this.source?.close();

    // Prefer gatewayBase so SSE does not go through the Vite/Angular http proxy.
    const base = String(
      (environment as { gatewayBase?: string }).gatewayBase ||
        environment.apiBase ||
        '',
    ).replace(/\/$/, '');
    const sessionId = encodeURIComponent(getActiveDataKey() || 'anonymous');
    const url = `${base}/api/chat?sessionId=${sessionId}`;

    try {
      const es = new EventSource(url);
      this.source = es;
      es.onerror = () => {
        es.close();
        if (this.source === es) this.source = null;
        if (this.stopped) return;
        this.reconnectTimer = setTimeout(() => this.connect(), 4000);
      };
    } catch {
      if (!this.stopped) {
        this.reconnectTimer = setTimeout(() => this.connect(), 4000);
      }
    }
  }
}

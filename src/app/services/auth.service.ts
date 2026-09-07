import { Injectable, computed, inject, signal } from '@angular/core';
import {
  login as apiLogin,
  loginWithOAuth as apiLoginWithOAuth,
  register as apiRegister,
  verifyToken,
} from './api/client';
import {
  GUEST_DATA_KEY,
  LEGACY_DATA_KEY,
  clearAuthSession,
  clearGuestMode,
  enterGuestMode as persistGuestMode,
  getActiveDataKey,
  getStoredDataKey,
  getStoredToken,
  getStoredUser,
  isGuestMode,
  persistAuthSession,
} from '../components/login/auth-storage';
import { AiStatusService } from './ai-status.service';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly aiStatus = inject(AiStatusService);

  readonly ready = signal(false);
  readonly token = signal(getStoredToken());
  readonly user = signal<any>(getStoredUser());
  readonly isGuest = signal(isGuestMode());
  readonly dataKey = signal(getActiveDataKey());

  readonly isAuthenticated = computed(() => Boolean(this.token() && this.user()));
  readonly hasAppAccess = computed(() => this.isAuthenticated() || this.isGuest());

  constructor() {
    void this.hydrate();
  }

  private applySession(nextToken: string, nextUser: any) {
    persistAuthSession({ token: nextToken, user: nextUser });
    this.token.set(nextToken || '');
    this.user.set(nextUser || null);
    this.isGuest.set(false);
    this.dataKey.set(nextUser?.dataKey || getStoredDataKey() || LEGACY_DATA_KEY);
    this.aiStatus.reset();
  }

  logout() {
    clearAuthSession();
    clearGuestMode();
    this.token.set('');
    this.user.set(null);
    this.isGuest.set(false);
    this.dataKey.set(LEGACY_DATA_KEY);
    this.aiStatus.reset();
  }

  enterGuestMode() {
    persistGuestMode();
    this.token.set('');
    this.user.set(null);
    this.isGuest.set(true);
    this.dataKey.set(GUEST_DATA_KEY);
    this.aiStatus.reset();
  }

  async login(payload: { email: string; password: string }) {
    const data = await apiLogin(payload);
    const nextToken = data.token || data.accessToken;
    if (!nextToken || !data.user) {
      throw new Error(data.message || 'Login failed');
    }
    this.applySession(nextToken, data.user);
    return data;
  }

  async register(payload: { email: string; password: string }) {
    const data = await apiRegister(payload);
    const nextToken = data.token || data.accessToken;
    if (!nextToken || !data.user) {
      throw new Error(data.message || 'Registration failed');
    }
    this.applySession(nextToken, data.user);
    return data;
  }

  async loginWithOAuth(payload: { accessToken?: string; idToken?: string } = {}) {
    const data = await apiLoginWithOAuth(payload);
    const nextToken = data.token || data.accessToken;
    if (!nextToken || !data.user) {
      throw new Error(data.message || 'Social login failed');
    }
    this.applySession(nextToken, data.user);
    return data;
  }

  async refreshSession() {
    const existing = getStoredToken();
    if (!existing) return false;
    try {
      const data = await verifyToken(existing);
      if (data?.success && data.user) {
        this.applySession(data.token || existing, data.user);
        return true;
      }
    } catch {
      /* fall through */
    }
    this.logout();
    return false;
  }

  private async hydrate() {
    const existing = getStoredToken();
    if (!existing) {
      this.isGuest.set(isGuestMode());
      this.dataKey.set(getActiveDataKey());
      this.ready.set(true);
      return;
    }
    try {
      const data = await verifyToken(existing);
      if (data?.success && data.user) {
        this.applySession(data.token || existing, data.user);
      } else {
        this.logout();
      }
    } catch {
      this.logout();
    } finally {
      this.ready.set(true);
    }
  }
}

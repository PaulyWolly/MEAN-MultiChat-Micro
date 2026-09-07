import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../../services/auth.service';
import { getAuth0Config, getGoogleOAuthConfig, parseOAuthRedirectHash, startGoogleLogin } from './oauth-login';
import { getLoginMethodParts } from './auth-display';
import { ModalCloseButtonComponent } from '../shared/modal-close-button/modal-close-button';

@Component({
  selector: 'app-login',
  imports: [FormsModule, ModalCloseButtonComponent],
  templateUrl: './login.html',
})
export class LoginComponent implements OnInit {
  readonly auth = inject(AuthService);
  readonly router = inject(Router);

  step = signal<'chooser' | 'jwt' | 'social'>('chooser');
  mode = signal<'login' | 'register'>('login');
  email = '';
  password = '';
  error = signal('');
  loading = signal(false);
  oauthBusy = signal(false);
  guestUpgrading = signal(false);

  get socialReady() {
    return getAuth0Config().configured || getGoogleOAuthConfig().configured;
  }

  get loginParts() {
    return getLoginMethodParts(this.auth.user());
  }

  ngOnInit() {
    void this.handleOAuthReturn();
  }

  private async handleOAuthReturn() {
    if (!this.auth.ready()) return;
    const result = parseOAuthRedirectHash();
    if (!result) return;
    if (result.error) {
      this.step.set('social');
      this.guestUpgrading.set(true);
      this.error.set(result.errorDescription || result.error || 'Social login was cancelled or failed');
      return;
    }
    if (!result.accessToken && !result.idToken) return;
    this.oauthBusy.set(true);
    this.error.set('');
    this.step.set('social');
    try {
      await this.auth.loginWithOAuth({
        accessToken: result.accessToken,
        idToken: result.idToken,
      });
      await this.router.navigateByUrl('/', { replaceUrl: true });
    } catch (err: any) {
      this.guestUpgrading.set(true);
      this.error.set(err?.message || 'Social login failed');
    } finally {
      this.oauthBusy.set(false);
    }
  }

  continueAsGuest() {
    this.auth.enterGuestMode();
    this.guestUpgrading.set(false);
    void this.router.navigateByUrl('/', { replaceUrl: true });
  }

  async submit() {
    this.loading.set(true);
    this.error.set('');
    try {
      if (this.mode() === 'register') {
        await this.auth.register({ email: this.email, password: this.password });
      } else {
        await this.auth.login({ email: this.email, password: this.password });
      }
      this.guestUpgrading.set(false);
      await this.router.navigateByUrl('/', { replaceUrl: true });
    } catch (err: any) {
      this.error.set(err?.message || 'Login failed');
    } finally {
      this.loading.set(false);
    }
  }

  googleLogin() {
    this.error.set('');
    try {
      startGoogleLogin();
    } catch (err: any) {
      this.step.set('social');
      this.error.set(err?.message || 'Google sign-in failed');
    }
  }

  signOut() {
    this.auth.logout();
    this.error.set('');
    this.guestUpgrading.set(false);
    this.step.set('chooser');
    void this.router.navigateByUrl('/login', { replaceUrl: true });
  }
}

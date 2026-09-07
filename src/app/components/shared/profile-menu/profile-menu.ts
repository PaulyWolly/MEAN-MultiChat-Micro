import { Component, HostListener, effect, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../../services/auth.service';
import { AppStateService } from '../../../services/app-state.service';
import { fetchAllPersonalInfo, savePersonalInfoType } from '../../../services/api/client';
import { SERVER_VOICES, saveVoiceId, speakText } from '../speech/speech';
import { firstNameFromProfile, initialsFromProfile } from '../profile/profile-image';
import { MyProfileModalComponent } from '../profile/my-profile-modal';

@Component({
  selector: 'app-profile-menu',
  imports: [RouterLink, MyProfileModalComponent],
  templateUrl: './profile-menu.html',
})
export class ProfileMenuComponent {
  readonly auth = inject(AuthService);
  readonly appState = inject(AppStateService);
  private readonly router = inject(Router);

  open = signal(false);
  profileOpen = signal(false);
  profile = signal<any>({});
  previewing = signal(false);
  previewError = signal('');
  readonly voices = SERVER_VOICES;

  constructor() {
    effect(() => {
      this.auth.isAuthenticated();
      this.auth.user();
      this.auth.dataKey();
      void this.loadProfile();
    });
  }

  get avatarUrl() {
    const avatar = this.profile()?.avatar;
    return typeof avatar === 'string' && avatar.startsWith('data:image') ? avatar : '';
  }

  get initials() {
    return initialsFromProfile(this.profile(), this.auth.user());
  }

  get welcomeLabel() {
    if (!this.auth.isAuthenticated()) return '';
    const first = firstNameFromProfile(this.profile(), this.auth.user());
    return first ? `Welcome ${first}` : '';
  }

  @HostListener('document:keydown.escape')
  onEscape() {
    this.open.set(false);
  }

  async loadProfile() {
    try {
      const data = await fetchAllPersonalInfo();
      this.profile.set(data && typeof data === 'object' ? data : {});
    } catch {
      this.profile.set({});
    }
  }

  onVoiceChange(event: Event) {
    const id = (event.target as HTMLSelectElement).value;
    this.appState.setVoiceId(id);
    saveVoiceId(id);
    this.previewError.set('');
  }

  onModelChange(event: Event) {
    this.appState.setModel((event.target as HTMLSelectElement).value);
  }

  async previewVoice() {
    this.previewError.set('');
    this.previewing.set(true);
    try {
      await speakText('Hello — this is a preview of the selected Azure neural voice.', {
        voiceId: this.appState.selectedVoiceId(),
      });
    } catch (err: any) {
      this.previewError.set(err?.message || 'Azure TTS failed');
    } finally {
      this.previewing.set(false);
    }
  }

  clearChat() {
    this.appState.requestClearChat();
    this.open.set(false);
  }

  openProfile() {
    this.open.set(false);
    this.profileOpen.set(true);
  }

  async onProfileSaved(nextProfile: any) {
    this.profile.set(nextProfile || {});
    if (nextProfile?.avatar) {
      try {
        await savePersonalInfoType('avatar', nextProfile.avatar);
      } catch {
        /* modal already reported */
      }
    }
  }

  signOut() {
    this.auth.logout();
    this.open.set(false);
    void this.router.navigateByUrl('/login');
  }
}

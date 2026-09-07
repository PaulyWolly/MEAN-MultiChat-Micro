import { DOCUMENT } from '@angular/common';
import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../../services/auth.service';
import {
  deletePersonalInfoType,
  fetchAllPersonalInfo,
  savePersonalInfoType,
} from '../../../services/api/client';
import { getLoginMethodParts } from '../../login/auth-display';
import { setCachedUserName } from './personal-info';
import { fileToAvatarDataUrl, initialsFromProfile } from './profile-image';
import { ConfirmModalComponent } from '../confirm-modal/confirm-modal';
import { ModalCloseButtonComponent } from '../modal-close-button/modal-close-button';

const EDITABLE_FIELDS = [
  { key: 'name', label: 'Name', placeholder: 'Your name' },
  { key: 'favorite_hobby', label: 'Favorite hobby', placeholder: 'e.g. playing guitar' },
  { key: 'favorite_color', label: 'Favorite color', placeholder: 'e.g. blue' },
  { key: 'food_preference', label: 'Food preference', placeholder: 'e.g. pickles' },
  { key: 'location', label: 'Location', placeholder: 'City or region' },
];

/** Photo is edited in the avatar block, not as a text field. */
function isSystemKey(key: string) {
  return key === 'avatar';
}

function fieldLabel(key: string) {
  const known = EDITABLE_FIELDS.find((f) => f.key === key);
  if (known) return known.label;
  return String(key || '').replace(/_/g, ' ');
}

@Component({
  selector: 'app-my-profile-modal',
  imports: [FormsModule, ConfirmModalComponent, ModalCloseButtonComponent],
  templateUrl: './my-profile-modal.html',
})
export class MyProfileModalComponent implements AfterViewInit, OnDestroy {
  private readonly document = inject(DOCUMENT);
  private readonly host = inject(ElementRef<HTMLElement>);
  readonly auth = inject(AuthService);

  open = input(false);
  initialProfile = input<any>({});
  readOnly = input(false);
  closed = output();
  saved = output<any>();

  draft = signal<Record<string, any>>({});
  customKey = '';
  customValue = '';
  saving = signal(false);
  error = signal('');
  message = signal('');
  pendingDelete = signal<{ key: string; label: string; value: string } | null>(null);
  deleting = signal(false);
  editingKeys = signal<string[]>([]);

  ngAfterViewInit() {
    this.document.body.appendChild(this.host.nativeElement);
  }

  ngOnDestroy() {
    this.host.nativeElement.remove();
  }

  constructor() {
    effect(() => {
      if (!this.open()) return;
      this.error.set('');
      this.message.set('');
      this.customKey = '';
      this.customValue = '';
      this.pendingDelete.set(null);
      this.editingKeys.set([]);
      this.draft.set({ ...(this.initialProfile() || {}) });
      void this.refreshProfile();
    });
  }

  get avatarUrl() {
    const avatar = this.draft()['avatar'];
    return typeof avatar === 'string' && avatar.startsWith('data:image') ? avatar : '';
  }

  get initials() {
    return initialsFromProfile(this.draft(), this.auth.user());
  }

  get loginParts() {
    return getLoginMethodParts(this.auth.user());
  }

  get extraKeys() {
    const draft = this.draft();
    return Object.keys(draft)
      .filter(
        (k) =>
          !EDITABLE_FIELDS.some((f) => f.key === k) &&
          !isSystemKey(k) &&
          draft[k] != null &&
          String(draft[k]).trim() !== '' &&
          !String(draft[k]).startsWith('data:image'),
      )
      .sort((a, b) => this.fieldLabel(a).localeCompare(this.fieldLabel(b)));
  }

  readonly editableFields = EDITABLE_FIELDS;

  async refreshProfile() {
    try {
      const fresh = await fetchAllPersonalInfo();
      this.draft.set({ ...(this.initialProfile() || {}), ...(fresh || {}) });
    } catch {
      this.draft.set({ ...(this.initialProfile() || {}) });
    }
  }

  setField(key: string, value: string) {
    this.draft.update((prev) => ({ ...prev, [key]: value }));
  }

  hasStoredValue(key: string) {
    const v = this.draft()[key];
    return v != null && String(v).trim() !== '';
  }

  isEditing(key: string) {
    return this.editingKeys().includes(key);
  }

  isFieldLocked(key: string) {
    if (this.readOnly()) return true;
    if (!this.hasStoredValue(key)) return false;
    return !this.isEditing(key);
  }

  startEdit(key: string) {
    if (this.readOnly() || this.isEditing(key)) return;
    this.editingKeys.update((keys) => [...keys, key]);
    queueMicrotask(() => {
      const input = this.host.nativeElement.querySelector(
        `input[data-profile-field="${key}"]`,
      ) as HTMLInputElement | null;
      input?.focus();
      input?.select();
    });
  }

  requestDelete(key: string) {
    if (this.readOnly() || !key || isSystemKey(key) || !this.hasStoredValue(key)) return;
    this.pendingDelete.set({
      key,
      label: fieldLabel(key),
      value: String(this.draft()[key]).trim(),
    });
  }

  async confirmDelete() {
    const pending = this.pendingDelete();
    this.pendingDelete.set(null);
    if (!pending?.key || this.readOnly()) return;

    this.deleting.set(true);
    this.error.set('');
    this.message.set('');
    try {
      await deletePersonalInfoType(pending.key);
      if (pending.key === 'name') setCachedUserName('');
      const next = { ...this.draft() };
      delete next[pending.key];
      this.draft.set(next);
      this.editingKeys.update((keys) => keys.filter((k) => k !== pending.key));
      this.saved.emit(next);
      this.message.set(`Deleted “${pending.label}”.`);
    } catch (err: any) {
      this.error.set(err?.message || 'Could not delete that detail.');
    } finally {
      this.deleting.set(false);
    }
  }

  async onAvatarChange(event: Event) {
    if (this.readOnly()) return;
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.error.set('');
    try {
      const dataUrl = await fileToAvatarDataUrl(file);
      this.setField('avatar', String(dataUrl));
    } catch (err: any) {
      this.error.set(err?.message || 'Could not use that image.');
    }
  }

  addCustom(event: Event) {
    event.preventDefault();
    if (this.readOnly()) return;
    const key = this.customKey.trim().toLowerCase().replace(/\s+/g, '_');
    const value = this.customValue.trim();
    if (!key || !value) return;
    if (isSystemKey(key)) {
      this.error.set('That field name is reserved.');
      return;
    }
    this.setField(key, value);
    this.startEdit(key);
    this.customKey = '';
    this.customValue = '';
  }

  async save(event: Event) {
    event.preventDefault();
    if (this.readOnly()) return;
    this.saving.set(true);
    this.error.set('');
    this.message.set('');
    try {
      const entries = Object.entries(this.draft());
      const next: Record<string, any> = {};
      for (const [key, value] of entries) {
        if (!key) continue;
        const str = value == null ? '' : String(value).trim();
        if (!str && key !== 'avatar') continue;
        await savePersonalInfoType(key, str);
        if (str) next[key] = str;
      }
      if (next['name']) setCachedUserName(String(next['name']));
      this.draft.set(next);
      this.editingKeys.set([]);
      this.saved.emit(next);
      this.closed.emit();
    } catch (err: any) {
      this.error.set(err?.message || 'Could not save profile.');
    } finally {
      this.saving.set(false);
    }
  }

  fieldLabel(key: string) {
    return fieldLabel(key);
  }
}

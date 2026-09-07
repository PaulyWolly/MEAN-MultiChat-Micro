import { Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, Router } from '@angular/router';
import { AuthService } from '../../../services/auth.service';
import { ProfileMenuComponent } from '../profile-menu/profile-menu';

const PAGE_TITLES: Record<string, string> = {
  '/': 'Chat',
  '/youtube': 'YouTube',
  '/recipes': 'Recipes',
  '/jokes': 'Jokes',
  '/images': 'Images',
  '/rag': 'RAG',
  '/media': 'Media',
  '/about': 'About',
  '/demo/users': 'Users Demo',
};

const AI_NAV = [
  { to: '/', label: 'Chat', exact: true },
  { to: '/images', label: 'Images', exact: false },
  { to: '/rag', label: 'RAG', exact: false },
];

const OTHER_NAV = [
  { to: '/youtube', label: 'YouTube', exact: false },
  { to: '/recipes', label: 'Recipes', exact: false },
  { to: '/jokes', label: 'Jokes', exact: false },
];

@Component({
  selector: 'app-header',
  imports: [RouterLink, RouterLinkActive, ProfileMenuComponent],
  templateUrl: './header.html',
})
export class HeaderComponent {
  readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  get aiNav() {
    if (this.auth.isAuthenticated() || this.auth.isGuest()) return AI_NAV;
    return [];
  }

  get otherNav() {
    if (this.auth.isAuthenticated()) return OTHER_NAV;
    return [];
  }

  get showAbout() {
    return this.auth.isAuthenticated() || this.auth.isGuest();
  }

  get accountLabel() {
    return this.auth.isAuthenticated() || this.auth.isGuest() ? 'Account' : 'Login';
  }

  get pageTitle() {
    const path = this.router.url.split('?')[0];
    if (path === '/login') {
      return this.auth.isAuthenticated() || this.auth.isGuest() ? 'Account' : 'Login';
    }
    return PAGE_TITLES[path] || '';
  }

  /** DigiTall has no usable space glyph — render words separately with a CSS gap. */
  get pageTitleWords() {
    return this.pageTitle.split(/\s+/).filter(Boolean);
  }
}

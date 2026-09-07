import { Component } from '@angular/core';

@Component({
  selector: 'app-about',
  templateUrl: './about.html',
})
export class AboutComponent {
  photoSrc = 'https://github.com/PaulyWolly.png';
  photoFallback = 'https://avatars.githubusercontent.com/u/PaulyWolly';
  githubRepo = 'https://github.com/PaulyWolly/MEAN-MultiChat-Micro';

  onPhotoError(event: Event) {
    const el = event.currentTarget as HTMLImageElement;
    if (el.dataset['fallbackApplied']) return;
    el.dataset['fallbackApplied'] = '1';
    el.src = this.photoFallback;
  }
}

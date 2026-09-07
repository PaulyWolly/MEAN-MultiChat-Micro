import { Component, inject } from '@angular/core';
import { NavigationStart, Router, RouterOutlet } from '@angular/router';
import { HeaderComponent } from './components/shared/header/header';
import { FooterComponent } from './components/shared/footer/footer';
import { ToastStackComponent } from './components/shared/toast-stack/toast-stack';
import { AuthService } from './services/auth.service';
import { abortAllSpeechRecognition, stopSpeaking } from './components/shared/speech/speech';
import {
  claimYouTubeAudioLock,
  releaseYouTubeAudioLock,
} from './services/youtube-audio-lock';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, HeaderComponent, FooterComponent, ToastStackComponent],
  templateUrl: './app.html',
})
export class App {
  readonly auth = inject(AuthService);

  constructor() {
    const router = inject(Router);
    router.events.subscribe((event) => {
      if (!(event instanceof NavigationStart)) return;
      const path = event.url.split('?')[0];
      abortAllSpeechRecognition();
      stopSpeaking({ markComplete: true, bumpGeneration: true });
      if (path === '/youtube' || path.startsWith('/youtube/')) {
        claimYouTubeAudioLock();
      } else {
        releaseYouTubeAudioLock();
      }
    });
  }
}

import { Component, input, output } from '@angular/core';

function formatDuration(iso: string) {
  if (!iso || typeof iso !== 'string') return '';
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return '';
  const h = Number(m[1] || 0);
  const min = Number(m[2] || 0);
  const sec = Number(m[3] || 0);
  if (h > 0) {
    return `${h}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }
  return `${min}:${String(sec).padStart(2, '0')}`;
}

@Component({
  selector: 'app-youtube-video-card',
  templateUrl: './youtube-video-card.html',
  host: { class: 'youtube-video-card' },
})
export class YouTubeVideoCardComponent {
  video = input<any>(null);
  alreadyFavorited = input(false);
  play = output<string>();
  openChannel = output<any>();
  addToPlaylist = output<any>();
  thumbError = output<string>();

  videoId() {
    return this.video()?.id || this.video()?.videoId || '';
  }

  title() {
    return this.video()?.title || 'Video';
  }

  channel() {
    return this.video()?.channelTitle || this.video()?.channel || '';
  }

  thumb() {
    const id = this.videoId();
    return this.video()?.thumbnail || (id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : '');
  }

  duration() {
    return formatDuration(this.video()?.duration);
  }
}

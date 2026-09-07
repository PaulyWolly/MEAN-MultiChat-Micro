import { DOCUMENT } from '@angular/common';
import {
  AfterViewInit,
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import {
  addVideoToPlaylist,
  createPlaylist,
  deletePlaylist,
  listPlaylists,
  moveVideoToPlaylist,
  removeVideoFromPlaylist,
  touchPlaylist,
} from '../../services/api/playlists';
import { AuthService } from '../../services/auth.service';
import { ClearableInputComponent } from '../shared/clearable-input/clearable-input';
import { ConfirmModalComponent } from '../shared/confirm-modal/confirm-modal';
import { ModalCloseButtonComponent } from '../shared/modal-close-button/modal-close-button';
import {
  PLAYLIST_HINT_MATCH_MIN,
  getPlaylistVisibleName,
  getPlaylistVisibleNameKey,
  playlistHintsFromVideo,
  scorePlaylistNameAgainstHints,
  suggestedPlaylistNameFromVideo,
} from './playlist-name-normalizer';

function formatDuration(iso: string) {
  if (!iso || typeof iso !== 'string') return '';
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return iso;
  const h = Number(m[1] || 0);
  const min = Number(m[2] || 0);
  const s = Number(m[3] || 0);
  if (h) return `${h}:${String(min).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${min}:${String(s).padStart(2, '0')}`;
}

function objectIdTime(id: string) {
  const s = String(id || '');
  if (s.length < 8) return 0;
  const t = Number.parseInt(s.slice(0, 8), 16);
  return Number.isFinite(t) ? t * 1000 : 0;
}

function toTime(value: any) {
  if (value == null || value === '') return 0;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : 0;
}

function buildSecondCounts(playlists: any[]) {
  const counts = new Map<string, number>();
  for (const p of playlists) {
    const key = p.updatedAt ? new Date(p.updatedAt).toISOString().slice(0, 19) : '';
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function playlistActivityTime(playlist: any, secondCounts: Map<string, number>) {
  const lastAccess = toTime(playlist.lastAccessedAt);
  if (lastAccess > 0) return lastAccess;
  const lastAdd = toTime(playlist.lastVideoAddedAt);
  if (lastAdd > 0) return lastAdd;
  const updated = toTime(playlist.updatedAt);
  const key = playlist.updatedAt ? new Date(playlist.updatedAt).toISOString().slice(0, 19) : '';
  const isMassStamp = key && (secondCounts?.get(key) || 0) >= 5;
  if (updated > 0 && !isMassStamp) return updated;
  let newestVideo = 0;
  for (const v of playlist.videos || []) {
    newestVideo = Math.max(newestVideo, objectIdTime(v._id));
  }
  return Math.max(newestVideo, toTime(playlist.createdAt), objectIdTime(playlist._id));
}

@Component({
  selector: 'app-playlist-manager-modal',
  imports: [ClearableInputComponent, ModalCloseButtonComponent, ConfirmModalComponent],
  templateUrl: './playlist-manager-modal.html',
})
export class PlaylistManagerModalComponent implements AfterViewInit, OnDestroy {
  private readonly document = inject(DOCUMENT);
  private readonly host = inject(ElementRef<HTMLElement>);
  readonly auth = inject(AuthService);

  open = input(false);
  pendingVideo = input<any | null>(null);
  contextQuery = input('');
  closed = output();
  clearPending = output();
  playVideo = output<string>();

  playlists = signal<any[]>([]);
  selectedId = signal<string | null>(null);
  filter = signal('');
  newName = signal('');
  message = signal('');
  error = signal('');
  loading = signal(false);
  dragOverId = signal<string | null>(null);
  sortMode = signal<'recent' | 'alpha'>('recent');
  movingId = signal<string | null>(null);
  provisioning = signal(false);
  pendingDelete = signal<any | null>(null);

  private autoSelectKey = '';
  private autoProvisionKey = '';
  private provisioningLock = false;
  private messageTimer: number | null = null;

  constructor() {
    effect(() => {
      const isOpen = this.open();
      untracked(() => {
        if (!isOpen) {
          this.autoSelectKey = '';
          this.autoProvisionKey = '';
          this.provisioningLock = false;
          this.filter.set('');
          this.provisioning.set(false);
          return;
        }
        void this.load();
      });
    });

    effect(() => {
      const isOpen = this.open();
      const video = this.pendingVideo();
      const query = this.contextQuery();
      if (!isOpen || !video) return;
      const suggested = suggestedPlaylistNameFromVideo(video, query);
      if (suggested) this.newName.set(suggested);
    });

    effect(() => {
      const isOpen = this.open();
      const loading = this.loading();
      const lists = this.playlists();
      const video = this.pendingVideo();
      const query = this.contextQuery();
      const hints = this.contextHints();
      untracked(() => this.maybeAutoSelect(isOpen, loading, lists, video, query, hints));
    });

    effect(() => {
      const isOpen = this.open();
      const loading = this.loading();
      const lists = this.playlists();
      const video = this.pendingVideo();
      const query = this.contextQuery();
      const hints = this.contextHints();
      untracked(() => void this.maybeAutoProvision(isOpen, loading, lists, video, query, hints));
    });
  }

  ngAfterViewInit() {
    this.document.body.appendChild(this.host.nativeElement);
  }

  ngOnDestroy() {
    if (this.messageTimer) window.clearTimeout(this.messageTimer);
    this.host.nativeElement.remove();
  }

  @HostListener('document:keydown.escape')
  onEscape() {
    if (this.open() && !this.pendingDelete()) this.closed.emit();
  }

  readonly contextHints = computed(() => {
    const video = this.pendingVideo();
    return video ? playlistHintsFromVideo(video, this.contextQuery()) : [];
  });

  readonly filtered = computed(() => {
    const f = this.filter().trim().toLowerCase();
    let list = [...this.playlists()];
    if (f) {
      list = list.filter((p) => getPlaylistVisibleName(p.name).toLowerCase().includes(f));
    }
    const hints = this.contextHints();
    const useSmartMatch = Boolean(this.pendingVideo() && hints.length);
    const secondCounts = buildSecondCounts(list);
    const scored = list.map((p) => ({
      playlist: p,
      score: useSmartMatch ? scorePlaylistNameAgainstHints(p.name, hints) : 0,
      activity: playlistActivityTime(p, secondCounts),
    }));
    const sortMode = this.sortMode();
    scored.sort((a, b) => {
      if (useSmartMatch) {
        const aHit = a.score >= PLAYLIST_HINT_MATCH_MIN ? 1 : 0;
        const bHit = b.score >= PLAYLIST_HINT_MATCH_MIN ? 1 : 0;
        if (aHit !== bHit) return bHit - aHit;
      }
      if (sortMode === 'recent') {
        if (a.activity !== b.activity) return b.activity - a.activity;
        return getPlaylistVisibleName(a.playlist.name).localeCompare(
          getPlaylistVisibleName(b.playlist.name),
        );
      }
      return getPlaylistVisibleName(a.playlist.name).localeCompare(
        getPlaylistVisibleName(b.playlist.name),
      );
    });
    return scored.map((s) => s.playlist);
  });

  readonly selected = computed(() => {
    const id = this.selectedId();
    return this.playlists().find((p) => p._id === id) || null;
  });

  readonly moveTargets = computed(() => {
    const id = this.selectedId();
    if (!id) return [];
    return this.playlists()
      .filter((p) => p._id !== id)
      .slice()
      .sort((a, b) =>
        getPlaylistVisibleName(a.name).localeCompare(getPlaylistVisibleName(b.name)),
      );
  });

  visibleName(name: string) {
    return getPlaylistVisibleName(name);
  }

  isSuggested(pl: any) {
    return scorePlaylistNameAgainstHints(pl.name, this.contextHints()) >= PLAYLIST_HINT_MATCH_MIN;
  }

  formatDuration(iso: string) {
    return formatDuration(iso);
  }

  async load() {
    this.loading.set(true);
    this.error.set('');
    try {
      if (this.auth.isAuthenticated()) {
        const ok = await this.auth.refreshSession();
        if (!ok) {
          throw new Error(
            'Session expired or not signed in — please sign out and sign back in, then try again.',
          );
        }
      }
      const list = await listPlaylists();
      this.playlists.set(list);
      const prev = this.selectedId();
      if (prev && list.some((p: any) => p._id === prev)) this.selectedId.set(prev);
      else this.selectedId.set(list[0]?._id || null);
    } catch (err: any) {
      this.error.set(err.message);
      this.playlists.set([]);
    } finally {
      this.loading.set(false);
    }
  }

  /** Play in-app and mark this playlist as most recent for next open. */
  async playFromPlaylist(videoId: string) {
    const id = this.selectedId();
    if (id) {
      try {
        const data = await touchPlaylist(id);
        const updated = data?.playlist;
        if (updated?._id) {
          this.playlists.update((list) =>
            list.map((p) => (p._id === updated._id ? { ...p, ...updated } : p)),
          );
        }
      } catch {
        // Still play even if activity stamp fails.
      }
    }
    this.playVideo.emit(String(videoId || ''));
  }

  private maybeAutoSelect(
    isOpen: boolean,
    loading: boolean,
    lists: any[],
    video: any,
    query: string,
    hints: string[],
  ) {
    if (!isOpen || loading || !lists.length) return;
    const key = `${video?.videoId || video?.id || ''}|${String(query || '').trim()}|${hints.join('~')}`;
    if (this.autoSelectKey === key) return;
    this.autoSelectKey = key;
    if (!video || !hints.length) return;
    let best: any = null;
    let bestScore = 0;
    for (const p of lists) {
      const score = scorePlaylistNameAgainstHints(p.name, hints);
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
    if (best && bestScore >= PLAYLIST_HINT_MATCH_MIN) this.selectedId.set(best._id);
  }

  private async maybeAutoProvision(
    isOpen: boolean,
    loading: boolean,
    lists: any[],
    video: any,
    query: string,
    hints: string[],
  ) {
    if (!isOpen || loading || !video || this.provisioningLock) return;
    const videoId = String(video.videoId || video.id || '');
    if (!videoId) return;
    const suggestedName = suggestedPlaylistNameFromVideo(video, query);
    const nameKey = getPlaylistVisibleNameKey(suggestedName);
    if (!nameKey) return;
    const existingByName = lists.find((p) => getPlaylistVisibleNameKey(p.name) === nameKey);
    if (existingByName) {
      this.selectedId.set(existingByName._id);
      return;
    }
    let bestScore = 0;
    for (const p of lists) {
      bestScore = Math.max(bestScore, scorePlaylistNameAgainstHints(p.name, hints));
    }
    if (bestScore >= PLAYLIST_HINT_MATCH_MIN) return;
    if (lists.length > 0 && hints.length === 0) return;
    const provisionKey = `${videoId}|${nameKey}`;
    if (this.autoProvisionKey === provisionKey) return;
    this.autoProvisionKey = provisionKey;
    this.provisioningLock = true;
    this.provisioning.set(true);
    this.error.set('');
    try {
      const result = await createPlaylist(suggestedName);
      if (!this.open()) return;
      let playlist = result.playlist;
      if (!playlist?._id) {
        const list = await listPlaylists();
        playlist = list.find((p: any) => getPlaylistVisibleNameKey(p.name) === nameKey) || null;
        if (playlist) this.playlists.set(list);
      }
      if (!playlist?._id) throw new Error('Playlist was created but could not be loaded.');
      this.selectedId.set(playlist._id);
      const visible = getPlaylistVisibleName(playlist.name);
      this.showMsg(
        result.duplicate
          ? `Selected existing playlist “${visible}” — drag the video onto it.`
          : `Created “${visible}” — drag the video onto it to add.`,
      );
      this.playlists.update((prev) => {
        if (prev.some((p) => String(p._id) === String(playlist._id))) return prev;
        return [playlist, ...prev];
      });
      await this.load();
      this.selectedId.set(playlist._id);
    } catch (err: any) {
      if (!this.open()) return;
      this.error.set(err.message || 'Could not create playlist.');
      this.autoProvisionKey = '';
    } finally {
      this.provisioningLock = false;
      this.provisioning.set(false);
    }
  }

  showMsg(text: string) {
    this.message.set(text);
    if (this.messageTimer) window.clearTimeout(this.messageTimer);
    this.messageTimer = window.setTimeout(() => this.message.set(''), 3500);
  }

  async handleCreate(event: Event) {
    event.preventDefault();
    const name = this.newName().trim();
    if (!name) return;
    try {
      const result = await createPlaylist(name);
      this.selectedId.set(result.playlist?._id || null);
      this.showMsg(result.duplicate ? 'Playlist already exists — selected it.' : 'Playlist created.');
      this.newName.set('');
      await this.load();
    } catch (err: any) {
      this.error.set(err.message);
    }
  }

  async addVideo(playlistId: string, video: any) {
    if (!playlistId || !video) return;
    try {
      const data = await addVideoToPlaylist(playlistId, {
        id: video.id || video.videoId,
        videoId: video.videoId || video.id,
        title: video.title,
        thumbnail: video.thumbnail,
        duration: video.duration,
        channelTitle: video.channelTitle || video.channel,
      });
      this.showMsg('Video added to playlist.');
      this.clearPending.emit();
      if (data?.playlist) {
        const bumped = {
          ...data.playlist,
          updatedAt: data.playlist.updatedAt || new Date().toISOString(),
        };
        this.playlists.update((prev) => {
          const rest = prev.filter((p) => String(p._id) !== String(bumped._id));
          return [bumped, ...rest];
        });
      }
      this.selectedId.set(playlistId);
      await this.load();
      this.selectedId.set(playlistId);
    } catch (err: any) {
      if (err.code === 'DUPLICATE_VIDEO' || err.message === 'DUPLICATE_VIDEO') {
        this.showMsg('Video already in that playlist.');
        this.clearPending.emit();
      } else {
        this.error.set(err.message);
      }
    }
  }

  handleDragStart(event: DragEvent) {
    const video = this.pendingVideo();
    if (!video || !event.dataTransfer) return;
    event.dataTransfer.setData('application/json', JSON.stringify(video));
    event.dataTransfer.effectAllowed = 'copy';
  }

  onDragOver(event: DragEvent, playlistId: string) {
    event.preventDefault();
    this.dragOverId.set(playlistId);
  }

  onDragLeave(playlistId: string) {
    this.dragOverId.update((id) => (id === playlistId ? null : id));
  }

  async handleDrop(event: DragEvent, playlistId: string) {
    event.preventDefault();
    this.dragOverId.set(null);
    try {
      const raw = event.dataTransfer?.getData('application/json');
      const video = raw ? JSON.parse(raw) : this.pendingVideo();
      if (!video) return;
      await this.addVideo(playlistId, video);
    } catch {
      this.error.set('Failed to add video by drag-and-drop.');
    }
  }

  requestRemoveVideo(entryId: string) {
    if (!this.selectedId() || !entryId) return;
    const video = (this.selected()?.videos || []).find((v: any) => v._id === entryId);
    this.pendingDelete.set({
      kind: 'video',
      entryId,
      label: video?.title || 'this video',
    });
  }

  handleDeletePlaylist() {
    const id = this.selectedId();
    if (!id) return;
    const playlist = this.playlists().find((p) => p._id === id);
    this.pendingDelete.set({
      kind: 'playlist',
      label: playlist ? getPlaylistVisibleName(playlist.name) : 'this playlist',
      count: playlist?.videos?.length || 0,
    });
  }

  pendingDeleteTitle() {
    return this.pendingDelete()?.kind === 'playlist' ? 'Delete playlist?' : 'Remove video?';
  }

  pendingDeleteMessage() {
    const pending = this.pendingDelete();
    if (!pending) return '';
    if (pending.kind === 'playlist') {
      const extra = pending.count
        ? ` and its ${pending.count} video${pending.count === 1 ? '' : 's'}`
        : '';
      return `Permanently delete the playlist “${pending.label}”${extra}? This cannot be undone.`;
    }
    return `Remove “${pending.label}” from this playlist? The video stays on YouTube.`;
  }

  async confirmPendingDelete() {
    const pending = this.pendingDelete();
    this.pendingDelete.set(null);
    if (!pending) return;
    try {
      if (pending.kind === 'playlist') {
        await deletePlaylist(this.selectedId());
        this.selectedId.set(null);
        await this.load();
        this.showMsg('Playlist deleted.');
      } else {
        await removeVideoFromPlaylist(this.selectedId(), pending.entryId);
        await this.load();
      }
    } catch (err: any) {
      this.error.set(err.message);
    }
  }

  async handleMoveVideo(entryId: string, targetPlaylistId: string) {
    const selectedId = this.selectedId();
    if (!selectedId || !entryId || !targetPlaylistId) return;
    this.movingId.set(entryId);
    this.error.set('');
    try {
      const result = await moveVideoToPlaylist(selectedId, entryId, targetPlaylistId);
      const target = this.playlists().find((p) => p._id === targetPlaylistId);
      const targetName = target ? getPlaylistVisibleName(target.name) : 'the other playlist';
      this.showMsg(
        result.alreadyInTarget
          ? `Already in “${targetName}” — removed from here.`
          : `Moved to “${targetName}”.`,
      );
      await this.load();
    } catch (err: any) {
      this.error.set(err.message);
    } finally {
      this.movingId.set(null);
    }
  }

  onMoveChange(entryId: string, event: Event) {
    const targetId = (event.target as HTMLSelectElement).value;
    (event.target as HTMLSelectElement).value = '';
    if (targetId) void this.handleMoveVideo(entryId, targetId);
  }
}

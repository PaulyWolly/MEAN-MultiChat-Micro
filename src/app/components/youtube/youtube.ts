import { Component, OnDestroy, OnInit, ViewChild, computed, effect, inject, signal, untracked } from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import {
  deleteSavedYouTubeSearch,
  listSavedYouTubeSearches,
  resolveYouTubeChannel,
  saveYouTubeSearch,
  searchYouTubeCached,
} from '../../services/api/client';
import { listPlaylists } from '../../services/api/playlists';
import { AuthService } from '../../services/auth.service';
import { ToastService } from '../../services/toast.service';
import { ConfirmModalComponent } from '../shared/confirm-modal/confirm-modal';
import { ClearableInputComponent } from '../shared/clearable-input/clearable-input';
import { ModalCloseButtonComponent } from '../shared/modal-close-button/modal-close-button';
import { SearchIconButtonComponent } from '../shared/search-icon-button/search-icon-button';
import { VoiceMicButtonComponent } from '../shared/voice-mic-button/voice-mic-button';
import { abortAllSpeechRecognition, stopSpeaking } from '../shared/speech/speech';
import {
  claimYouTubeAudioLock,
  releaseYouTubeAudioLock,
} from '../../services/youtube-audio-lock';
import { PlaylistManagerModalComponent } from './playlist-manager-modal';
import {
  cleanYouTubeQueryForDisplay,
  clearLocalYouTubeCacheForQuery,
  forgetRecentYouTubeQuery,
  getAllCachedPagesForQuery,
  getCachedYouTubePage,
  highestCachedPageForQuery,
  listRecentYouTubeQueries,
  normalizeYouTubeQuery,
  preferYouTubeDisplayName,
  preferYouTubeNormalizedKey,
  queriesMatch,
  rememberRecentYouTubeQuery,
  repairYouTubeDisplayNameFromTitles,
  youtubeConsonantSkeleton,
} from './youtube-cache';
import { youtubeChannelEmbedSrc, youtubeChannelHref } from './youtube-channel';
import { YouTubeHistoryModalComponent } from './youtube-history-modal';
import { YouTubePagerComponent } from './youtube-pager';
import { formatYouTubeHistoryLabel } from './youtube-query-clean';
import { YouTubeVideoCardComponent } from './youtube-video-card';

function mergeYouTubeHistoryItems(mongoSearches: any[], recentLocal: any[]) {
  const bySkel = new Map<string, any>();
  const mergeItem = (incoming: any) => {
    const key = preferYouTubeNormalizedKey(incoming.query, incoming.displayName);
    if (!key) return;
    const skel = youtubeConsonantSkeleton(key) || key;
    const prev = bySkel.get(skel);
    if (!prev) {
      bySkel.set(skel, { ...incoming, query: key });
      return;
    }
    bySkel.set(skel, {
      ...prev,
      ...incoming,
      query: preferYouTubeNormalizedKey(prev.query, key),
      _id: prev._id || incoming._id,
      isSaved: Boolean(prev.isSaved || incoming.isSaved),
      displayName: preferYouTubeDisplayName(prev.displayName, incoming.displayName),
      lastSearched: Math.max(
        new Date(prev.lastSearched || 0).getTime(),
        new Date(incoming.lastSearched || 0).getTime(),
      ),
      totalPages:
        Math.max(Number(prev.totalPages) || 0, Number(incoming.totalPages) || 0) || undefined,
      videoCount:
        Math.max(Number(prev.videoCount) || 0, Number(incoming.videoCount) || 0) || undefined,
      titleHints: [
        ...(Array.isArray(prev.titleHints) ? prev.titleHints : []),
        ...(Array.isArray(incoming.titleHints) ? incoming.titleHints : []),
      ],
    });
  };

  for (const s of mongoSearches) {
    const key = normalizeYouTubeQuery(s.query || s.displayName);
    if (!key) continue;
    mergeItem({ ...s, query: key, isSaved: s.isSaved !== false });
  }
  for (const r of recentLocal) {
    const key = normalizeYouTubeQuery(r.query || r.displayName);
    if (!key) continue;
    mergeItem({
      query: key,
      displayName: preferYouTubeDisplayName(r.displayName, r.query),
      lastSearched: r.lastSearched,
      isSaved: false,
      fromLocal: true,
    });
  }

  const repaired = [...bySkel.values()].map((item) => {
    const q = item.displayName || item.query || '';
    const localPages = getAllCachedPagesForQuery(q);
    const localHighest = localPages.reduce(
      (max: number, p: any) => Math.max(max, Number(p.page) || 0),
      0,
    );
    const stored = Number(item.totalPages) || 0;
    const totalPages = Math.max(localHighest, stored) || undefined;
    const videoCount =
      localPages.length > 0
        ? localPages.reduce((n: number, p: any) => n + (p.videos?.length || 0), 0)
        : item.videoCount;
    const titles: string[] = [
      ...(Array.isArray(item.titleHints) ? item.titleHints : []),
      ...localPages.flatMap((p: any) => (p.videos || []).map((v: any) => v.title || '')),
    ].filter(Boolean);
    const displayName = formatYouTubeHistoryLabel(
      {
        displayName: preferYouTubeDisplayName(item.displayName, item.query, q),
        query: item.query,
        titleHints: titles,
      },
      titles as any,
    );
    const repairedKey = preferYouTubeNormalizedKey(displayName, item.query);
    return {
      ...item,
      query: repairedKey || item.query,
      displayName,
      ...(totalPages != null ? { totalPages } : {}),
      ...(videoCount != null ? { videoCount } : {}),
    };
  });

  const collapsed = new Map<string, any>();
  for (const item of repaired) {
    const key = preferYouTubeNormalizedKey(item.displayName, item.query);
    if (!key) continue;
    const skel = youtubeConsonantSkeleton(key) || key;
    const prev = collapsed.get(skel);
    if (!prev) {
      collapsed.set(skel, { ...item, query: key });
      continue;
    }
    collapsed.set(skel, {
      ...prev,
      ...item,
      query: preferYouTubeNormalizedKey(prev.query, key),
      _id: prev._id || item._id,
      isSaved: Boolean(prev.isSaved || item.isSaved),
      displayName: preferYouTubeDisplayName(prev.displayName, item.displayName),
      lastSearched: Math.max(
        new Date(prev.lastSearched || 0).getTime(),
        new Date(item.lastSearched || 0).getTime(),
      ),
      totalPages:
        Math.max(Number(prev.totalPages) || 0, Number(item.totalPages) || 0) || undefined,
      videoCount:
        Math.max(Number(prev.videoCount) || 0, Number(item.videoCount) || 0) || undefined,
    });
  }
  return [...collapsed.values()];
}

@Component({
  selector: 'app-youtube',
  imports: [
    ClearableInputComponent,
    SearchIconButtonComponent,
    VoiceMicButtonComponent,
    ModalCloseButtonComponent,
    ConfirmModalComponent,
    YouTubeHistoryModalComponent,
    YouTubePagerComponent,
    YouTubeVideoCardComponent,
    PlaylistManagerModalComponent,
  ],
  templateUrl: './youtube.html',
})
export class YouTubeComponent implements OnInit, OnDestroy {
  readonly toast = inject(ToastService);
  readonly auth = inject(AuthService);
  private readonly sanitizer = inject(DomSanitizer);
  @ViewChild(VoiceMicButtonComponent) private voiceMic?: VoiceMicButtonComponent;

  query = signal('');
  videos = signal<any[]>([]);
  loading = signal(false);
  player = signal<{ kind: 'video' | 'channel'; videoId?: string; channelId?: string; title?: string } | null>(
    null,
  );
  page = signal(1);
  nextPageToken = signal<string | null>(null);
  pageTokens = signal<(string | null)[]>([null]);
  knownTotalPages = signal(0);
  cacheSource = signal('');
  saving = signal(false);
  activeQuery = signal('');
  mongoSearches = signal<any[]>([]);
  recentLocal = signal<any[]>(listRecentYouTubeQueries());
  historyOpen = signal(false);
  historyLoadError = signal('');
  pendingHistoryDelete = signal<any | null>(null);
  playlistOpen = signal(false);
  pendingVideo = signal<any | null>(null);
  favoritedVideoIds = signal<Set<string>>(new Set());
  hiddenVideoIds = signal<Set<string>>(new Set());
  private knownTotalQuery = '';

  readonly historyItems = computed(() =>
    mergeYouTubeHistoryItems(this.mongoSearches(), this.recentLocal()),
  );

  readonly currentSaved = computed(() => {
    const active = this.activeQuery();
    if (!active) return false;
    return this.mongoSearches().some(
      (s) => s.isSaved !== false && queriesMatch(s.query || s.displayName, active),
    );
  });

  readonly pendingDeleteLabel = computed(() => {
    const item = this.pendingHistoryDelete();
    if (!item) return 'this search';
    return (
      formatYouTubeHistoryLabel(item) ||
      item.displayName ||
      String(item.query || '').replace(/\./g, ' ') ||
      'this search'
    );
  });

  readonly visibleVideos = computed(() =>
    this.videos().filter((v) => v?.id && !this.hiddenVideoIds().has(String(v.id))),
  );

  readonly resultsLabel = computed(() =>
    formatYouTubeHistoryLabel(
      this.activeQuery(),
      this.videos().map((v) => v.title || '') as any,
    ),
  );

  readonly maxCachedPage = computed(() => {
    const active = this.activeQuery();
    if (!active) return Math.max(this.page(), this.knownTotalPages());
    return Math.max(this.page(), this.knownTotalPages(), highestCachedPageForQuery(active));
  });

  readonly pageLabel = computed(() => {
    const max = this.maxCachedPage();
    if (max > 1) return ` of ${max}`;
    return this.nextPageToken() ? '+' : '';
  });

  readonly cacheStatusLabel = computed(() => {
    const src = this.cacheSource();
    if (src === 'localStorage') return 'Loaded from localStorage — no quota used';
    if (src === 'mongodb') return 'Loaded from MongoDB — no quota used';
    if (src === 'api') return 'Live YouTube results';
    return '';
  });

  readonly canGoNext = computed(
    () =>
      Boolean(this.nextPageToken()) ||
      Boolean(this.activeQuery() && getCachedYouTubePage(this.activeQuery(), this.page() + 1)),
  );

  readonly canGoLast = computed(
    () => highestCachedPageForQuery(this.activeQuery() || this.query()) > this.page(),
  );

  readonly canGoBack = computed(() => this.page() > 1);

  constructor() {
    claimYouTubeAudioLock();
    stopSpeaking({ markComplete: true, bumpGeneration: true });
    effect(() => {
      this.auth.dataKey();
      untracked(() => {
        void this.loadSaved();
        void this.loadFavoritedVideos();
      });
    });
  }

  ngOnInit() {
    claimYouTubeAudioLock();
  }

  ngOnDestroy() {
    this.voiceMic?.stopListening();
    releaseYouTubeAudioLock();
  }

  private hushAppAudio() {
    this.voiceMic?.stopListening();
    abortAllSpeechRecognition();
    stopSpeaking({ markComplete: true, bumpGeneration: true });
  }

  async loadSaved() {
    this.historyLoadError.set('');
    try {
      if (this.auth.isAuthenticated()) {
        const ok = await this.auth.refreshSession();
        if (!ok) {
          throw new Error(
            'Session expired or not signed in — please sign out and sign back in, then open History again.',
          );
        }
        const data = await listSavedYouTubeSearches();
        this.mongoSearches.set(data.searches || data.results || []);
      } else {
        this.mongoSearches.set([]);
      }
    } catch (err: any) {
      this.mongoSearches.set([]);
      const message = err?.message || 'Could not load YouTube history from MongoDB.';
      this.historyLoadError.set(message);
      if (this.historyOpen()) this.toast.show(message, 'error');
    }
    this.recentLocal.set(listRecentYouTubeQueries());
  }

  async loadFavoritedVideos() {
    try {
      const list = await listPlaylists();
      const ids = new Set<string>();
      for (const pl of list) {
        for (const v of pl.videos || []) {
          if (v.videoId) ids.add(String(v.videoId));
        }
      }
      this.favoritedVideoIds.set(ids);
    } catch {
      /* playlists optional */
    }
  }

  async runSearch(
    rawQuery: string,
    { pageNum = 1, pageToken = null as string | null, isPagination = false } = {},
  ) {
    const trimmed =
      cleanYouTubeQueryForDisplay(rawQuery.trim()) || rawQuery.trim();
    if (!trimmed) return;

    this.loading.set(true);
    if (!isPagination) this.cacheSource.set('');
    this.query.set(trimmed);
    this.activeQuery.set(trimmed);

    try {
      const data = await searchYouTubeCached(trimmed, {
        page: pageNum,
        pageToken: pageToken as any,
      });
      const list = (data.videos || []).filter((v: any) => v?.id && v.privacyStatus !== 'private');

      if (isPagination && pageNum > 1 && list.length === 0) {
        this.nextPageToken.set(null);
        this.knownTotalPages.update((prev) => {
          const capped = Math.max(1, pageNum - 1);
          return prev > 0 ? Math.min(prev, capped) : capped;
        });
        this.toast.show(`No more pages after page ${pageNum - 1} for this search.`, 'error');
        return;
      }

      this.hiddenVideoIds.set(new Set());
      this.videos.set(list);
      this.page.set(data.page || pageNum);
      this.nextPageToken.set(data.nextPageToken || null);
      this.cacheSource.set(data.cacheSource || (data.fromCache ? 'cache' : 'api'));
      const highestCached = highestCachedPageForQuery(trimmed);
      const resultPage = Number(data.page || pageNum) || 1;
      const queryKey = normalizeYouTubeQuery(trimmed);
      this.knownTotalPages.update((prev) => {
        const baseline = queryKey === this.knownTotalQuery ? Number(prev) || 0 : 0;
        return Math.max(baseline, highestCached, resultPage);
      });
      this.knownTotalQuery = queryKey;

      rememberRecentYouTubeQuery(trimmed);
      this.recentLocal.set(listRecentYouTubeQueries());

      this.pageTokens.update((prev) => {
        const next = pageNum === 1 ? [null] : [...prev];
        while (next.length < pageNum) next.push(null);
        next[pageNum - 1] = pageToken || null;
        return next;
      });

      this.player.set(null);
      if (list.length === 0) {
        this.toast.show('No videos found for that search.', 'error');
      }
    } catch (err: any) {
      this.toast.show(err?.message || 'YouTube search failed', 'error');
      if (!isPagination) {
        this.videos.set([]);
        this.hiddenVideoIds.set(new Set());
        this.player.set(null);
      } else {
        this.nextPageToken.set(null);
      }
    } finally {
      this.loading.set(false);
    }
  }

  onSubmit(event: Event) {
    event.preventDefault();
    void this.runSearch(this.query(), { pageNum: 1, pageToken: null });
  }

  onVoice(text: string) {
    if (this.player()) return;
    void this.runSearch(text, { pageNum: 1, pageToken: null });
  }

  async handleFirst() {
    if (this.page() <= 1 || this.loading()) return;
    await this.runSearch(this.activeQuery() || this.query(), {
      pageNum: 1,
      pageToken: null,
      isPagination: true,
    });
  }

  async handlePrev() {
    if (this.page() <= 1 || this.loading()) return;
    const prevPage = this.page() - 1;
    await this.runSearch(this.activeQuery() || this.query(), {
      pageNum: prevPage,
      pageToken: this.pageTokens()[prevPage - 1] || null,
      isPagination: true,
    });
  }

  async handleNext() {
    if (this.loading()) return;
    const nextPage = this.page() + 1;
    const cachedNext = getCachedYouTubePage(this.activeQuery() || this.query(), nextPage);
    if (!this.nextPageToken() && !cachedNext) return;
    await this.runSearch(this.activeQuery() || this.query(), {
      pageNum: nextPage,
      pageToken: this.nextPageToken(),
      isPagination: true,
    });
  }

  async handleLast() {
    if (this.loading()) return;
    const q = this.activeQuery() || this.query();
    const lastPage = highestCachedPageForQuery(q);
    if (lastPage <= this.page()) return;
    await this.runSearch(q, {
      pageNum: lastPage,
      pageToken: this.pageTokens()[lastPage - 1] || null,
      isPagination: true,
    });
  }

  openVideoPlayer(videoId: string) {
    if (!videoId) return;
    this.hushAppAudio();
    this.player.set({ kind: 'video', videoId: String(videoId) });
    // Playing from Playlist Manager should dismiss the modal so the player is visible.
    if (this.playlistOpen()) {
      this.closePlaylists();
    }
  }

  async openChannelPlayer(video: any) {
    const title = video?.channelTitle || video?.channel || 'Channel';
    let channelId = String(video?.channelId || '').trim();
    if (!channelId) {
      try {
        const resolved = await resolveYouTubeChannel({ q: title, videoId: video?.id });
        channelId = String(resolved.channelId || '').trim();
      } catch (err: any) {
        this.toast.show(err.message || 'Could not open channel in player', 'error');
        return;
      }
    }
    if (!channelId) {
      this.toast.show('Channel id missing — try a fresh search, then click the channel again.', 'error');
      return;
    }
    this.hushAppAudio();
    this.player.set({ kind: 'channel', channelId, title: title || channelId });
  }

  embedUrl(): SafeResourceUrl | null {
    const player = this.player();
    if (!player) return null;
    const src =
      player.kind === 'channel'
        ? youtubeChannelEmbedSrc(player.channelId)
        : player.videoId
          ? `https://www.youtube.com/embed/${player.videoId}?autoplay=1&rel=0&modestbranding=1&playsinline=1`
          : '';
    if (!src) return null;
    return this.sanitizer.bypassSecurityTrustResourceUrl(src);
  }

  playerExternalHref() {
    const player = this.player();
    if (!player) return '';
    if (player.kind === 'channel') {
      return youtubeChannelHref({ channelId: player.channelId, channelTitle: player.title });
    }
    return `https://www.youtube.com/watch?v=${player.videoId}`;
  }

  hideVideo(videoId: string) {
    if (!videoId) return;
    this.hiddenVideoIds.update((prev) => {
      const key = String(videoId);
      if (prev.has(key)) return prev;
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  }

  alreadyFavorited(video: any) {
    const id = video?.id || video?.videoId;
    return Boolean(id && this.favoritedVideoIds().has(String(id)));
  }

  openPlaylists(video: any = null) {
    this.pendingVideo.set(video);
    this.playlistOpen.set(true);
  }

  handleAddToPlaylist(video: any) {
    this.openPlaylists({
      id: video.id,
      videoId: video.id,
      title: video.title || 'Untitled Video',
      thumbnail: video.thumbnail || `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`,
      duration: video.duration || '',
      channelTitle: video.channelTitle || video.channel || '',
      channelId: video.channelId || '',
    });
  }

  closePlaylists() {
    this.playlistOpen.set(false);
    this.pendingVideo.set(null);
    void this.loadFavoritedVideos();
  }

  async openHistory() {
    await this.loadSaved();
    this.historyOpen.set(true);
  }

  async persistSave(q: string) {
    const trimmed = (q || this.activeQuery() || this.query()).trim();
    if (!trimmed) return;
    const displayName = cleanYouTubeQueryForDisplay(trimmed) || trimmed;
    this.saving.set(true);
    try {
      const pages = getAllCachedPagesForQuery(trimmed);
      const titles: string[] = pages.flatMap((p: any) =>
        (p.videos || []).map((v: any) => v.title || ''),
      );
      const niceName =
        repairYouTubeDisplayNameFromTitles(displayName, titles as any) || displayName;
      const highest = pages.reduce(
        (max: number, p: any) => Math.max(max, Number(p.page) || 0),
        0,
      );
      await saveYouTubeSearch({
        query: trimmed,
        displayName: niceName,
        videoCount:
          pages.reduce((n: number, p: any) => n + (p.videos?.length || 0), 0) ||
          this.videos().length,
        totalPages: Math.max(highest, this.knownTotalPages(), this.page()) || 1,
        videoResults: (pages.length ? pages : null) as any,
      });
      this.toast.show('Saved to MongoDB — green LED will show in History.', 'success');
      await this.loadSaved();
    } catch (err: any) {
      this.toast.show(err?.message || 'Save failed', 'error');
    } finally {
      this.saving.set(false);
    }
  }

  async handleSave() {
    if (
      !this.videos().length &&
      !getAllCachedPagesForQuery(this.activeQuery() || this.query()).length
    ) {
      return;
    }
    await this.persistSave(this.activeQuery() || this.query());
  }

  async handleHistorySave(item: any) {
    await this.persistSave(
      item.displayName || item.query?.replace(/\./g, ' ') || item.query,
    );
  }

  async handleSavedClick(item: any) {
    const q =
      formatYouTubeHistoryLabel(item) ||
      item.displayName ||
      item.query?.replace(/\./g, ' ') ||
      '';
    this.historyOpen.set(false);
    await this.runSearch(q, { pageNum: 1, pageToken: null });
  }

  async handleUnsaveHistory(item: any) {
    if (!item?._id) return;
    try {
      await deleteSavedYouTubeSearch(item._id, undefined, { unsaveOnly: true });
      this.toast.show('Removed from saved (local/Mongo cache pages kept).', 'success');
      await this.loadSaved();
    } catch (err: any) {
      this.toast.show(err?.message || 'Could not remove saved search', 'error');
    }
  }

  requestDeleteHistory(item: any) {
    if (!item) return;
    this.pendingHistoryDelete.set(item);
  }

  async confirmDeleteHistory() {
    const item = this.pendingHistoryDelete();
    this.pendingHistoryDelete.set(null);
    if (!item) return;

    const q = item.displayName || item.query || '';
    const label =
      formatYouTubeHistoryLabel(item) ||
      item.displayName ||
      String(item.query || '').replace(/\./g, ' ') ||
      'search';

    try {
      forgetRecentYouTubeQuery(q);
      clearLocalYouTubeCacheForQuery(q);
      if (item._id) {
        await deleteSavedYouTubeSearch(item._id, undefined, { unsaveOnly: false });
      }
      if (this.activeQuery() && queriesMatch(this.activeQuery(), q)) {
        this.videos.set([]);
        this.hiddenVideoIds.set(new Set());
        this.player.set(null);
        this.activeQuery.set('');
        this.query.set('');
        this.page.set(1);
        this.nextPageToken.set(null);
        this.pageTokens.set([null]);
        this.knownTotalPages.set(0);
        this.knownTotalQuery = '';
        this.cacheSource.set('');
      }
      this.recentLocal.set(listRecentYouTubeQueries());
      await this.loadSaved();
      this.toast.show(`Deleted “${label}” from history, localStorage, and MongoDB.`, 'success');
    } catch (err: any) {
      this.toast.show(err?.message || 'Could not delete history entry', 'error');
      this.recentLocal.set(listRecentYouTubeQueries());
      await this.loadSaved();
    }
  }
}

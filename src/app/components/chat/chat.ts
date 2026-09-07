import { Component, ElementRef, OnDestroy, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MarkdownPipe } from '../../pipes/markdown.pipe';
import { HelpButtonComponent } from '../shared/help/help-button';
import { ClearableInputComponent } from '../shared/clearable-input/clearable-input';
import { AppStateService } from '../../services/app-state.service';
import { ToastService } from '../../services/toast.service';
import { AuthService } from '../../services/auth.service';
import {
  analyzeImage,
  chatWithClaudeApi,
  chatWithOpenAI,
  deleteChatConversation,
  getChatConversation,
  listChatConversations,
  saveChatConversation,
  fetchAllPersonalInfo,
  savePersonalInfoType,
  deletePersonalInfoType,
  searchImages,
} from '../../services/api/client';
import {
  abortAllSpeechRecognition,
  getSavedVoiceId,
  isSpokenAudioComplete,
  onSpokenAudioComplete,
  speakText,
  stopSpeaking,
  togglePauseSpeaking,
} from '../shared/speech/speech';
import { MESSAGES, isExitPhrase } from './messages';
import { ConversationMicController } from './conversation-mic';
import { ChatHistoryModalComponent } from './chat-history-modal';
import { hasPersistableChat, serializeChatMessages, titleFromMessages } from './chat-history';
import { ANDREW_IDENTITY_REPLY, ANDREW_IDENTITY_SYSTEM, isWhoAreYouQuery } from './chat-identity';
import {
  formatChatDateTimeReply,
  matchChatDateTimeQuery,
} from './chat-datetime';
import {
  buildPersonalContextPrompt,
  formatGetFactReply,
  formatGetNameReply,
  formatWhoAmIReply,
  getCachedUserName,
  isGetNameQuery,
  isWhoAmIQuery,
  matchGetFact,
  matchStoreFact,
  matchStoreName,
  matchDeleteFact,
  resolveProfileFactKey,
  setCachedUserName,
} from '../shared/profile/personal-info';
import {
  extractImageSubjectCandidatesFromReply,
  normalizeChatImageList,
  stripImageCapabilityDisclaimers,
  wantsChatImages,
  extractImageSearchSubject,
} from './chat-images';
import { ChatImageThumbComponent, type ChatGalleryImage } from './chat-image-thumb';
import { ChatImageDetailModalComponent } from './chat-image-detail-modal';
import {
  isVoiceInputAllowed,
  isYouTubeAudioLocked,
  onYouTubeAudioLockChange,
} from '../../services/youtube-audio-lock';

const DESCRIBE_IMAGE_PROMPT = 'Describe this image in detail.';
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const IMAGE_SYSTEM_NEED = `CRITICAL — IMAGE REQUEST: A separate UI pipeline already fetches and shows photos below your text. You write TOPIC TEXT ONLY.
Never mention images, pictures, photos, galleries, datasets, Wikimedia, Flickr, or URLs.
Never say you cannot / can't / are unable to display, show, or provide images.
Never add an "Images" section, numbered photo list, markdown images, or "here are image options".
Never offer to fetch higher-resolution images. Just answer the topic.`;

const IMAGE_SYSTEM_DEFAULT = `This app fetches images separately when asked. Never say you cannot provide or display images/pictures/photos. Never list image URLs.`;

type ChatMessage = {
  id: string;
  role: string;
  content: string;
  image?: string;
  imageName?: string;
  images?: ChatGalleryImage[];
  imagesError?: string;
  imageSubject?: string;
  imagesNextStart?: number;
  imagesExhausted?: boolean;
  usedWebSearch?: boolean;
};

type Attachment = { dataUrl: string; fileName: string };

@Component({
  selector: 'app-chat',
  imports: [
    FormsModule,
    MarkdownPipe,
    HelpButtonComponent,
    ClearableInputComponent,
    ChatHistoryModalComponent,
    ChatImageThumbComponent,
    ChatImageDetailModalComponent,
  ],
  templateUrl: './chat.html',
  host: {
    class: 'chat-route',
  },
})
export class ChatComponent implements OnDestroy {
  private readonly appState = inject(AppStateService);
  private readonly toast = inject(ToastService);
  private readonly auth = inject(AuthService);

  messages = signal<ChatMessage[]>([]);
  draft = '';
  loading = signal(false);
  error = signal('');
  attachError = signal('');
  speaking = signal(false);
  isAudioPaused = signal(false);
  uiTick = signal(0);
  attachment: Attachment | null = null;
  historyOpen = signal(false);
  historyItems = signal<any[]>([]);
  historyError = signal('');
  activeConversationId = '';
  loadingMoreImagesId = signal('');
  detailGallery = signal<{ images: ChatGalleryImage[]; index: number } | null>(null);
  youtubeAudioLocked = signal(isYouTubeAudioLocked());
  private readonly messageList = viewChild<ElementRef<HTMLElement>>('messageList');

  private spokenAudioComplete = true;
  private listenResumeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly mic: ConversationMicController;
  private lastClear = 0;
  private unsubscribeSpokenComplete: (() => void) | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private skipPersist = false;
  private profileFacts: Record<string, any> = {};
  private unsubscribeYoutubeLock: (() => void) | null = null;

  constructor() {
    this.mic = new ConversationMicController(
      {
        isLoading: () => this.loading(),
        isSpeaking: () => this.speaking(),
        spokenAudioComplete: () => this.spokenAudioComplete,
        inactivityPromptActive: () => false,
      },
      (text) => {
        if (!isVoiceInputAllowed()) return;
        if (this.loading() && !this.speaking()) {
          this.loading.set(false);
        }
        void this.send(text, true);
      },
    );
    this.mic.setOnChange(() => this.uiTick.update((n) => n + 1));

    this.unsubscribeSpokenComplete = onSpokenAudioComplete(() => {
      this.spokenAudioComplete = true;
      this.speaking.set(false);
      this.isAudioPaused.set(false);
    });

    this.unsubscribeYoutubeLock = onYouTubeAudioLockChange(() => {
      const locked = isYouTubeAudioLocked();
      this.youtubeAudioLocked.set(locked);
      if (locked) this.silenceForYouTube();
    });
    this.youtubeAudioLocked.set(isYouTubeAudioLocked());
    if (this.youtubeAudioLocked()) this.silenceForYouTube();

    effect(() => {
      this.auth.isAuthenticated();
      this.auth.dataKey();
      void this.loadProfileFacts();
    });

    effect(() => {
      const token = this.appState.clearChat();
      if (token && token !== this.lastClear) {
        this.lastClear = token;
        this.clearChat();
      }
    });

    // Keep the latest turn (including Exit goodbye) visible at the bottom.
    effect(() => {
      const count = this.messages().length;
      const loading = this.loading();
      if (!count && !loading) return;
      untracked(() => this.scrollMessagesToBottom());
    });
  }

  /** Pin .message-list to the latest bubble so Exit/Bye replies aren't above the fold. */
  private scrollMessagesToBottom(behavior: ScrollBehavior = 'smooth') {
    const run = () => {
      const el = this.messageList()?.nativeElement;
      if (!el) return;
      el.scrollTo({ top: el.scrollHeight, behavior });
    };
    // Wait for Angular to paint the new bubbles, then settle once more.
    requestAnimationFrame(() => {
      run();
      window.setTimeout(run, 80);
      window.setTimeout(() => run(), 250);
    });
  }

  get conversationMode() {
    return this.mic.conversationMode;
  }

  get isListening() {
    return this.mic.isListening;
  }

  get micWarming() {
    return this.mic.micWarming;
  }

  get micLevel() {
    return this.mic.micLevel;
  }

  get statusText() {
    void this.uiTick();
    return this.mic.statusText;
  }

  get micError() {
    return this.mic.micError;
  }

  get showListening() {
    return (
      this.conversationMode &&
      this.isListening &&
      !this.micWarming &&
      !this.speaking() &&
      !this.loading()
    );
  }

  get showMicOff() {
    return (
      this.conversationMode &&
      !this.micWarming &&
      !this.isListening &&
      !this.speaking() &&
      !this.loading() &&
      /mic off/i.test(String(this.statusText || ''))
    );
  }

  get showMicLevel() {
    return this.conversationMode && !this.micWarming && !this.speaking() && !this.loading();
  }

  get micLevelLow() {
    return this.showMicLevel && this.micLevel > 0 && this.micLevel < 12;
  }

  get showAudioControls() {
    return this.speaking() || this.isAudioPaused();
  }

  get statusToShow() {
    const status = this.statusText;
    if (this.showListening && /listening/i.test(String(status || ''))) return '';
    if (
      this.conversationMode &&
      this.micWarming &&
      /getting ready|starting mic|warmup/i.test(String(status || ''))
    ) {
      return '';
    }
    if (this.speaking() && /speaking|paused/i.test(String(status || ''))) return '';
    return status;
  }

  get inputPlaceholder() {
    if (this.attachment) return 'Ask about this image, or press Send…';
    if (this.loading()) return 'Thinking…';
    if (this.speaking()) return this.isAudioPaused() ? 'Audio paused…' : 'AI is speaking...';
    if (this.micWarming) return 'Getting ready…';
    if (this.conversationMode) return 'Speak or type a message…';
    return 'Type a message…';
  }

  ngOnDestroy() {
    this.clearListenResumeTimer();
    if (this.persistTimer) clearTimeout(this.persistTimer);
    void this.mic.handleConversationModeChange(false);
    this.mic.destroy();
    stopSpeaking();
    this.unsubscribeSpokenComplete?.();
    this.unsubscribeYoutubeLock?.();
  }

  private silenceForYouTube() {
    this.clearListenResumeTimer();
    abortAllSpeechRecognition();
    void this.mic.handleConversationModeChange(false);
    stopSpeaking({ markComplete: true, bumpGeneration: true });
    this.markSpeakingEnded();
    this.loading.set(false);
    this.uiTick.update((n) => n + 1);
  }

  private async endConversation(spokenGoodbye: string) {
    this.clearListenResumeTimer();
    this.mic.stopListening();
    void this.mic.handleConversationModeChange(false);
    stopSpeaking({ markComplete: true, bumpGeneration: true });
    this.isAudioPaused.set(false);
    this.spokenAudioComplete = true;

    const assistantMsg: ChatMessage = {
      id: this.uid(),
      role: 'assistant',
      content: spokenGoodbye,
      usedWebSearch: false,
    };
    this.messages.update((list) => [...list, assistantMsg]);
    this.loading.set(false);
    this.schedulePersist();
    this.scrollMessagesToBottom('smooth');

    try {
      this.markSpeakingStarted();
      this.mic.statusText = MESSAGES.STATUS.AISPEAKING;
      this.uiTick.update((n) => n + 1);
      await speakText(spokenGoodbye, {
        voiceId: this.appState.selectedVoiceId() || getSavedVoiceId(),
      });
    } catch {
      /* toast optional */
    } finally {
      this.markSpeakingEnded();
      if (this.conversationMode) {
        this.scheduleEnterListeningMode(400);
      } else {
        this.mic.statusText = MESSAGES.STATUS.DEFAULT;
        this.uiTick.update((n) => n + 1);
      }
    }
  }

  async send(text = this.draft, fromVoice = false) {
    const trimmed = String(text || '').trim();
    const image = this.attachment?.dataUrl;
    const imageName = this.attachment?.fileName;
    if ((!trimmed && !image) || this.loading()) return;
    if (fromVoice && !isVoiceInputAllowed()) return;

    if (!image && isExitPhrase(trimmed)) {
      this.draft = '';
      this.attachment = null;
      this.attachError.set('');
      const userMsg: ChatMessage = {
        id: this.uid(),
        role: 'user',
        content: trimmed,
      };
      this.messages.update((list) => [...list, userMsg]);
      await this.endConversation(MESSAGES.CLOSINGS.EXIT);
      return;
    }

    const promptText = trimmed || DESCRIBE_IMAGE_PROMPT;
    this.draft = '';
    this.attachment = null;
    this.attachError.set('');

    const userMsg: ChatMessage = {
      id: this.uid(),
      role: 'user',
      content: promptText,
      ...(image ? { image, imageName } : {}),
    };
    this.messages.update((list) => [...list, userMsg]);
    this.loading.set(true);
    this.error.set('');
    this.mic.pauseForTurn();
    this.mic.statusText = image ? MESSAGES.STATUS.LOOKING_AT_IMAGE : MESSAGES.STATUS.THINKING;
    this.uiTick.update((n) => n + 1);

    const needImages = !image && wantsChatImages(trimmed);
    const imageSubject = needImages ? extractImageSearchSubject(trimmed) : '';
    const imagesPromise = needImages
      ? this.fetchChatImages(imageSubject).catch((err) => {
          console.error('[chat images]', err);
          return { error: err?.message || 'Image search failed', images: [] as ChatGalleryImage[] };
        })
      : Promise.resolve(null);

    try {
      let replyText: string;
      let usedWebSearch = false;
      if (image) {
        replyText =
          (await analyzeImage({ image, prompt: promptText })) ||
          "I couldn't make anything out in that image.";
      } else {
        const localReply = await this.resolveProfileReply(promptText);
        if (localReply != null) {
          replyText = localReply;
        } else {
          const dateTimeKind = matchChatDateTimeQuery(promptText);
          if (dateTimeKind) {
            replyText = formatChatDateTimeReply(dateTimeKind);
          } else {
            const history = this.messages()
              .filter((m) => m.id !== userMsg.id)
              .map((m) => ({ role: m.role, content: m.content }));
            await this.loadProfileFacts();
            const personalSystem = buildPersonalContextPrompt(this.profileFacts);
            const imageSystem = needImages ? IMAGE_SYSTEM_NEED : IMAGE_SYSTEM_DEFAULT;
            const systemPrompt = [
              ANDREW_IDENTITY_SYSTEM,
              'Answer the user\'s question clearly and directly.',
              'Use the optional user profile below only for personal questions about the user themselves.',
              imageSystem,
              personalSystem,
            ].join('\n\n');
            const model = this.appState.selectedModel();
            const result =
              model === 'claude'
                ? await chatWithClaudeApi(
                    [...history, { role: 'user', content: promptText }],
                    systemPrompt,
                  )
                : await chatWithOpenAI({
                    message: promptText,
                    history: history as any,
                    systemPrompt,
                  });
            replyText = result.text || '(No response)';
            usedWebSearch = Boolean((result as any).usedWebSearch);
          }
        }
      }

      if (needImages) {
        replyText = stripImageCapabilityDisclaimers(replyText);
      }

      const assistantId = this.uid();
      const reply: ChatMessage = {
        id: assistantId,
        role: 'assistant',
        content: replyText,
        usedWebSearch,
      };
      this.messages.update((list) => [...list, reply]);
      this.loading.set(false);
      this.schedulePersist();

      void this.resolveChatImages({
        needImages,
        imageSubject,
        imagesPromise,
        reply: replyText,
        messageId: assistantId,
      });

      if ((fromVoice || this.conversationMode) && isVoiceInputAllowed()) {
        this.markSpeakingStarted();
        this.mic.statusText = MESSAGES.STATUS.AISPEAKING;
        this.uiTick.update((n) => n + 1);
        try {
          await speakText(reply.content, {
            voiceId: this.appState.selectedVoiceId() || getSavedVoiceId(),
          });
        } catch {
          /* toast optional */
        } finally {
          this.markSpeakingEnded();
        }
      }

      if (this.conversationMode) {
        this.scheduleEnterListeningMode(650);
      } else {
        this.mic.statusText = MESSAGES.STATUS.DEFAULT;
        this.uiTick.update((n) => n + 1);
      }
    } catch (err: any) {
      this.error.set(err?.message || 'Chat failed');
      this.mic.statusText = MESSAGES.STATUS.ERROR;
      this.markSpeakingEnded();
      this.loading.set(false);
      if (this.conversationMode) this.scheduleEnterListeningMode(450);
      this.uiTick.update((n) => n + 1);
    }
  }

  onSubmit(event: Event) {
    event.preventDefault();
    void this.send();
  }

  onConversationMode(event: Event) {
    const enabled = (event.target as HTMLInputElement).checked;
    void this.mic.handleConversationModeChange(enabled);
  }

  stopAudio() {
    this.clearListenResumeTimer();
    this.isAudioPaused.set(false);
    stopSpeaking({ markComplete: true, bumpGeneration: true });
    this.markSpeakingEnded();
    this.loading.set(false);
    this.mic.pauseForTurn();
    if (this.conversationMode) {
      this.mic.statusText = this.micWarming
        ? MESSAGES.STATUS.MIC_WARMUP
        : MESSAGES.STATUS.LISTENING;
      this.scheduleEnterListeningMode(500);
    } else {
      this.mic.statusText = MESSAGES.STATUS.DEFAULT;
    }
    this.uiTick.update((n) => n + 1);
  }

  togglePauseAudio() {
    const result = togglePauseSpeaking();
    if (result === 'paused') {
      this.isAudioPaused.set(true);
      this.mic.statusText = 'Paused';
    } else if (result === 'resumed') {
      this.isAudioPaused.set(false);
      this.mic.statusText = MESSAGES.STATUS.AISPEAKING;
    }
    this.uiTick.update((n) => n + 1);
  }

  onAttachChange(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      this.attachError.set('Please choose an image file (JPEG, PNG, WebP, etc.).');
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      this.attachError.set('That image is too large (max 10MB). Try a smaller photo.');
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      if (!dataUrl.startsWith('data:image')) {
        this.attachError.set('Could not read that image.');
        return;
      }
      this.attachment = { dataUrl, fileName: file.name };
      this.attachError.set('');
    };
    reader.onerror = () => this.attachError.set('Could not read that image.');
    reader.readAsDataURL(file);
  }

  removeAttachment() {
    this.attachment = null;
    this.attachError.set('');
  }

  clearChat() {
    this.clearListenResumeTimer();
    void this.persistConversation();
    this.mic.stopListening();
    void this.mic.handleConversationModeChange(false);
    this.messages.set([]);
    this.error.set('');
    this.attachError.set('');
    this.draft = '';
    this.attachment = null;
    this.activeConversationId = '';
    stopSpeaking();
    this.speaking.set(false);
    this.isAudioPaused.set(false);
    this.uiTick.update((n) => n + 1);
  }

  openHistory() {
    if (this.auth.isGuest() || !this.auth.isAuthenticated()) {
      this.toast.show('Sign in to save and browse conversation history.', 'info');
      return;
    }
    this.historyOpen.set(true);
    void this.loadHistoryList();
  }

  async loadHistoryList() {
    if (this.auth.isGuest() || !this.auth.isAuthenticated()) {
      this.historyItems.set([]);
      this.historyError.set('');
      return;
    }
    this.historyError.set('');
    try {
      await this.auth.refreshSession();
      this.historyItems.set(await listChatConversations());
    } catch (err: any) {
      this.historyItems.set([]);
      this.historyError.set(err?.message || 'Could not load conversation history');
    }
  }

  async onSelectHistory(item: any) {
    const id = item?._id;
    if (!id) return;
    try {
      await this.persistConversation();
      this.skipPersist = true;
      const full = await getChatConversation(id);
      const msgs = Array.isArray(full.messages) ? full.messages : [];
      this.activeConversationId = String(full._id);
      this.messages.set(msgs);
      this.historyOpen.set(false);
      window.setTimeout(() => {
        this.skipPersist = false;
      }, 800);
    } catch (err: any) {
      this.skipPersist = false;
      this.toast.show(err?.message || 'Could not open conversation', 'error');
    }
  }

  async onDeleteHistory(item: any) {
    if (!item?._id) return;
    try {
      await deleteChatConversation(item._id);
      this.historyItems.update((list) => list.filter((c) => String(c._id) !== String(item._id)));
      if (String(this.activeConversationId) === String(item._id)) {
        this.messages.set([]);
        this.activeConversationId = '';
      }
    } catch (err: any) {
      this.toast.show(err?.message || 'Could not delete conversation', 'error');
    }
  }

  private async loadProfileFacts() {
    try {
      const data = await fetchAllPersonalInfo();
      this.profileFacts = data && typeof data === 'object' ? data : {};
      if (this.profileFacts['name']) {
        setCachedUserName(String(this.profileFacts['name']));
      }
    } catch {
      this.profileFacts = {};
    }
  }

  private async resolveProfileReply(trimmed: string): Promise<string | null> {
    const storeName = matchStoreName(trimmed);
    const storeFact = matchStoreFact(trimmed);
    const deleteFact = matchDeleteFact(trimmed);
    const getFactKey = matchGetFact(trimmed);

    if (storeName) {
      if (this.auth.isGuest() || !this.auth.isAuthenticated()) {
        return "Guest mode can't save a profile. Sign in to have me remember your name.";
      }
      try {
        await savePersonalInfoType('name', storeName);
      } catch {
        /* still remember locally */
      }
      setCachedUserName(storeName);
      this.profileFacts = { ...this.profileFacts, name: storeName };
      return `I'll remember that your name is ${storeName}.`;
    }

    if (storeFact) {
      if (this.auth.isGuest() || !this.auth.isAuthenticated()) {
        return "Guest mode can't save a profile. Sign in to have me remember details about you.";
      }
      try {
        await savePersonalInfoType(storeFact.key, storeFact.value);
      } catch {
        /* still remember locally */
      }
      this.profileFacts = { ...this.profileFacts, [storeFact.key]: storeFact.value };
      return `I'll remember that your ${storeFact.key} is ${storeFact.value}.`;
    }

    if (deleteFact) {
      if (this.auth.isGuest() || !this.auth.isAuthenticated()) {
        return "Guest mode can't change a profile. Sign in to remove saved details.";
      }
      let profile = this.profileFacts;
      try {
        const fresh = await fetchAllPersonalInfo();
        if (fresh && typeof fresh === 'object') {
          profile = fresh;
          this.profileFacts = fresh;
        }
      } catch {
        /* use cached profileFacts */
      }
      const key = resolveProfileFactKey(profile, deleteFact);
      if (!key) {
        return `I don't have “${deleteFact.replace(/_/g, ' ')}” saved on your profile.`;
      }
      try {
        await deletePersonalInfoType(key);
      } catch (err: any) {
        return err?.message || `I couldn't remove your ${key.replace(/_/g, ' ')}.`;
      }
      const next = { ...this.profileFacts };
      delete next[key];
      this.profileFacts = next;
      if (key === 'name') setCachedUserName('');
      return `I've removed your ${key.replace(/_/g, ' ')} from your profile.`;
    }

    if (isWhoAreYouQuery(trimmed)) {
      return ANDREW_IDENTITY_REPLY;
    }

    if (isWhoAmIQuery(trimmed) || isGetNameQuery(trimmed) || getFactKey != null) {
      let profile = this.profileFacts;
      try {
        const fresh = await fetchAllPersonalInfo();
        if (fresh && typeof fresh === 'object') {
          profile = fresh;
          this.profileFacts = fresh;
          if (fresh['name']) setCachedUserName(String(fresh['name']));
        }
      } catch {
        /* use cached profileFacts */
      }
      if (isWhoAmIQuery(trimmed)) return formatWhoAmIReply(profile);
      if (isGetNameQuery(trimmed)) {
        return formatGetNameReply(profile['name'] || getCachedUserName());
      }
      return formatGetFactReply(getFactKey, profile);
    }

    return null;
  }

  private schedulePersist() {
    if (this.auth.isGuest() || !this.auth.isAuthenticated() || this.skipPersist) return;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persistConversation();
    }, 700);
  }

  private async persistConversation(msgs = this.messages()) {
    if (this.auth.isGuest() || !this.auth.isAuthenticated()) return null;
    if (!hasPersistableChat(msgs)) return null;
    try {
      await this.auth.refreshSession();
      const saved = await saveChatConversation({
        id: this.activeConversationId || undefined,
        title: titleFromMessages(msgs),
        messages: serializeChatMessages(msgs),
      });
      const id = saved?._id ? String(saved._id) : '';
      if (id) this.activeConversationId = id;
      return saved;
    } catch {
      return null;
    }
  }

  private markSpeakingStarted() {
    this.clearListenResumeTimer();
    this.spokenAudioComplete = false;
    this.speaking.set(true);
    this.isAudioPaused.set(false);
  }

  private markSpeakingEnded() {
    this.spokenAudioComplete = isSpokenAudioComplete();
    this.speaking.set(false);
    this.isAudioPaused.set(false);
  }

  private clearListenResumeTimer() {
    if (this.listenResumeTimer) {
      clearTimeout(this.listenResumeTimer);
      this.listenResumeTimer = null;
    }
  }

  private scheduleEnterListeningMode(delayMs = 650) {
    this.clearListenResumeTimer();
    if (!this.conversationMode) return;
    this.listenResumeTimer = setTimeout(() => {
      this.listenResumeTimer = null;
      if (
        this.conversationMode &&
        !this.loading() &&
        !this.speaking() &&
        this.spokenAudioComplete
      ) {
        void this.mic.enterListeningMode();
      }
    }, delayMs);
  }

  private uid() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  openMicSettings(event: Event) {
    event.preventDefault();
    const ua = navigator.userAgent || '';
    if (/Windows/i.test(ua)) {
      window.location.href = 'ms-settings:sound';
      return;
    }
    if (/Mac/i.test(ua)) {
      window.location.href = 'x-apple.systempreferences:com.apple.preference.sound';
      return;
    }
    window.alert('Open your system Sound settings and set microphone volume to 50% or higher.');
  }

  openImageDetail(images: ChatGalleryImage[], index: number) {
    this.detailGallery.set({ images, index });
  }

  closeImageDetail() {
    this.detailGallery.set(null);
  }

  loadMoreImages(messageId: string) {
    void this.handleLoadMoreImages(messageId);
  }

  private async fetchChatImages(
    subject: string,
    { timeoutMs = 12_000 }: { timeoutMs?: number } = {},
  ) {
    const work = async () => {
      const first = await searchImages(subject, { start: 1 });
      let list = normalizeChatImageList(first);
      let nextStart = first.nextStart || 11;
      if (list.length < 10) {
        try {
          const second = await searchImages(subject, { start: nextStart });
          const more = normalizeChatImageList(second);
          nextStart = second.nextStart || nextStart + 10;
          const seen = new Set(list.map((i: ChatGalleryImage) => i.url || i.thumb));
          for (const img of more) {
            const key = img.url || img.thumb;
            if (!key || seen.has(key)) continue;
            seen.add(key);
            list.push(img);
            if (list.length >= 10) break;
          }
        } catch {
          /* keep first page */
        }
      }
      return { images: list.slice(0, 10), nextStart };
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Image search timed out')), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private applyImagesToMessage(
    messageId: string,
    images: ChatGalleryImage[] | undefined,
    imagesError: string | undefined,
    pagination: { subject?: string; nextStart?: number } = {},
  ) {
    this.messages.update((prev) =>
      prev.map((msg) => {
        if (msg.id !== messageId) return msg;
        const next: ChatMessage = { ...msg };
        if (images?.length) next.images = images;
        else delete next.images;
        if (imagesError) next.imagesError = imagesError;
        else delete next.imagesError;
        if (images?.length && pagination.subject) {
          next.imageSubject = pagination.subject;
          next.imagesNextStart = pagination.nextStart || 11;
        }
        return next;
      }),
    );
    this.schedulePersist();
  }

  private async resolveChatImages({
    needImages,
    imageSubject,
    imagesPromise,
    reply,
    messageId,
  }: {
    needImages: boolean;
    imageSubject: string;
    imagesPromise: Promise<{ images?: ChatGalleryImage[]; nextStart?: number; error?: string } | null>;
    reply: string;
    messageId: string;
  }) {
    if (!needImages) return;

    let images: ChatGalleryImage[] | undefined;
    let imagesError: string | undefined;
    let usedSubject = imageSubject;
    let nextStart: number | undefined;

    try {
      const imageResult = await imagesPromise;
      if (Array.isArray(imageResult?.images)) {
        images = imageResult.images;
        nextStart = imageResult.nextStart;
      } else if (imageResult?.error) {
        images = [];
        imagesError = imageResult.error;
      }
    } catch (err: any) {
      images = [];
      imagesError = err?.message || 'Image search failed';
    }

    if (!images || images.length === 0) {
      const candidates = extractImageSubjectCandidatesFromReply(reply);
      for (const fromReply of candidates) {
        if (
          !fromReply ||
          fromReply.toLowerCase() === String(imageSubject || '').toLowerCase()
        ) {
          continue;
        }
        try {
          const retry = await this.fetchChatImages(fromReply, { timeoutMs: 10_000 });
          if (retry.images.length > 0) {
            images = retry.images;
            nextStart = retry.nextStart;
            usedSubject = fromReply;
            imagesError = undefined;
            break;
          }
        } catch (retryErr: any) {
          if (!imagesError) {
            imagesError = retryErr?.message || 'Image search failed';
          }
        }
      }
    }

    if (!Array.isArray(images)) images = [];
    if (images.length === 0 && !imagesError) {
      imagesError = 'No images found for that topic.';
    } else if (images.length === 0 && imagesError) {
      if (/Custom Search|does not have the access|timed out/i.test(imagesError)) {
        imagesError = 'No images found for that topic.';
      }
    } else if (images.length > 0 && images.length < 10) {
      imagesError = `Only found ${images.length} images.`;
    } else if (images.length > 0) {
      imagesError = undefined;
    }

    this.applyImagesToMessage(messageId, images, imagesError, {
      subject: usedSubject,
      nextStart,
    });
  }

  private async handleLoadMoreImages(messageId: string) {
    const message = this.messages().find((m) => m.id === messageId);
    if (!message?.imageSubject) return;

    const imageKey = (img: ChatGalleryImage) =>
      img.originalUrl || img.url || img.thumb || '';

    this.loadingMoreImagesId.set(messageId);
    const maxPages = 3;
    let start = message.imagesNextStart || 11;
    let cursor = start;
    let added: ChatGalleryImage[] = [];
    let lastNextStart = start;
    let lastError = '';

    try {
      for (let page = 0; page < maxPages && added.length === 0; page++) {
        try {
          const result = await searchImages(message.imageSubject, { start: cursor });
          const fetched = normalizeChatImageList(result);
          lastNextStart = result.nextStart || cursor + 10;
          const existing = Array.isArray(message.images) ? message.images : [];
          const seen = new Set(
            [...existing, ...added].map(imageKey).filter(Boolean),
          );
          for (const img of fetched) {
            const key = imageKey(img);
            if (!key || seen.has(key)) continue;
            seen.add(key);
            added.push(img);
          }
          cursor = lastNextStart;
          if (fetched.length === 0) break;
        } catch (err: any) {
          lastError = err?.message || 'Could not load more images.';
          break;
        }
      }

      this.messages.update((prev) =>
        prev.map((msg) => {
          if (msg.id !== messageId) return msg;
          const existing = Array.isArray(msg.images) ? msg.images : [];
          const next: ChatMessage = {
            ...msg,
            imagesNextStart: lastNextStart,
          };
          if (added.length > 0) {
            next.images = [...existing, ...added];
            delete next.imagesError;
            delete next.imagesExhausted;
          } else if (lastError) {
            next.imagesError = lastError;
          } else {
            next.imagesExhausted = true;
            next.imagesError = 'No more images for this topic.';
          }
          return next;
        }),
      );
      this.schedulePersist();
    } finally {
      this.loadingMoreImagesId.set('');
    }
  }
}

import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HelpButtonComponent } from '../shared/help/help-button';
import { ConfirmModalComponent } from '../shared/confirm-modal/confirm-modal';
import { AuthService } from '../../services/auth.service';
import { AiStatusService } from '../../services/ai-status.service';
import { askRag, deleteRagDocument, listRagDocuments, uploadRagDocument } from '../../services/api/client';
import { RagAnswerModalComponent } from './rag-answer-modal';

@Component({
  selector: 'app-rag',
  imports: [FormsModule, HelpButtonComponent, ConfirmModalComponent, RagAnswerModalComponent],
  templateUrl: './rag.html',
})
export class RagComponent implements OnInit {
  readonly auth = inject(AuthService);
  readonly aiStatus = inject(AiStatusService);
  documents = signal<any[]>([]);
  selectedIds = signal<string[]>([]);
  listLoading = signal(true);
  uploading = signal(false);
  uploadError = signal('');
  asking = signal(false);
  askError = signal('');
  answer = signal('');
  askedQuestion = signal('');
  sources = signal<any[]>([]);
  answerOpen = signal(false);
  question = '';
  pendingDelete = signal<any>(null);

  readonly readyDocs = computed(() =>
    this.documents().filter((d) => d.status !== 'processing' && d.status !== 'error'),
  );
  readonly selectedSet = computed(() => new Set(this.selectedIds()));
  readonly allDocsSelected = computed(() => {
    const ready = this.readyDocs();
    if (!ready.length) return false;
    const selected = this.selectedSet();
    return ready.every((d) => selected.has(d.id));
  });
  readonly canAsk = computed(() => this.selectedIds().length > 0);
  readonly ragLimits = computed(() => this.aiStatus.status()?.limits?.rag || null);
  readonly maxUploadMb = computed(() => this.ragLimits()?.maxUploadMb ?? 50);

  ngOnInit() {
    void this.refresh();
  }

  isSelected(id: string) {
    return this.selectedSet().has(id);
  }

  isLocked(doc: any) {
    return doc?.status === 'processing' || doc?.status === 'error';
  }

  setDocSelected(id: string, checked: boolean) {
    const doc = this.documents().find((d) => d.id === id);
    if (this.isLocked(doc)) return;
    const current = this.selectedIds();
    const has = current.includes(id);
    if (checked && !has) this.selectedIds.set([...current, id]);
    if (!checked && has) this.selectedIds.set(current.filter((x) => x !== id));
  }

  toggleAllDocs() {
    if (this.allDocsSelected()) {
      this.selectedIds.set([]);
      return;
    }
    this.selectedIds.set(this.readyDocs().map((d) => d.id));
  }

  async refresh() {
    this.listLoading.set(true);
    try {
      const docs = await listRagDocuments(this.auth.dataKey());
      this.documents.set(docs);
      const known = new Set(docs.map((d: any) => d.id));
      this.selectedIds.update((ids) => ids.filter((id) => known.has(id)));
    } catch {
      /* ignore */
    } finally {
      this.listLoading.set(false);
    }
  }

  async onUpload(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (!file.size) {
      this.uploadError.set(
        'That file looks empty or is OneDrive online-only. Right-click it in File Explorer → Always keep on this device, then try again.',
      );
      return;
    }
    const maxMb = this.maxUploadMb();
    if (file.size > maxMb * 1024 * 1024) {
      this.uploadError.set(
        `File is too large (${Math.round(file.size / (1024 * 1024))} MB). Max is ${maxMb} MB.`,
      );
      return;
    }
    this.uploading.set(true);
    this.uploadError.set('');
    try {
      const doc = await uploadRagDocument(file, this.auth.dataKey());
      await this.refresh();
      if (doc?.id && doc.status === 'ready') {
        this.selectedIds.update((ids) => (ids.includes(doc.id) ? ids : [...ids, doc.id]));
      }
    } catch (err: any) {
      this.uploadError.set(err?.message || 'Upload failed');
    } finally {
      this.uploading.set(false);
    }
  }

  async confirmDelete() {
    const doc = this.pendingDelete();
    this.pendingDelete.set(null);
    if (!doc) return;
    try {
      await deleteRagDocument(doc.id, this.auth.dataKey());
      this.selectedIds.update((ids) => ids.filter((id) => id !== doc.id));
      await this.refresh();
    } catch (err: any) {
      this.uploadError.set(err?.message || 'Delete failed');
    }
  }

  askPlaceholder() {
    if (!this.readyDocs().length) return 'Upload a document first…';
    if (!this.selectedIds().length) return 'Select one or more documents, or turn on All docs…';
    return 'Ask something about your uploaded document… (Enter to ask, Shift+Enter for a new line)';
  }

  onAskKeyDown(event: KeyboardEvent) {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    void this.ask(event);
  }

  async ask(event: Event) {
    event.preventDefault();
    const q = this.question.trim();
    if (!q || !this.canAsk()) return;
    this.asking.set(true);
    this.askError.set('');
    this.answer.set('');
    this.sources.set([]);
    this.askedQuestion.set(q);
    try {
      const result = await askRag({
        question: q,
        documentIds: this.selectedIds(),
        dataKey: this.auth.dataKey(),
      });
      this.answer.set(result.answer || '');
      this.sources.set(result.sources || []);
    } catch (err: any) {
      this.askError.set(err?.message || 'Ask failed');
    } finally {
      this.asking.set(false);
    }
  }
}

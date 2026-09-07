import { DOCUMENT } from '@angular/common';
import {
  AfterViewInit,
  Component,
  ElementRef,
  HostListener,
  inject,
  input,
  OnDestroy,
  output,
} from '@angular/core';
import { ModalCloseButtonComponent } from '../modal-close-button/modal-close-button';
import { getHelpTopic, resolveHelpLimits } from './ai-help-content';
import { AiStatusService } from '../../../services/ai-status.service';

@Component({
  selector: 'app-help-modal',
  imports: [ModalCloseButtonComponent],
  templateUrl: './help-modal.html',
})
export class HelpModalComponent implements AfterViewInit, OnDestroy {
  private readonly document = inject(DOCUMENT);
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly aiStatus = inject(AiStatusService);
  open = input(false);
  topic = input('');
  closed = output();

  ngAfterViewInit() {
    // Port to body so fixed overlay covers header (MERN createPortal parity).
    this.document.body.appendChild(this.host.nativeElement);
  }

  ngOnDestroy() {
    this.host.nativeElement.remove();
  }

  get content() {
    return getHelpTopic(this.topic());
  }

  get limitLines(): string[] {
    return resolveHelpLimits(this.topic(), this.aiStatus.status()) || [];
  }

  get loading() {
    return this.aiStatus.loading();
  }

  get error() {
    return this.aiStatus.error();
  }

  @HostListener('document:keydown.escape')
  onEscape() {
    if (this.open()) this.closed.emit();
  }
}

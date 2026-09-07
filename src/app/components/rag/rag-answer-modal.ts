import { DOCUMENT } from '@angular/common';
import {
  AfterViewInit,
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  inject,
  input,
  output,
} from '@angular/core';
import { ModalCloseButtonComponent } from '../shared/modal-close-button/modal-close-button';

@Component({
  selector: 'app-rag-answer-modal',
  imports: [ModalCloseButtonComponent],
  templateUrl: './rag-answer-modal.html',
})
export class RagAnswerModalComponent implements AfterViewInit, OnDestroy {
  private readonly document = inject(DOCUMENT);
  private readonly host = inject(ElementRef<HTMLElement>);

  open = input(false);
  question = input('');
  answer = input('');
  sources = input<any[]>([]);
  closed = output();

  ngAfterViewInit() {
    this.document.body.appendChild(this.host.nativeElement);
  }

  ngOnDestroy() {
    this.host.nativeElement.remove();
  }

  @HostListener('document:keydown.escape')
  onEscape() {
    if (this.open()) this.closed.emit();
  }

  closeFromBackdrop() {
    this.closed.emit();
  }

  stop(event: Event) {
    event.stopPropagation();
  }

  print() {
    this.document.defaultView?.print();
  }
}

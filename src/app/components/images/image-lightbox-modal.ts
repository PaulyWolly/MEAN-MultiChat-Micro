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
  selector: 'app-image-lightbox-modal',
  imports: [ModalCloseButtonComponent],
  templateUrl: './image-lightbox-modal.html',
})
export class ImageLightboxModalComponent implements AfterViewInit, OnDestroy {
  private readonly document = inject(DOCUMENT);
  private readonly host = inject(ElementRef<HTMLElement>);

  open = input(false);
  src = input('');
  alt = input('Image');
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
}

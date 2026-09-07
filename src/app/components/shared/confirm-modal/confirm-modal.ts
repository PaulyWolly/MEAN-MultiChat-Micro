import { DOCUMENT } from '@angular/common';
import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  inject,
  input,
  output,
} from '@angular/core';
import { ModalCloseButtonComponent } from '../modal-close-button/modal-close-button';

@Component({
  selector: 'app-confirm-modal',
  imports: [ModalCloseButtonComponent],
  templateUrl: './confirm-modal.html',
})
export class ConfirmModalComponent implements AfterViewInit, OnDestroy {
  private readonly document = inject(DOCUMENT);
  private readonly host = inject(ElementRef<HTMLElement>);

  open = input(false);
  title = input('Confirm Action');
  message = input('Are you sure?');
  countdown = input('');
  confirmText = input('Confirm');
  cancelText = input('');
  confirmVariant = input<'danger' | 'accent'>('danger');
  confirmed = output();
  cancelled = output();

  ngAfterViewInit() {
    this.document.body.appendChild(this.host.nativeElement);
  }

  ngOnDestroy() {
    this.host.nativeElement.remove();
  }
}

import { Component, input, output } from '@angular/core';

@Component({
  selector: 'app-modal-close-button',
  templateUrl: './modal-close-button.html',
})
export class ModalCloseButtonComponent {
  extraClass = input('', { alias: 'className' });
  closed = output({ alias: 'close' });
}

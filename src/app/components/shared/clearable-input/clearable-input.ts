import { Component, input, model, output } from '@angular/core';

@Component({
  selector: 'app-clearable-input',
  templateUrl: './clearable-input.html',
})
export class ClearableInputComponent {
  value = model('');
  placeholder = input('');
  ariaLabel = input('');
  inputType = input('text');
  multiline = input(false);
  rows = input(4);
  extraClass = input('');
  disabled = input(false);
  hasLeading = input(false);
  inputId = input('');
  cleared = output();

  onInput(event: Event) {
    const el = event.target as HTMLInputElement | HTMLTextAreaElement;
    this.value.set(el.value);
  }

  clear(event: Event) {
    event.preventDefault();
    event.stopPropagation();
    this.value.set('');
    this.cleared.emit();
  }
}

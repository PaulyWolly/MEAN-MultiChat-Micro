import { Component, input, signal } from '@angular/core';
import { HelpModalComponent } from './help-modal';
import { getHelpTopic } from './ai-help-content';

@Component({
  selector: 'app-help-button',
  imports: [HelpModalComponent],
  templateUrl: './help-button.html',
})
export class HelpButtonComponent {
  topic = input.required<string>();
  open = signal(false);

  get label() {
    return getHelpTopic(this.topic())?.title || 'this tool';
  }
}

import { Component, inject } from '@angular/core';
import { ToastService } from '../../../services/toast.service';

@Component({
  selector: 'app-toast-stack',
  templateUrl: './toast-stack.html',
})
export class ToastStackComponent {
  readonly toast = inject(ToastService);
}

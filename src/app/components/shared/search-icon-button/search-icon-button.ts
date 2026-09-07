import { Component, input } from '@angular/core';

@Component({
  selector: 'app-search-icon-button',
  templateUrl: './search-icon-button.html',
})
export class SearchIconButtonComponent {
  loading = input(false);
  disabled = input(false);
}

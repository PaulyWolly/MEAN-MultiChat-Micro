import { Component, input, output } from '@angular/core';

@Component({
  selector: 'app-youtube-pager',
  templateUrl: './youtube-pager.html',
})
export class YouTubePagerComponent {
  page = input(1);
  loading = input(false);
  canFirst = input(false);
  canPrev = input(false);
  canNext = input(false);
  canLast = input(false);
  extraClass = input('');
  first = output();
  prev = output();
  next = output();
  last = output();
}

import { Component, input, output } from '@angular/core';

@Component({
  selector: 'app-image-expandable-preview',
  templateUrl: './image-expandable-preview.html',
})
export class ImageExpandablePreviewComponent {
  src = input('');
  alt = input('Image');
  extraClass = input('');
  enlarge = output();
}

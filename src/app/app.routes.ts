import { Routes } from '@angular/router';
import { accessGuard } from './guards/access.guard';
import { ChatComponent } from './components/chat/chat';
import { YouTubeComponent } from './components/youtube/youtube';
import { RecipesComponent } from './components/recipes/recipes';
import { JokesComponent } from './components/jokes/jokes';
import { ImagesComponent } from './components/images/images';
import { RagComponent } from './components/rag/rag';
import { MediaComponent } from './components/media/media';
import { AboutComponent } from './components/about/about';
import { LoginComponent } from './components/login/login';
import { UsersDemoComponent } from './components/demo/users-demo';

export const routes: Routes = [
  { path: '', component: ChatComponent, canActivate: [accessGuard], data: { allowGuest: true } },
  { path: 'youtube', component: YouTubeComponent, canActivate: [accessGuard] },
  { path: 'recipes', component: RecipesComponent, canActivate: [accessGuard] },
  { path: 'jokes', component: JokesComponent, canActivate: [accessGuard] },
  { path: 'images', component: ImagesComponent, canActivate: [accessGuard], data: { allowGuest: true } },
  { path: 'rag', component: RagComponent, canActivate: [accessGuard], data: { allowGuest: true } },
  { path: 'media', component: MediaComponent, canActivate: [accessGuard] },
  { path: 'about', component: AboutComponent, canActivate: [accessGuard], data: { allowGuest: true } },
  {
    path: 'demo/users',
    component: UsersDemoComponent,
    canActivate: [accessGuard],
    data: { allowGuest: true },
  },
  { path: 'login', component: LoginComponent },
  { path: '**', redirectTo: '' },
];

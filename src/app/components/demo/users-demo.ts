import { Component, inject } from '@angular/core';
import { AsyncPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { MatTableModule } from '@angular/material/table';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import {
  JsonPlaceholderUsersService,
  JsonPlaceholderUser,
} from '../../services/jsonplaceholder-users.service';
import { catchError, map, of, startWith } from 'rxjs';

type UsersDemoState = {
  loading: boolean;
  error: string;
  users: JsonPlaceholderUser[];
};

@Component({
  selector: 'app-users-demo',
  imports: [RouterLink, MatTableModule, MatProgressSpinnerModule, AsyncPipe],
  templateUrl: './users-demo.html',
  styleUrl: './users-demo.css',
})
export class UsersDemoComponent {
  private readonly usersApi = inject(JsonPlaceholderUsersService);

  readonly displayedColumns = [
    'id',
    'name',
    'username',
    'email',
    'phone',
    'website',
    'company',
  ] as const;

  /** Single stream for loading / error / rows (classic Observable + async pipe). */
  readonly state$ = this.usersApi.getUsers().pipe(
    map(
      (users): UsersDemoState => ({
        loading: false,
        error: '',
        users: users.slice(0, 10), // limit the number of users to 10
      }),
    ),
    startWith<UsersDemoState>({ loading: true, error: '', users: [] }),
    catchError((err) =>
      of({
        loading: false,
        error: err?.message || 'Failed to load users from JSONPlaceholder',
        users: [],
      } satisfies UsersDemoState),
    ),
  );
}

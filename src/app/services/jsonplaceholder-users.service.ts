import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

/** Model/Shape of a user returned by https://jsonplaceholder.typicode.com/users */
export type JsonPlaceholderUser = {
  id: number;
  name: string;
  username: string;
  email: string;
  phone: string;
  website: string;
  company?: { name: string };
  address?: {
    city?: string;
    zipcode?: string;
  };
};

@Injectable({ providedIn: 'root' })
export class JsonPlaceholderUsersService {
  private readonly http = inject(HttpClient);
  private readonly url = 'https://jsonplaceholder.typicode.com/users';

  /** Observable of all users (JSONPlaceholder returns 10). */
  getUsers(): Observable<JsonPlaceholderUser[]> {
    return this.http.get<JsonPlaceholderUser[]>(this.url);
  }
}

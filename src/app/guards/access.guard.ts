import { inject } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { CanActivateFn, Router } from '@angular/router';
import { filter, firstValueFrom, take } from 'rxjs';
import { AuthService } from '../services/auth.service';

export const accessGuard: CanActivateFn = async (route) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const allowGuest = route.data['allowGuest'] === true;

  if (!auth.ready()) {
    await firstValueFrom(toObservable(auth.ready).pipe(filter(Boolean), take(1)));
  }

  if (auth.isAuthenticated()) return true;
  if (allowGuest && auth.isGuest()) return true;
  return router.createUrlTree(['/login']);
};

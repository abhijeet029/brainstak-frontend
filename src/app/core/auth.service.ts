import { HttpClient } from '@angular/common/http';
import { Injectable, Injector, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, finalize, from, map, of, switchMap, tap } from 'rxjs';
import { environment } from '../../environments/environment';
import { User } from './models';
import { EncryptionService } from './encryption.service';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private http = inject(HttpClient);
  private router = inject(Router);
  private encryption = inject(EncryptionService);
  // Injector kept so we can lazily resolve ChatService / ProjectService
  // without creating a circular dependency at module load time.
  private injector = inject(Injector);
  private base = environment.apiUrl + '/v1';

  readonly user = signal<User | null>(null);
  readonly loading = signal<boolean>(true);

  /** Try to load the current session on app start. */
  bootstrap() {
    return this.http.get<{ user: User }>(`${this.base}/auth/me`).pipe(
      tap((res) => this.user.set(res?.user ?? null)),
      tap(() => { void this.encryption.init(); }),
      catchError(() => {
        this.user.set(null);
        return of(null);
      }),
      finalize(() => this.loading.set(false)),
    );
  }

  loginWithGoogle(idToken: string) {
    return this.http
      .post<{ user: User }>(`${this.base}/auth/google`, { idToken })
      .pipe(
        tap((res) => this.user.set(res.user)),
        switchMap((res) => from(this.encryption.init()).pipe(map(() => res))),
      );
  }

  logout() {
    return this.http.post(`${this.base}/auth/logout`, {}).pipe(
      finalize(() => {
        this.clearAppState();
        this.router.navigate(['/login']);
      }),
    );
  }

  /**
   * Wipe all in-memory state that belongs to the current user session.
   * Called on logout so a subsequent login never sees stale data from the
   * previous user. Lazy-resolves ChatService and ProjectService via Injector
   * to avoid a circular dependency (those services do not import AuthService).
   */
  clearAppState() {
    this.user.set(null);

    // Dynamic imports let us resolve the services only when needed while
    // keeping the module dependency graph acyclic.
    import('./chat.service').then(({ ChatService }) => {
      const svc = this.injector.get(ChatService);
      svc.reset();
      svc.chats.set([]);
    }).catch(() => { /* not yet loaded */ });

    import('./project.service').then(({ ProjectService }) => {
      const svc = this.injector.get(ProjectService);
      svc.projects.set([]);
      svc.activeProjectId.set(null);
      svc.files.set([]);
    }).catch(() => { /* not yet loaded */ });
  }

  isAuthed(): boolean {
    return !!this.user();
  }

  /** One-shot check used by the route guard. */
  ensureSession() {
    if (this.user()) return of(true);
    return this.http.get<{ user: User }>(`${this.base}/auth/me`).pipe(
      tap((res) => this.user.set(res.user)),
      tap(() => { void this.encryption.init(); }),
      map(() => true),
      catchError(() => of(false)),
    );
  }

  setUser(u: User) {
    this.user.set(u);
  }
}

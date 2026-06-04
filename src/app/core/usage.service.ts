import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { tap } from 'rxjs';
import { environment } from '../../environments/environment';
import { UsageToday, UsageWeek } from './models';

@Injectable({ providedIn: 'root' })
export class UsageService {
  private http = inject(HttpClient);
  private base = environment.apiUrl + '/v1';

  readonly today = signal<UsageToday | null>(null);
  readonly week = signal<UsageWeek | null>(null);

  loadToday() {
    return this.http
      .get<UsageToday>(`${this.base}/usage/today`)
      .pipe(tap((u) => this.today.set(u)));
  }

  loadWeek() {
    return this.http
      .get<UsageWeek>(`${this.base}/usage/week`)
      .pipe(tap((u) => this.week.set(u)));
  }

  /** Apply a fresh remaining/used count after sending a message. */
  applyAfterSend(remainingTokens: number, _usedTokensDelta?: number) {
    const t = this.today();
    if (!t) return;
    // The backend returns remaining tokens after reservation has been reconciled
    // against actual provider usage. Treat it as authoritative instead of adding
    // a local delta, which can double-count after retries, regeneration, or stale
    // usage state and then appear to "reduce" on page refresh.
    const used = Math.max(0, t.cap - remainingTokens);
    this.today.set({
      ...t,
      tokens: used,
      remaining: Math.max(0, t.cap - used),
      pct: Math.min(100, Math.round((used / t.cap) * 100)),
    });
  }
}

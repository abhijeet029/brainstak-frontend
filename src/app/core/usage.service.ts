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
  applyAfterSend(remainingTokens: number, usedTokensDelta?: number) {
    const t = this.today();
    if (!t) return;
    const usedFromRemaining = Math.max(0, t.cap - remainingTokens);
    const used = typeof usedTokensDelta === 'number'
      ? Math.max(0, t.tokens + Math.max(0, usedTokensDelta))
      : usedFromRemaining;
    this.today.set({
      ...t,
      tokens: used,
      remaining: Math.max(0, t.cap - used),
      pct: Math.min(100, Math.round((used / t.cap) * 100)),
    });
  }
}

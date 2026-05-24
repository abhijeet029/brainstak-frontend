import { DOCUMENT } from '@angular/common';
import { Injectable, inject, signal } from '@angular/core';

export type ThemeMode = 'dark' | 'light';

const STORAGE_KEY = 'hub-theme';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly document = inject(DOCUMENT);

  readonly theme = signal<ThemeMode>('dark');

  constructor() {
    const stored = this.readStoredTheme();
    this.applyTheme(stored ?? 'dark');
  }

  toggleTheme() {
    this.applyTheme(this.theme() === 'dark' ? 'light' : 'dark');
  }

  setTheme(theme: ThemeMode) {
    this.applyTheme(theme);
  }

  private applyTheme(theme: ThemeMode) {
    this.theme.set(theme);
    const root = this.document.documentElement;
    root.setAttribute('data-theme', theme);
    root.setAttribute('data-bs-theme', theme);
    window.localStorage.setItem(STORAGE_KEY, theme);
  }

  private readStoredTheme(): ThemeMode | null {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : null;
  }
}

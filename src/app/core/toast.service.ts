import { Injectable, signal } from '@angular/core';

export interface AppToast {
  id: number;
  message: string;
  tone: 'error' | 'success' | 'info';
}

@Injectable({ providedIn: 'root' })
export class ToastService {
  readonly toasts = signal<AppToast[]>([]);
  private nextId = 1;

  show(message: string, tone: AppToast['tone'] = 'info', durationMs = 3600) {
    const id = this.nextId++;
    this.toasts.update((current) => [...current, { id, message, tone }]);
    window.setTimeout(() => this.dismiss(id), durationMs);
  }

  dismiss(id: number) {
    this.toasts.update((current) => current.filter((toast) => toast.id !== id));
  }
}

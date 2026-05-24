import { CommonModule } from '@angular/common';
import { Component, inject } from '@angular/core';
import { ToastService } from '../../core/toast.service';

@Component({
  selector: 'app-toast-stack',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="toast-stack">
      @for (toast of toastSvc.toasts(); track toast.id) {
        <div class="toast-item" [class.error]="toast.tone === 'error'" [class.success]="toast.tone === 'success'">
          <div class="toast-copy">{{ toast.message }}</div>
          <button type="button" class="toast-close" (click)="toastSvc.dismiss(toast.id)" aria-label="Dismiss">
            <i class="bi bi-x-lg"></i>
          </button>
        </div>
      }
    </div>
  `,
  styleUrl: './toast-stack.component.scss',
})
export class ToastStackComponent {
  readonly toastSvc = inject(ToastService);
}

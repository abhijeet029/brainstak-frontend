import { CommonModule } from '@angular/common';
import { Component, inject, computed, signal } from '@angular/core';
import { AuthService } from '../../core/auth.service';
import { PaymentService } from '../../core/payment.service';
import { ToastService } from '../../core/toast.service';

declare const bootstrap: any;

@Component({
  selector: 'app-upgrade-modal',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './upgrade-modal.component.html',
  styleUrl: './upgrade-modal.component.scss',
})
export class UpgradeModalComponent {
  private auth = inject(AuthService);
  private payments = inject(PaymentService);
  private toast = inject(ToastService);

  readonly user    = this.auth.user;
  readonly isPro   = computed(() => (this.user()?.tier ?? 'free') !== 'free');
  readonly paying = signal(false);

  close() {
    const el = document.getElementById('upgradeModal');
    if (el) bootstrap.Modal.getInstance(el)?.hide();
  }

  onUpgrade() {
    if (this.paying()) return;
    this.paying.set(true);
    this.payments.createOrder('pro').subscribe({
      next: (res) => {
        this.paying.set(false);
        window.location.href = res.paymentUrl;
      },
      error: (e) => {
        this.paying.set(false);
        this.toast.show(e?.error?.message ?? e?.error?.error ?? 'Could not start payment', 'error');
      },
    });
  }
}

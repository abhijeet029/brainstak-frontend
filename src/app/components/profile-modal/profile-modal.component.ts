import { CommonModule } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { AuthService } from '../../core/auth.service';
import { UserService } from '../../core/user.service';

declare const bootstrap: any;

@Component({
  selector: 'app-profile-modal',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule],
  templateUrl: './profile-modal.component.html',
  styleUrl: './profile-modal.component.scss',
})
export class ProfileModalComponent {
  private auth = inject(AuthService);
  private userSvc = inject(UserService);
  private fb = inject(FormBuilder);

  readonly user = this.auth.user;
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);

  form = this.fb.group({
    name: ['', [Validators.required, Validators.maxLength(60)]],
    phoneLocal: [''],
  });

  constructor() {
    // Initialize form with user data on component load and modal open
    queueMicrotask(() => this.hydrate());
    document.addEventListener('show.bs.modal', (e: Event) => {
      const target = (e.target as HTMLElement).id;
      if (target === 'profileModal') this.hydrate();
    });
  }

  /**
   * Populates the form fields with the current user's profile data.
   * Called on component initialization and when the modal is opened.
   */
  private hydrate() {
    const u = this.user();
    if (!u) return;
    this.form.patchValue({
      name: u.name ?? '',
      phoneLocal: stripCountryPrefix(u.phone),
    });
    this.error.set(null);
  }

  /**
   * Handles the profile save action. Validates the form,
   * updates the user profile via `UserService`, and closes the modal on success.
   */
  save() {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.saving.set(true);
    this.error.set(null);
    const { name, phoneLocal } = this.form.getRawValue();
    const phoneDigits = (phoneLocal ?? '').replace(/\s+/g, '');
    const phone = phoneDigits ? '+91' + phoneDigits : '';

    this.userSvc.updateProfile({ name: name ?? undefined, phone }).subscribe({
      next: () => {
        this.saving.set(false);
        const modalEl = document.getElementById('profileModal');
        if (modalEl) bootstrap.Modal.getInstance(modalEl)?.hide();
      },
      error: (e) => {
        this.saving.set(false);
        this.error.set(e?.error?.error ?? 'Could not save changes');
      },
    });
  }

}

/**
 * Removes the country code prefix (+91) from a phone number string.
 * @param phone The phone number to process.
 * @returns The phone number without the +91 prefix, or an empty string if null.
 */
function stripCountryPrefix(phone: string | null): string {
  if (!phone) return '';
  return phone.replace(/^\+91/, '');
}

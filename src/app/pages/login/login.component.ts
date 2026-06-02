import { Component, ElementRef, OnInit, ViewChild, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { environment } from '../../../environments/environment';
import { AuthService } from '../../core/auth.service';
import { ThemeService } from '../../core/theme.service';

declare const google: any;

@Component({
  selector: 'app-login',
  standalone: true,
  templateUrl: './login.component.html',
  styleUrl: './login.component.scss',
})
export class LoginComponent implements OnInit {
  private auth = inject(AuthService);
  private router = inject(Router);
  readonly themeSvc = inject(ThemeService);

  @ViewChild('gbtn', { static: true }) gbtn!: ElementRef<HTMLDivElement>;

  readonly error = signal<string | null>(null);
  readonly googleLoading = signal(true);
  readonly googleButtonRendered = signal(false);

  private googleInitialized = false;
  private initAttempts = 0;
  private renderCheckTimer: ReturnType<typeof setTimeout> | null = null;

  ngOnInit() {
    this.initGoogleSignIn();
  }

  onFallbackGoogleClick() {
    this.error.set(null);

    if (typeof google === 'undefined') {
      this.googleLoading.set(false);
      this.error.set('Google sign-in is still loading. Please refresh and try again.');
      return;
    }

    this.initializeGoogle();
    this.renderGoogleButton();
    this.promptGoogle();
  }

  private onCredential(idToken: string) {
    this.error.set(null);
    this.auth.loginWithGoogle(idToken).subscribe({
      next: () => this.router.navigateByUrl('/chat'),
      error: (e) => this.error.set(e?.error?.error ?? 'Sign-in failed'),
    });
  }

  private initGoogleSignIn(): void {
    if (typeof google === 'undefined') {
      this.initAttempts += 1;

      if (this.initAttempts >= 80) {
        this.googleLoading.set(false);
        this.error.set('Google sign-in could not load. Check your connection and refresh.');
        return;
      }

      setTimeout(() => this.initGoogleSignIn(), 100);
      return;
    }

    this.initializeGoogle();
    this.renderGoogleButton();
    this.promptGoogle();
  }

  private initializeGoogle(): void {
    if (this.googleInitialized) {
      return;
    }

    google.accounts.id.initialize({
      client_id: environment.googleClientId,
      callback: (resp: { credential: string }) => this.onCredential(resp.credential),
      auto_select: true,
      cancel_on_tap_outside: false,
      use_fedcm_for_prompt: true,
    });

    this.googleInitialized = true;
  }

  private renderGoogleButton(): void {
    this.googleLoading.set(true);
    this.googleButtonRendered.set(false);

    const host = this.gbtn.nativeElement;
    host.replaceChildren();

    const buttonWidth = Math.min(window.innerWidth - 64, 460);
    try {
      google.accounts.id.renderButton(host, {
        theme: 'outline',
        type: 'standard',
        size: 'large',
        shape: 'pill',
        logo_alignment: 'left',
        text: 'continue_with',
        width: Math.max(320, buttonWidth),
      });

      this.scheduleRenderedCheck();
    } catch {
      this.googleLoading.set(false);
      this.googleButtonRendered.set(false);
      this.error.set('Google sign-in is not ready yet. Please try again.');
    }
  }

  private scheduleRenderedCheck(): void {
    if (this.renderCheckTimer) {
      clearTimeout(this.renderCheckTimer);
    }

    this.renderCheckTimer = setTimeout(() => {
      const hasGoogleButton = this.gbtn.nativeElement.childElementCount > 0;
      this.googleButtonRendered.set(hasGoogleButton);
      this.googleLoading.set(false);
    }, 350);
  }

  private promptGoogle(): void {
    try {
      google.accounts.id.prompt();
    } catch {
      this.googleButtonRendered.set(false);
    }
  }
}

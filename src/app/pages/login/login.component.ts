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

  ngOnInit() {
    const init = (): void => {
      if (typeof google === 'undefined') {
        setTimeout(init, 100);
        return;
      }

      google.accounts.id.initialize({
        client_id: environment.googleClientId,
        callback: (resp: { credential: string }) => this.onCredential(resp.credential),
        auto_select: true,
        cancel_on_tap_outside: false,
        use_fedcm_for_prompt: true,
      });

      const isDark = this.themeSvc.theme() === 'dark';
      const buttonWidth = Math.min(window.innerWidth - 64, window.innerWidth >= 960 ? 380 : 320);
      google.accounts.id.renderButton(this.gbtn.nativeElement, {
        theme: isDark ? 'filled_black' : 'outline',
        size: 'large',
        shape: 'pill',
        text: 'continue_with',
        width: Math.max(280, buttonWidth),
      });
      google.accounts.id.prompt();
    };

    init();
  }

  private onCredential(idToken: string) {
    this.error.set(null);
    this.auth.loginWithGoogle(idToken).subscribe({
      next: () => this.router.navigateByUrl('/chat'),
      error: (e) => this.error.set(e?.error?.error ?? 'Sign-in failed'),
    });
  }
}

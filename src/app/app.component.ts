import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ToastStackComponent } from './components/toast-stack/toast-stack.component';
import { ThemeService } from './core/theme.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, ToastStackComponent],
  templateUrl: './app.component.html',
})
export class AppComponent {
  private readonly _theme = inject(ThemeService);
}

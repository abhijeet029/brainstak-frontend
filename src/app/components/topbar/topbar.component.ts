import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Output, computed, inject } from '@angular/core';
import { AuthService } from '../../core/auth.service';
import { ChatService } from '../../core/chat.service';
import { ProjectService } from '../../core/project.service';
import { ThemeService } from '../../core/theme.service';
import { UsageService } from '../../core/usage.service';

@Component({
  selector: 'app-topbar',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './topbar.component.html',
  styleUrl: './topbar.component.scss',
})
export class TopbarComponent {
  @Output() projectChanged = new EventEmitter<string | null>();
  @Output() menuClick = new EventEmitter<void>();
  @Output() temporaryModeChange = new EventEmitter<boolean>();

  private auth = inject(AuthService);
  private projectSvc = inject(ProjectService);
  private chatSvc = inject(ChatService);
  private usage = inject(UsageService);
  readonly theme = inject(ThemeService);

  readonly user = this.auth.user;
  readonly today = this.usage.today;
  readonly projects = this.projectSvc.projects;
  readonly activeProjectId = this.projectSvc.activeProjectId;
  readonly activeChatId = this.chatSvc.activeChatId;
  readonly temporaryMode = this.chatSvc.temporaryMode;
  readonly activeProjectName = computed(
    () => this.projectSvc.projects().find((project) => project.id === this.activeProjectId())?.name ?? null,
  );
  readonly showProjectSwitcher = computed(() => !!this.activeProjectId() && !!this.activeChatId());
  readonly switcherLabel = computed(() => this.activeProjectName() ?? 'Projects');
  readonly initial = computed(() => {
    const u = this.user();
    return (u?.name?.[0] ?? u?.email?.[0] ?? 'U').toUpperCase();
  });
  readonly pillClass = computed(() => {
    const pct = this.today()?.pct ?? 0;
    if (pct >= 90) return 'danger';
    if (pct >= 70) return 'warn';
    return 'ok';
  });
  readonly planLabel = computed(() => {
    const tier = this.user()?.tier ?? 'free';
    if (tier === 'team') return 'Team';
    if (tier === 'pro') return 'Pro';
    return 'Free';
  });

  selectProject(id: string | null) {
    this.projectChanged.emit(id);
  }

  toggleTemporaryMode() {
    this.temporaryModeChange.emit(!this.temporaryMode());
  }

  onLogout() {
    this.auth.logout().subscribe();
  }
}

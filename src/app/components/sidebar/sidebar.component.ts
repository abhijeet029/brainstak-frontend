import { CommonModule } from '@angular/common';
import { Component, ElementRef, EventEmitter, HostListener, Input, Output, ViewChild, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { ChatService } from '../../core/chat.service';
import { ProjectService } from '../../core/project.service';
import { ThemeService } from '../../core/theme.service';
import { UsageService } from '../../core/usage.service';
import { ToastService } from '../../core/toast.service';
import { Chat } from '../../core/models';

@Component({
  selector: 'app-sidebar',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './sidebar.component.html',
  styleUrl: './sidebar.component.scss',
})
export class SidebarComponent {
  @Output() newChat = new EventEmitter<void>();
  @Output() newChatInProject = new EventEmitter<string>();
  @Output() projectSelected = new EventEmitter<string | null>();
  @Output() selected = new EventEmitter<string>();
  @Output() closeRequested = new EventEmitter<void>();
  @Output() toggleCollapsed = new EventEmitter<void>();
  @Input() open = false;
  @Input() collapsed = false;
  private chatSvc = inject(ChatService);
  private auth = inject(AuthService);
  private projectSvc = inject(ProjectService);
  private usageSvc = inject(UsageService);
  private toast = inject(ToastService);
  private router = inject(Router);
  readonly themeSvc = inject(ThemeService);

  readonly chats = this.chatSvc.chats;
  readonly activeId = this.chatSvc.activeChatId;
  readonly logoSrc = () => this.themeSvc.theme() === 'dark' ? '/assets/logo-dark.svg' : '/assets/logo-light.svg';
  readonly projects = this.projectSvc.projects;
  readonly activeProjectId = this.projectSvc.activeProjectId;
  readonly today = this.usageSvc.today;
  readonly planName = computed(() => this.today()?.plan?.name ?? 'Free');
  readonly initial = computed(() => {
    const u = this.auth.user();
    return (u?.name?.[0] ?? u?.email?.[0] ?? 'U').toUpperCase();
  });
  readonly openSections = signal<Record<string, boolean>>({ projects: true, recents: true });
  /** Which project ids are currently expanded to show their chats. */
  readonly expandedProjects = signal<Set<string>>(new Set());
  readonly deleteDialog = signal<{ chatId: string; title: string } | null>(null);
  readonly deleteProjectDialog = signal<{ projectId: string; title: string } | null>(null);
  readonly archiveChatsDialog = signal<{ projectId: string; title: string } | null>(null);
  readonly renameProjectDialog = signal<{ projectId: string; title: string } | null>(null);
  readonly renameProjectError = signal<string | null>(null);
  readonly isRenamingProject = signal(false);
  renameProjectDraft = '';
  readonly projectMenu = signal<{ projectId: string; title: string; top: number; left: number } | null>(null);
  readonly search = signal('');
  readonly searchOpen = signal(false);
  readonly searchResults = signal<Chat[]>([]);
  readonly searchLoading = signal(false);
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  @ViewChild('searchInput') searchInput?: ElementRef<HTMLInputElement>;
  @ViewChild('renameProjectInput') renameProjectInput?: ElementRef<HTMLInputElement>;

  @HostListener('document:click')
  closeProjectMenu() {
    this.projectMenu.set(null);
  }

  /** All chats grouped by projectId (undefined/null → personal). Sorted by lastActive desc. */
  readonly chatsByProject = computed(() => {
    const map = new Map<string, Chat[]>();
    for (const chat of this.chats()) {
      if (!chat.projectId) continue;
      const arr = map.get(chat.projectId) ?? [];
      arr.push(chat);
      map.set(chat.projectId, arr);
    }
    map.forEach((arr) =>
      arr.sort((a, b) => new Date(b.lastActive).getTime() - new Date(a.lastActive).getTime()),
    );
    return map;
  });

  /** Flat list of all chats (across all projects + personal) sorted by lastActive. */
  readonly recentChats = computed(() => {
    const sorted = [...this.chats()].sort((a, b) => new Date(b.lastActive).getTime() - new Date(a.lastActive).getTime());
    return sorted;
  });

  readonly searchDisplayResults = computed(() => {
    const query = this.search().trim();
    if (!query) return this.recentChats();
    return this.searchResults();
  });

  readonly todaySearchResults = computed(() => this.searchDisplayResults().filter((chat) => this.isToday(chat.lastActive)));
  readonly previousSearchResults = computed(() => this.searchDisplayResults().filter((chat) => !this.isToday(chat.lastActive)));

  onNewChat() {
    this.newChat.emit();
    this.closeSearch();
    if (window.innerWidth < 768) this.closeRequested.emit();
  }

  onRailMenuClick(event: Event) {
    event.preventDefault();
    event.stopPropagation();
    this.toggleCollapsed.emit();
  }

  onRailNewChat(event: Event) {
    event.preventDefault();
    event.stopPropagation();
    this.newChat.emit();
    this.closeSearch();
  }

  onRailSearch(event: Event) {
    event.preventDefault();
    event.stopPropagation();
    this.openSearch();
  }

  onSelect(id: string) {
    this.selected.emit(id);
    this.closeSearch();
    if (window.innerWidth < 768) this.closeRequested.emit();
  }

  openSearch() {
    this.searchOpen.set(true);
    this.searchResults.set(this.recentChats());
    setTimeout(() => this.searchInput?.nativeElement.focus());
  }

  closeSearch() {
    this.searchOpen.set(false);
    this.search.set('');
    this.searchResults.set([]);
    this.searchLoading.set(false);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = null;
  }

  onSearchInput(value: string) {
    this.search.set(value);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    const q = value.trim();
    if (!q) {
      this.searchResults.set(this.recentChats());
      this.searchLoading.set(false);
      return;
    }
    const localMatches = this.recentChats().filter((chat) =>
      [
        chat.title ?? 'New chat',
        this.getProjectName(chat) ?? '',
      ].some((value) => value.toLowerCase().includes(q.toLowerCase())),
    );
    this.searchResults.set(localMatches);
    this.searchLoading.set(true);
    this.searchTimer = setTimeout(() => {
      this.chatSvc.searchChats(q).subscribe({
        next: (res) => {
          if (this.search().trim() === q) {
            this.searchResults.set(res.chats);
            this.searchLoading.set(false);
          }
        },
        error: () => {
          this.searchResults.set([]);
          this.searchLoading.set(false);
        },
      });
    }, 180);
  }

  searchSnippet(chat: Chat): string {
    const project = this.getProjectName(chat);
    const snippet = chat.snippet?.trim();
    if (snippet) return project ? `${project} - ${snippet}` : snippet;
    return project ? `Project: ${project}` : 'Chat';
  }

  tokenLabel(chat: Chat): string {
    const total = chat.totalTokens ?? 0;
    if (total <= 0) return '0 tokens';
    if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(total >= 10_000_000 ? 0 : 1)}M tokens`;
    if (total >= 1_000) return `${(total / 1_000).toFixed(total >= 10_000 ? 0 : 1)}k tokens`;
    return `${total.toLocaleString()} tokens`;
  }

  private isToday(iso: string): boolean {
    const date = new Date(iso);
    const today = new Date();
    return date.getFullYear() === today.getFullYear()
      && date.getMonth() === today.getMonth()
      && date.getDate() === today.getDate();
  }

  onProjectNewChat(event: Event, projectId: string) {
    event.stopPropagation();
    this.newChatInProject.emit(projectId);
    if (window.innerWidth < 768) this.closeRequested.emit();
  }

  onProjectSelect(projectId: string) {
    this.projectSelected.emit(projectId);
    if (!this.isProjectExpanded(projectId)) this.toggleProjectExpand(projectId);
    if (window.innerWidth < 768) this.closeRequested.emit();
  }

  onProjectToggle(event: Event, projectId: string) {
    event.stopPropagation();
    this.toggleProjectExpand(projectId);
  }

  onProjectContextMenu(event: MouseEvent, projectId: string, title: string) {
    event.preventDefault();
    event.stopPropagation();
    this.projectMenu.set(this.getProjectMenuPosition(projectId, title, event.clientX, event.clientY));
  }

  openProjectMenu(event: Event, projectId: string, title: string) {
    event.preventDefault();
    event.stopPropagation();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.projectMenu.set(this.getProjectMenuPosition(projectId, title, rect.right, rect.bottom + 6));
  }

  private getProjectMenuPosition(projectId: string, title: string, x: number, y: number) {
    const width = 218;
    const margin = 10;
    const left = Math.min(Math.max(margin, x - width), window.innerWidth - width - margin);
    const top = Math.min(Math.max(margin, y), window.innerHeight - 270);
    return { projectId, title, top, left };
  }

  onProjectMenuOpen(projectId: string) {
    this.projectMenu.set(null);
    this.projectSelected.emit(projectId);
  }

  onProjectMenuRename(projectId: string, title: string) {
    this.projectMenu.set(null);
    this.renameProjectDraft = title;
    this.renameProjectError.set(null);
    this.isRenamingProject.set(false);
    this.renameProjectDialog.set({ projectId, title });
    setTimeout(() => {
      this.renameProjectInput?.nativeElement.focus();
      this.renameProjectInput?.nativeElement.select();
    });
  }

  cancelRenameProject() {
    if (this.isRenamingProject()) return;
    this.renameProjectDialog.set(null);
    this.renameProjectError.set(null);
  }

  confirmRenameProject() {
    const pending = this.renameProjectDialog();
    const name = this.renameProjectDraft.trim();
    if (!pending || !name || name === pending.title || this.isRenamingProject()) return;

    this.isRenamingProject.set(true);
    this.renameProjectError.set(null);
    this.projectSvc.renameProject(pending.projectId, name).subscribe({
      next: () => {
        this.renameProjectDialog.set(null);
        this.isRenamingProject.set(false);
        this.toast.show('Project renamed.', 'success');
      },
      error: (e) => {
        this.renameProjectError.set(projectErrorMessage(e, 'Could not rename project'));
        this.isRenamingProject.set(false);
      },
    });
  }

  onProjectMenuConnect(projectId: string) {
    this.projectMenu.set(null);
    this.projectSvc.reconnectProjectFolder(projectId).then((connected) => {
      this.toast.show(connected ? 'Folder connected.' : 'Folder connection was not granted.', connected ? 'success' : 'error');
    });
  }

  onArchiveProjectChats(projectId: string, title: string) {
    this.projectMenu.set(null);
    this.archiveChatsDialog.set({ projectId, title });
  }

  cancelArchiveChats() {
    this.archiveChatsDialog.set(null);
  }

  confirmArchiveChats() {
    const pending = this.archiveChatsDialog();
    if (!pending) return;
    this.projectSvc.archiveProjectChats(pending.projectId).subscribe({
      next: () => {
        if (this.activeProjectId() === pending.projectId) {
          this.chatSvc.reset();
          this.projectSelected.emit(pending.projectId);
        }
        this.chatSvc.loadChats().subscribe();
        this.archiveChatsDialog.set(null);
        this.toast.show('Project chats archived.', 'success');
      },
      error: (e) => {
        this.archiveChatsDialog.set(null);
        this.toast.show((e as { error?: { message?: string; error?: string } })?.error?.message ?? 'Could not archive project chats', 'error');
      },
    });
  }

  isProjectExpanded(id: string): boolean {
    return this.expandedProjects().has(id);
  }

  toggleProjectExpand(id: string) {
    this.expandedProjects.update((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** Returns the name of the project a chat belongs to, or null. */
  getProjectName(chat: Chat): string | null {
    if (!chat.projectId) return null;
    return this.projects().find((p) => p.id === chat.projectId)?.name ?? null;
  }

  isSectionOpen(key: string) {
    return this.openSections()[key] ?? false;
  }

  toggleSection(key: string) {
    this.openSections.update((current) => ({ ...current, [key]: !(current[key] ?? false) }));
  }

  onDeleteChat(event: Event, chatId: string, title: string) {
    event.stopPropagation();
    this.deleteDialog.set({ chatId, title });
  }

  cancelDelete() {
    this.deleteDialog.set(null);
  }

  confirmDelete() {
    const pending = this.deleteDialog();
    if (!pending) return;
    this.chatSvc.delete(pending.chatId).subscribe({
      next: () => this.deleteDialog.set(null),
      error: () => this.deleteDialog.set(null),
    });
  }

  onDeleteProject(event: Event, projectId: string, title: string) {
    event.stopPropagation();
    this.projectMenu.set(null);
    this.deleteProjectDialog.set({ projectId, title });
  }

  cancelProjectDelete() {
    this.deleteProjectDialog.set(null);
  }

  confirmProjectDelete() {
    const pending = this.deleteProjectDialog();
    if (!pending) return;
    this.projectSvc.deleteProject(pending.projectId).subscribe({
      next: () => {
        // Always reset chat state and go home after a project is deleted —
        // the active project check was unreliable when the user had navigated
        // directly into a project chat without selecting the project in the sidebar.
        this.chatSvc.reset();
        this.projectSelected.emit(null);
        this.chatSvc.loadChats().subscribe({
          next: () => {
            this.deleteProjectDialog.set(null);
            void this.router.navigate(['/chat']);
          },
          error: () => {
            this.deleteProjectDialog.set(null);
            void this.router.navigate(['/chat']);
          },
        });
      },
      error: () => this.deleteProjectDialog.set(null),
    });
  }
}

function projectErrorMessage(error: unknown, fallback: string): string {
  const code = (error as { error?: { error?: string } })?.error?.error;
  if (code === 'PROJECT_NAME_EXISTS') {
    return 'Another project already exists with the same name!';
  }
  return String(
    (error as { error?: { message?: string; error?: string } })?.error?.message ??
    code ??
    (error as { message?: string })?.message ??
    fallback,
  );
}

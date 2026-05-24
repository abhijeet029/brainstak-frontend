import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  AfterViewChecked,
  Component,
  ElementRef,
  OnInit,
  ViewChild,
  computed,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { catchError, forkJoin, of, Subscription } from 'rxjs';

import { AuthService } from '../../core/auth.service';
import { ChatService } from '../../core/chat.service';
import { ProjectService } from '../../core/project.service';
import { ToastService } from '../../core/toast.service';
import { UsageService } from '../../core/usage.service';
import { IntelligenceLevel, IntelligenceOption, ProposedChange } from '../../core/models';

import { SidebarComponent } from '../../components/sidebar/sidebar.component';
import { TopbarComponent } from '../../components/topbar/topbar.component';
import { ComposerComponent } from '../../components/composer/composer.component';
import { MessageComponent } from '../../components/message/message.component';
import { ModelPriorityModalComponent } from '../../components/model-priority-modal/model-priority-modal.component';
import { NewProjectModalComponent } from '../../components/new-project-modal/new-project-modal.component';
import { ProfileModalComponent } from '../../components/profile-modal/profile-modal.component';
import { ProjectModalComponent } from '../../components/project-modal/project-modal.component';
import { UsageModalComponent } from '../../components/usage-modal/usage-modal.component';
import { UpgradeModalComponent } from '../../components/upgrade-modal/upgrade-modal.component';

@Component({
  selector: 'app-chat',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    SidebarComponent,
    TopbarComponent,
    ComposerComponent,
    MessageComponent,
    ModelPriorityModalComponent,
    NewProjectModalComponent,
    ProfileModalComponent,
    ProjectModalComponent,
    UsageModalComponent,
    UpgradeModalComponent,
  ],
  templateUrl: './chat.component.html',
  styleUrl: './chat.component.scss',
})
export class ChatComponent implements OnInit, AfterViewChecked {
  protected chatSvc = inject(ChatService);
  private auth = inject(AuthService);
  private projects = inject(ProjectService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private toast = inject(ToastService);
  private usage = inject(UsageService);

  @ViewChild('scrollArea', { static: false }) scrollArea?: ElementRef<HTMLDivElement>;
  @ViewChild('composer', { static: false }) composer?: ComposerComponent;
  @ViewChild('sidebar', { static: false }) sidebar?: SidebarComponent;

  readonly sidebarOpen = signal(false);
  readonly sidebarVisible = signal(true);
  readonly messages = this.chatSvc.messages;

  readonly userName = computed(() => this.auth.user()?.name ?? 'there');
  readonly activeProjectName = computed(() => {
    const id = this.projects.activeProjectId();
    return id ? (this.projects.projects().find((p) => p.id === id)?.name ?? null) : null;
  });
  readonly activeProject = computed(() => {
    const id = this.projects.activeProjectId();
    return id ? (this.projects.projects().find((p) => p.id === id) ?? null) : null;
  });
  readonly projectHomeVisible = computed(() => !!this.activeProject() && !this.chatSvc.activeChatId());
  readonly projectHomeProject = computed(() => this.projectHomeVisible() ? this.activeProject() : null);
  readonly newChatVisible = computed(() =>
    !this.projectHomeVisible() && this.messages().length === 0 && !this.chatSvc.sending()
  );
  readonly projectChats = computed(() => {
    const id = this.projects.activeProjectId();
    if (!id) return [];
    return [...this.chatSvc.chats()]
      .filter((chat) => chat.projectId === id)
      .sort((a, b) => new Date(b.lastActive).getTime() - new Date(a.lastActive).getTime());
  });
  readonly projectFiles = this.projects.files;
  /** Non-null when an inline folder-permission card should be shown in the chat. */
  readonly pendingPermission = this.projects.pendingPermissionRequest.asReadonly();
  readonly userInitial = computed(() => {
    const u = this.auth.user();
    return (u?.name?.[0] ?? u?.email?.[0] ?? 'U').toUpperCase();
  });
  readonly resumingChatId = signal<string | null>(null);
  readonly waitingForReply = computed(() => {
    const last = this.messages()[this.messages().length - 1];
    return last?.role === 'user' && (
      this.chatSvc.sending() || this.resumingChatId() === this.chatSvc.activeChatId()
    );
  });
  readonly selectedIntelligence = signal<IntelligenceLevel>('low');
  readonly activeModelCheck = signal<{ assistantMessageId: string; model: string; modelLabel: string } | null>(null);
  /** Model the user pinned after a check — applied to all subsequent sends in this chat. */
  readonly preferredModel = signal<{ model: string; modelLabel: string } | null>(null);
  /** Maps assistant message ID → the model that produced that check response. */
  readonly checkResponseMap = signal<Map<string, { model: string; modelLabel: string }>>(new Map());
  readonly projectDraftText = signal('');
  readonly projectTab = signal<'chats' | 'sources'>('chats');
  readonly intelligenceOptions = computed<IntelligenceOption[]>(() => {
    const tier = this.auth.user()?.tier ?? 'free';
    const today = this.usage.today();
    const remaining = today?.remaining ?? Infinity;
    const cap = today?.cap ?? 0;
    const pctRemaining = cap > 0 ? remaining / cap : 1;

    const mediumAllowedByTier = tier === 'pro' || tier === 'team';
    const highAllowedByTier = tier === 'team';
    const mediumEnabled = mediumAllowedByTier && pctRemaining > 0.08 && remaining > 3_000;
    const highEnabled = highAllowedByTier && pctRemaining > 0.2 && remaining > 12_000;

    const options: IntelligenceOption[] = [
      {
        value: 'low',
        label: 'Low',
        enabled: true,
        models: 'Gemini Flash, Mistral Small, DeepSeek Chat',
      },
      {
        value: 'medium',
        label: 'Medium',
        enabled: mediumEnabled,
        reason: mediumAllowedByTier ? 'Needs more remaining quota' : 'Available on Pro and Team',
        models: 'Gemini Flash, Claude Haiku, DeepSeek R1, GPT-4.1 Mini',
      },
      {
        value: 'high',
        label: 'High',
        enabled: highEnabled,
        reason: highAllowedByTier ? 'Needs more remaining quota' : 'Available on Team',
        models: 'Claude Sonnet, Claude Haiku, Gemini Flash, GPT-4.1 Mini',
      },
    ];

    const selected = this.selectedIntelligence();
    if (!options.find((option) => option.value === selected && option.enabled)) {
      this.selectedIntelligence.set('low');
    }
    return options;
  });
  private shouldScrollToBottom = false;
  private resumePollTimer: ReturnType<typeof setTimeout> | null = null;
  private resumePollSub: Subscription | null = null;
  private resumePollAttempts = 0;

  ngOnInit() {
    forkJoin({
      projects: this.projects.loadProjects().pipe(catchError(() => of({ projects: [] }))),
      today: this.usage.loadToday().pipe(catchError(() => of(null))),
      chats: this.chatSvc.loadChats().pipe(catchError(() => of({ chats: [] }))),
    }).subscribe(({ chats }) => {
      // Only restore a specific chat when navigating to a direct URL (/chat/:id).
      // On a plain /chat load we stay in the "New chat" empty state.
      const routeChatId = this.route.snapshot.paramMap.get('chatId');
      if (routeChatId) {
        if (chats.chats.some((chat) => chat.id === routeChatId)) {
          this.openChat(routeChatId);
        } else {
          void this.router.navigate(['/chat']);
        }
      } else {
        const temp = this.route.snapshot.queryParamMap.get('temp') === 'true';
        if (temp) {
          this.projects.selectProject(null);
          this.chatSvc.setTemporaryMode(true);
          this.shouldScrollToBottom = true;
          return;
        }
        const projectId = this.route.snapshot.queryParamMap.get('project');
        if (projectId && this.projects.projects().some((project) => project.id === projectId)) {
          this.showProjectHome(projectId);
        }
      }
    });
    this.usage.loadWeek().pipe(catchError(() => of(null))).subscribe();

    this.route.paramMap.subscribe((params) => {
      const chatId = params.get('chatId');
      if (!chatId || chatId === this.chatSvc.activeChatId()) return;
      if (!this.chatSvc.chats().some((chat) => chat.id === chatId)) return;
      this.openChat(chatId);
    });
  }

  ngAfterViewChecked() {
    if (this.shouldScrollToBottom && this.scrollArea) {
      const el = this.scrollArea.nativeElement;
      el.scrollTop = el.scrollHeight;
      this.shouldScrollToBottom = false;
    }
  }

  onToggleSidebar() {
    if (!this.sidebarVisible()) {
      this.sidebarVisible.set(true);
      this.sidebarOpen.set(false);
      return;
    }
    this.sidebarVisible.update((visible) => !visible);
    this.sidebarOpen.set(false);
  }

  onOpenSidebar() {
    this.sidebarVisible.set(true);
    this.sidebarOpen.set(true);
  }

  onNewChat() {
    this.clearResumePolling();
    if (this.chatSvc.temporaryMode()) this.chatSvc.setTemporaryMode(false);
    this.chatSvc.clearActiveThread();
    this.projects.selectProject(null);
    this.preferredModel.set(null);
    this.checkResponseMap.set(new Map());
    void this.router.navigate(['/chat'], { queryParams: {} });
    this.shouldScrollToBottom = true;
  }

  onTemporaryModeChange(enabled: boolean) {
    this.clearResumePolling();
    this.projects.selectProject(null);
    this.chatSvc.setTemporaryMode(enabled);
    void this.router.navigate(['/chat'], { queryParams: enabled ? { temp: 'true' } : {} });
    this.shouldScrollToBottom = true;
  }

  onSelectChat(id: string) {
    if (this.chatSvc.temporaryMode()) this.chatSvc.setTemporaryMode(false);
    void this.router.navigate(['/chat', id]);
  }

  onProjectSelected(projectId: string | null) {
    if (!projectId) {
      this.onNewChat();
      return;
    }
    this.showProjectHome(projectId);
  }

  onProjectNewChat(projectId: string) {
    if (this.chatSvc.temporaryMode()) this.chatSvc.setTemporaryMode(false);
    this.projects.selectProject(projectId);
    this.chatSvc.reset();
    this.chatSvc.createChat(projectId).subscribe(({ chat }) => {
      // Expand the project section in the sidebar so the user sees the new chat
      if (this.sidebar && !this.sidebar.isProjectExpanded(projectId)) {
        this.sidebar.toggleProjectExpand(projectId);
      }
      void this.router.navigate(['/chat', chat.id]);
      this.shouldScrollToBottom = true;
    });
  }

  onProjectCreated(projectId: string) {
    // Refresh project list, switch into the new project, and land on the
    // project home so the user can choose a new or previous chat.
    this.projects.loadProjects().subscribe(() => {
      this.chatSvc.loadChats().subscribe(() => {
        this.showProjectHome(projectId);
      });
    });
  }

  onProjectDraftChanged(text: string) {
    this.projectDraftText.set(text);
  }

  onProjectDraftKeydown(event: KeyboardEvent) {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    this.onProjectDraftSubmit();
  }

  onProjectDraftSubmit(event?: Event) {
    event?.preventDefault();
    const text = this.projectDraftText().trim();
    const projectId = this.projects.activeProjectId();
    if (!text || !projectId || this.chatSvc.sending()) return;
    if (this.chatSvc.temporaryMode()) this.chatSvc.setTemporaryMode(false);
    this.projectDraftText.set('');
    this.startProjectDraftChat(projectId, text);
  }

  onSuggestion(text: string) {
    this.composer?.setText(text);
  }

  onIntelligenceChanged(level: IntelligenceLevel) {
    const allowed = this.intelligenceOptions().find((option) => option.value === level)?.enabled;
    if (!allowed) {
      this.selectedIntelligence.set('low');
      return;
    }
    this.selectedIntelligence.set(level);
  }

  onSend(text: string) {
    const pinnedModel = this.preferredModel()?.model;
    if (this.chatSvc.temporaryMode()) {
      this.sendTemporary(text, pinnedModel);
      return;
    }
    let chatId = this.chatSvc.activeChatId();
    if (!chatId) {
      this.chatSvc.beginPendingSend(text);
      this.chatSvc.createChat(this.projects.activeProjectId(), text.slice(0, 60), true).subscribe({
        next: ({ chat }) => {
          void this.router.navigate(['/chat', chat.id]);
          this.sendToChat(chat.id, text, pinnedModel);
        },
        error: (e) => {
          this.chatSvc.cancelPendingSend();
          this.toast.show(e?.error?.message ?? e?.error?.error ?? 'Could not create chat', 'error');
        },
      });
    } else {
      this.sendToChat(chatId, text, pinnedModel);
    }
  }

  private startProjectDraftChat(projectId: string, text: string) {
    this.chatSvc.beginPendingSend(text);
    this.chatSvc.createChat(projectId, text.slice(0, 60), true).subscribe({
      next: ({ chat }) => {
        if (this.sidebar && !this.sidebar.isProjectExpanded(projectId)) {
          this.sidebar.toggleProjectExpand(projectId);
        }
        void this.router.navigate(['/chat', chat.id]);
        this.sendToChat(chat.id, text);
      },
      error: (e) => {
        this.chatSvc.cancelPendingSend();
        this.projectDraftText.set(text);
        this.toast.show(e?.error?.error ?? 'Could not create project chat', 'error');
      },
    });
  }

  /** Called when the user clicks Apply on a single file change card. */
  async onApplyChange(event: { change: ProposedChange; done: (success: boolean) => void }) {
    const { change, done } = event;
    const projectId = this.projects.activeProjectId();
    const projectName = this.activeProjectName() ?? 'your project';
    if (!projectId) {
      this.toast.show('No active project — cannot apply changes.', 'error');
      done(false);
      return;
    }
    try {
      const result = await this.projects.applyProposedChanges(projectId, projectName, [change]);
      if (result === 'applied') {
        this.toast.show(`✓ Applied ${change.path} to your folder.`, 'success');
        this.shouldScrollToBottom = true;
        done(true);
      } else if (result === 'permission_needed') {
        // Permission card is injected below the messages — scroll down so the user sees it.
        this.shouldScrollToBottom = true;
        this.toast.show('Folder access needed — click "Allow folder access" below.', 'info');
        done(false);
      } else {
        done(false);
      }
    } catch (e) {
      this.toast.show(writeErrorMessage(e), 'error');
      done(false);
    }
  }

  /** Called when the user clicks Undo on a previously applied file. */
  async onUndoChange(event: { path: string; done: () => void }) {
    const projectId = this.projects.activeProjectId();
    if (!projectId) {
      this.toast.show('No active project — cannot undo.', 'error');
      event.done();
      return;
    }
    const snapshotId = this.projects.recentSnapshotByPath()[event.path];
    if (!snapshotId) {
      this.toast.show('Nothing to undo — snapshot has expired.', 'info');
      event.done();
      return;
    }
    const result = await this.projects.revertSnapshot(projectId, snapshotId);
    if (result) {
      this.toast.show(
        result.isFileDeletion
          ? `Reverted: ${result.filePath} (file removed)`
          : `Reverted ${result.filePath} to previous state.`,
        'success',
      );
    } else {
      this.toast.show('Could not revert — file may have been deleted or never existed.', 'error');
    }
    event.done();
    this.shouldScrollToBottom = true;
  }

  /** Called when the user clicks "Apply all" (backwards compat for bulk apply). */
  async onApplyChanges(changes: ProposedChange[]) {
    const projectId = this.projects.activeProjectId();
    const projectName = this.activeProjectName() ?? 'your project';
    if (!projectId) {
      this.toast.show('No active project — cannot apply changes.', 'error');
      return;
    }
    try {
      const result = await this.projects.applyProposedChanges(projectId, projectName, changes);
      if (result === 'applied') {
        this.toast.show(`✓ Applied ${changes.length} file${changes.length === 1 ? '' : 's'} to your folder.`, 'success');
        this.shouldScrollToBottom = true;
      } else if (result === 'permission_needed') {
        this.shouldScrollToBottom = true;
        this.toast.show('Folder access needed — click "Allow folder access" below.', 'info');
      }
    } catch (e) {
      this.toast.show(writeErrorMessage(e), 'error');
    }
  }

  onEditResend(event: { chatId: string; messageId: string; content: string }) {
    if (this.chatSvc.sending()) return;
    if (this.chatSvc.temporaryMode()) {
      this.chatSvc.truncateTemporaryFrom(event.messageId);
      this.sendTemporary(event.content);
      return;
    }
    this.chatSvc.truncateFromMessage(event.chatId, event.messageId).subscribe({
      next: () => this.sendToChat(event.chatId, event.content),
      error: (e) => this.toast.show(e?.error?.error ?? 'Could not edit message', 'error'),
    });
  }

  onCheckModel(event: { assistantMessageId: string; model: string; modelLabel: string; intelligence: IntelligenceLevel }) {
    if (this.chatSvc.sending()) return;
    const list = this.messages();
    const assistantIndex = list.findIndex((message) => message.id === event.assistantMessageId);
    if (assistantIndex <= 0) {
      this.toast.show('Could not find the original prompt for this answer.', 'error');
      return;
    }
    const previousUser = [...list.slice(0, assistantIndex)]
      .reverse()
      .find((message) => message.role === 'user' && !isModelCheckMessage(message.content));
    const chatId = this.chatSvc.activeChatId();
    if (!previousUser) {
      this.toast.show('Could not find the original prompt for this answer.', 'error');
      return;
    }
    const originalPrompt = stripModelCheckSuffix(previousUser.content);
    const displayPrompt = `Check response using LLM ${event.modelLabel}`;
    const check = { assistantMessageId: event.assistantMessageId, model: event.model, modelLabel: event.modelLabel };
    if (this.chatSvc.temporaryMode()) {
      this.activeModelCheck.set(check);
      this.sendTemporary(displayPrompt, event.model, event.intelligence, originalPrompt);
      return;
    }
    if (!chatId) {
      this.toast.show('Could not find the original prompt for this answer.', 'error');
      return;
    }
    this.activeModelCheck.set(check);
    this.sendToChat(chatId, originalPrompt, event.model, event.intelligence, displayPrompt);
  }

  checkingModelFor(messageId: string) {
    const active = this.activeModelCheck();
    return active?.assistantMessageId === messageId ? active.model : null;
  }

  checkResponseModelFor(messageId: string): { model: string; modelLabel: string } | null {
    return this.checkResponseMap().get(messageId) ?? null;
  }

  onPreferModel(event: { model: string; modelLabel: string }) {
    this.preferredModel.set(event);
  }

  clearPreferredModel() {
    this.preferredModel.set(null);
  }

  /** Called when the user clicks "Allow folder access" in the inline permission card. */
  async onGrantPermission() {
    const granted = await this.projects.grantPermissionAndApply();
    if (granted) {
      this.toast.show('Folder access granted. Files written.', 'success');
    } else {
      this.toast.show('Folder access was not granted.', 'error');
    }
    this.shouldScrollToBottom = true;
  }

  /** Called when the user clicks "Not now" in the inline permission card. */
  onDismissPermission() {
    this.projects.dismissPermissionRequest();
  }

  private openChat(chatId: string) {
    if (this.chatSvc.temporaryMode()) this.chatSvc.setTemporaryMode(false);
    this.preferredModel.set(null);
    this.checkResponseMap.set(new Map());
    this.chatSvc.selectChat(chatId).subscribe(() => {
      const chat = this.chatSvc.chats().find((item) => item.id === chatId);
      const projectId = chat?.projectId ?? null;
      this.projects.selectProject(projectId);
      // Auto-expand the project in the sidebar so the user can see its chat list
      if (projectId && this.sidebar && !this.sidebar.isProjectExpanded(projectId)) {
        this.sidebar.toggleProjectExpand(projectId);
      }
      this.maybeResumePendingResponse(chatId);
      this.shouldScrollToBottom = true;
    });
  }

  private showProjectHome(projectId: string) {
    this.clearResumePolling();
    if (this.chatSvc.temporaryMode()) this.chatSvc.setTemporaryMode(false);
    this.projects.selectProject(projectId);
    this.chatSvc.reset();
    this.projectTab.set('chats');
    if (this.sidebar && !this.sidebar.isProjectExpanded(projectId)) {
      this.sidebar.toggleProjectExpand(projectId);
    }
    // Explicit file reload: selectProject() already does this, but if the user
    // landed here right after a folder import the backend may have just finished
    // writing files. Re-fetch so the Sources tab is up-to-date.
    this.projects.loadFiles(projectId).subscribe();
    void this.router.navigate(['/chat'], { queryParams: { project: projectId } });
  }

  /**
   * Switch between Chats / Sources tab. When the user opens Sources we
   * re-fetch the file list to pick up any files imported since the last load
   * (e.g. files written via Apply Changes or a background re-sync).
   */
  setProjectTab(tab: 'chats' | 'sources') {
    this.projectTab.set(tab);
    if (tab === 'sources') {
      const projectId = this.projects.activeProjectId();
      if (projectId) this.projects.loadFiles(projectId).subscribe();
    }
  }

  private sendToChat(chatId: string, text: string, model?: string, intelligence = this.selectedIntelligence(), displayText?: string) {
    this.clearResumePolling();
    this.chatSvc.send(chatId, text, intelligence, model, displayText).subscribe({
      next: (res) => {
        const wasCheck = this.activeModelCheck();
        this.activeModelCheck.set(null);
        if (wasCheck) {
          const lastAssistant = [...this.messages()].reverse().find((m) => m.role === 'assistant');
          if (lastAssistant) {
            this.checkResponseMap.update((map) =>
              new Map([...map, [lastAssistant.id, { model: wasCheck.model, modelLabel: wasCheck.modelLabel }]]));
          }
        }
        this.usage.applyAfterSend(res.usage.remainingTodayTokens);
        this.shouldScrollToBottom = true;
      },
      error: (e) => {
        this.activeModelCheck.set(null);
        this.toast.show(e?.error?.message ?? e?.error?.error ?? 'Send failed', 'error');
      },
    });
    this.shouldScrollToBottom = true;
  }

  private sendTemporary(text: string, model?: string, intelligence = this.selectedIntelligence(), actualText = text) {
    this.clearResumePolling();
    this.chatSvc.sendTemporary(text, intelligence, model, actualText).subscribe({
      next: (res) => {
        const wasCheck = this.activeModelCheck();
        this.activeModelCheck.set(null);
        if (wasCheck) {
          const lastAssistant = [...this.messages()].reverse().find((m) => m.role === 'assistant');
          if (lastAssistant) {
            this.checkResponseMap.update((map) =>
              new Map([...map, [lastAssistant.id, { model: wasCheck.model, modelLabel: wasCheck.modelLabel }]]));
          }
        }
        this.usage.applyAfterSend(res.usage.remainingTodayTokens);
        this.shouldScrollToBottom = true;
      },
      error: (e) => {
        this.activeModelCheck.set(null);
        this.toast.show(e?.error?.message ?? e?.error?.error ?? 'Temporary send failed', 'error');
      },
    });
    this.shouldScrollToBottom = true;
  }

  private maybeResumePendingResponse(chatId: string) {
    this.clearResumePolling();
    const last = this.messages()[this.messages().length - 1];
    if (last?.role !== 'user') return;
    if ((this.usage.today()?.remaining ?? 1) <= 0) return;

    this.resumingChatId.set(chatId);
    this.resumePollAttempts = 0;
    this.pollForAssistantReply(chatId);
  }

  private pollForAssistantReply(chatId: string) {
    this.resumePollTimer = setTimeout(() => {
      if (this.chatSvc.activeChatId() !== chatId) {
        this.clearResumePolling();
        return;
      }
      if (this.resumePollAttempts++ >= 60) {
        this.clearResumePolling();
        return;
      }

      // Store the subscription so clearResumePolling() can cancel it if the
      // user sends a new message while this selectChat is in-flight.
      this.resumePollSub = this.chatSvc.selectChat(chatId).subscribe({
        next: () => {
          this.resumePollSub = null;
          const last = this.messages()[this.messages().length - 1];
          if (last?.role === 'assistant') {
            this.clearResumePolling();
            this.shouldScrollToBottom = true;
            return;
          }
          this.pollForAssistantReply(chatId);
        },
        error: () => {
          this.resumePollSub = null;
          this.clearResumePolling();
        },
      });
    }, 2500);
  }

  private clearResumePolling() {
    if (this.resumePollTimer) clearTimeout(this.resumePollTimer);
    this.resumePollTimer = null;
    // Cancel any in-flight selectChat HTTP call so it cannot overwrite
    // messages() after a send() has already updated the signal.
    this.resumePollSub?.unsubscribe();
    this.resumePollSub = null;
    this.resumePollAttempts = 0;
    this.resumingChatId.set(null);
  }

  formatProjectDate(iso: string) {
    const date = new Date(iso);
    const now = new Date();
    const sameYear = date.getFullYear() === now.getFullYear();
    return date.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
  }

  formatTokenCount(total: number) {
    if (total <= 0) return '0 tokens';
    if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(total >= 10_000_000 ? 0 : 1)}M tokens`;
    if (total >= 1_000) return `${(total / 1_000).toFixed(total >= 10_000 ? 0 : 1)}k tokens`;
    return `${total.toLocaleString()} tokens`;
  }

}

function isModelCheckMessage(content: string) {
  const text = content.trim();
  return /^check response using LLM\b/i.test(text) || stripModelCheckSuffix(text) !== text;
}

function stripModelCheckSuffix(content: string) {
  return content.trim().replace(/\s+using\s+LLM\s+[\w .-]+$/i, '').trim();
}

function writeErrorMessage(error: unknown) {
  const message = (error as { message?: string })?.message ?? '';
  if (/could not be modified|not allowed|permission|read.?only|writable/i.test(message)) {
    return 'Could not write to the selected folder. Please reconnect the project folder and allow edit access.';
  }
  return message || 'Could not apply changes to your folder.';
}

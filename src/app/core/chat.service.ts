import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { finalize, tap } from 'rxjs';
import { environment } from '../../environments/environment';
import { Chat, ChatMessage, IntelligenceLevel, ProposedChange, SendResponse, UsedContext } from './models';

@Injectable({ providedIn: 'root' })
export class ChatService {
  private http = inject(HttpClient);
  private router = inject(Router);
  private base = environment.apiUrl + '/v1';

  readonly chats = signal<Chat[]>([]);
  readonly activeChatId = signal<string | null>(null);
  readonly messages = signal<ChatMessage[]>([]);
  readonly sending = signal<boolean>(false);
  readonly pinnedChatId = signal<string | null>(null);
  readonly temporaryMode = signal<boolean>(false);

  /** Proposed changes attached to the most recent assistant reply, keyed by message id. */
  readonly proposedChanges = signal<Record<string, ProposedChange[]>>({});

  /** Project files used as context for each assistant reply (RAG), keyed by message id. */
  readonly usedContext = signal<Record<string, UsedContext[]>>({});
  /** Lightweight follow-up suggestions attached to assistant replies. */
  readonly followUps = signal<Record<string, string[]>>({});
  /** Downgrade notes attached to assistant replies, keyed by message id. */
  readonly downgradeNotes = signal<Record<string, string>>({});
  /** Actual token usage metadata attached to assistant replies, keyed by message id. */
  readonly tokenMeta = signal<Record<string, string>>({});
  /** Intelligence level used by each assistant reply, keyed by message id. */
  readonly replyIntelligence = signal<Record<string, IntelligenceLevel>>({});

  /**
   * Load the chat list, optionally scoped to a specific project context.
   *  - `projectId` undefined → all chats
   *  - `projectId` null      → personal chats only
   *  - `projectId` <uuid>    → chats inside that project
   */
  loadChats(projectId?: string | null) {
    let params = '';
    if (projectId === null) params = '?projectId=null';
    else if (typeof projectId === 'string') params = `?projectId=${encodeURIComponent(projectId)}`;
    return this.http
      .get<{ chats: Chat[] }>(`${this.base}/chats${params}`)
      .pipe(tap((res) => this.chats.set(res.chats)));
  }

  searchChats(query: string) {
    return this.http.get<{ chats: Chat[] }>(
      `${this.base}/chats/search?q=${encodeURIComponent(query)}`,
    );
  }

  createChat(projectId?: string | null, title?: string | null, preserveMessages = false) {
    return this.http
      .post<{ chat: Chat }>(`${this.base}/chats`, { projectId: projectId ?? null, title: title ?? undefined })
      .pipe(
        tap((res) => {
          this.chats.set([res.chat, ...this.chats()]);
          this.activeChatId.set(res.chat.id);
          this.pinnedChatId.set(res.chat.id);
          if (!preserveMessages) this.messages.set([]);
        }),
      );
  }

  selectChat(chatId: string) {
    this.activeChatId.set(chatId);
    this.pinnedChatId.set(chatId);
    return this.http
      .get<{ messages: ChatMessage[] }>(`${this.base}/chats/${chatId}/messages`)
      .pipe(tap((res) => {
        const pending = this.sending()
          ? this.messages()
              .filter((m) => m.role === 'user' && m.id.startsWith('tmp-user-'))
              .map((m) => ({ ...m, chatId }))
          : [];
        const savedIds = new Set(res.messages.map((m) => m.id));
        const savedUserContent = new Set(
          res.messages
            .filter((m) => m.role === 'user')
            .map((m) => normalizeMessageContent(m.content)),
        );
        this.messages.set([
          ...res.messages,
          ...pending.filter((m) =>
            !savedIds.has(m.id) && !savedUserContent.has(normalizeMessageContent(m.content)),
          ),
        ]);
      }));
  }

  beginPendingSend(message: string) {
    this.sending.set(true);
    this.activeChatId.set('pending');
    this.pinnedChatId.set('pending');
    const optimistic: ChatMessage = {
      id: 'tmp-user-pending-' + Date.now(),
      chatId: 'pending',
      role: 'user',
      content: message,
      model: null,
      tokensIn: null,
      tokensOut: null,
      createdAt: new Date().toISOString(),
    };
    this.messages.set([optimistic]);
  }

  cancelPendingSend() {
    this.messages.set(this.messages().filter((m) => !m.id.startsWith('tmp-user-pending-')));
    if (this.activeChatId() === 'pending') this.activeChatId.set(null);
    if (this.pinnedChatId() === 'pending') this.pinnedChatId.set(null);
    this.sending.set(false);
  }

  send(chatId: string, message: string, intelligence: IntelligenceLevel = 'low', model?: string, displayMessage?: string) {
    this.sending.set(true);
    const visibleMessage = displayMessage ?? message;
    const existingOptimistic = this.messages().find((m) =>
      m.role === 'user' &&
      m.id.startsWith('tmp-user-pending-') &&
      m.content === visibleMessage
    );
    const optimisticId = existingOptimistic?.id ?? 'tmp-user-' + Date.now();
    if (existingOptimistic) {
      this.messages.set(this.messages().map((m) => m.id === optimisticId ? { ...m, chatId } : m));
    } else {
      // optimistic user message
      const optimistic: ChatMessage = {
        id: optimisticId,
        chatId,
        role: 'user',
        content: visibleMessage,
        model: null,
        tokensIn: null,
        tokensOut: null,
        createdAt: new Date().toISOString(),
      };
      this.messages.set([...this.messages(), optimistic]);
    }

    return this.http.post<SendResponse>(
      `${this.base}/chats/${chatId}/messages`,
      { message, intelligence, ...(displayMessage ? { displayMessage } : {}), ...(model ? { model } : {}) },
    ).pipe(
      tap((res) => {
        const assistant: ChatMessage = {
          id: res.reply.id,
          chatId,
          role: 'assistant',
          content: res.reply.content,
          model: res.reply.model,
          tokensIn: null,
          tokensOut: null,
          createdAt: res.reply.createdAt,
        };
        const savedUser: ChatMessage | null = res.userMessage
          ? {
              id: res.userMessage.id,
              chatId,
              role: 'user',
              content: res.userMessage.content,
              model: null,
              tokensIn: null,
              tokensOut: null,
              createdAt: res.userMessage.createdAt,
            }
          : null;
        // Replace only this request's optimistic user bubble, then append the
        // assistant response. Other optimistic messages must stay visible.
        const withoutDupe = this.messages()
          .filter((m) => m.id !== res.reply.id && (!savedUser || m.id !== savedUser.id))
          .map((m) => (m.id === optimisticId ? (savedUser ?? m) : m));
        const hasUser = savedUser ? withoutDupe.some((m) => m.id === savedUser.id) : true;
        const withUser = savedUser && !hasUser ? [...withoutDupe, savedUser] : withoutDupe;
        this.messages.set([...withUser, assistant]);

        // bump this chat to top of list and set title if blank
        const list = this.chats();
        const idx = list.findIndex((c) => c.id === chatId);
        if (idx >= 0) {
          const updated = {
            ...list[idx]!,
            lastActive: new Date().toISOString(),
            totalTokens: (list[idx]!.totalTokens ?? 0) + res.usage.tokens,
          };
          if (!updated.title) updated.title = message.slice(0, 60);
          this.chats.set([updated, ...list.filter((_, i) => i !== idx)]);
        }
        // PROPOSE-ONLY: do NOT write to project files automatically.
        // Surface the parsed changes so the message renderer can display them
        // and (later) the user can choose to accept them.
        if (res.proposedChanges?.length) {
          this.proposedChanges.update((current) => ({
            ...current,
            [res.reply.id]: res.proposedChanges!,
          }));
        }
        // Surface the RAG context that was actually used so the user can see it.
        if (res.usedContext?.length) {
          this.usedContext.update((current) => ({
            ...current,
            [res.reply.id]: res.usedContext!,
          }));
        }
        if (res.followUps?.length) {
          this.followUps.update((current) => ({
            ...current,
            [res.reply.id]: res.followUps!,
          }));
        }
        if (res.downgrade) {
          const downgrade = res.downgrade;
          this.downgradeNotes.update((current) => ({
            ...current,
            [res.reply.id]: `Requested ${capitalize(downgrade.requested)}, used ${capitalize(downgrade.used)}. ${downgrade.reason}`,
          }));
        }
        this.tokenMeta.update((current) => ({
          ...current,
          [res.reply.id]: buildTokenMeta(res),
        }));
        this.replyIntelligence.update((current) => ({
          ...current,
          [res.reply.id]: res.routing.intelligence,
        }));
      }),
      finalize(() => this.sending.set(false)),
    );
  }

  sendTemporary(displayMessage: string, intelligence: IntelligenceLevel = 'low', model?: string, message = displayMessage) {
    this.sending.set(true);
    const chatId = 'temporary';
    const history = this.messages()
      .filter((item) => item.role === 'user' || item.role === 'assistant')
      .map((item) => ({ role: item.role as 'user' | 'assistant', content: item.content }));
    const optimistic: ChatMessage = {
      id: 'tmp-user-' + Date.now(),
      chatId,
      role: 'user',
      content: displayMessage,
      model: null,
      tokensIn: null,
      tokensOut: null,
      createdAt: new Date().toISOString(),
    };
    this.messages.set([...this.messages(), optimistic]);

    return this.http.post<SendResponse>(
      `${this.base}/chats/temporary/messages`,
      { message, history, intelligence, ...(model ? { model } : {}) },
    ).pipe(
      tap((res) => {
        const assistant: ChatMessage = {
          id: res.reply.id,
          chatId,
          role: 'assistant',
          content: res.reply.content,
          model: res.reply.model,
          tokensIn: null,
          tokensOut: null,
          createdAt: res.reply.createdAt,
        };
        const withoutDupe = this.messages().filter((m) => m.id !== res.reply.id);
        this.messages.set([...withoutDupe, assistant]);
        if (res.followUps?.length) {
          this.followUps.update((current) => ({
            ...current,
            [res.reply.id]: res.followUps!,
          }));
        }
        if (res.downgrade) {
          const downgrade = res.downgrade;
          this.downgradeNotes.update((current) => ({
            ...current,
            [res.reply.id]: `Requested ${capitalize(downgrade.requested)}, used ${capitalize(downgrade.used)}. ${downgrade.reason}`,
          }));
        }
        this.tokenMeta.update((current) => ({
          ...current,
          [res.reply.id]: buildTokenMeta(res),
        }));
        this.replyIntelligence.update((current) => ({
          ...current,
          [res.reply.id]: res.routing.intelligence,
        }));
      }),
      finalize(() => this.sending.set(false)),
    );
  }

  reset() {
    this.activeChatId.set(null);
    this.pinnedChatId.set(null);
    this.messages.set([]);
  }

  clearActiveThread() {
    this.activeChatId.set(null);
    this.messages.set([]);
  }

  setTemporaryMode(enabled: boolean) {
    this.temporaryMode.set(enabled);
    this.activeChatId.set(null);
    this.pinnedChatId.set(null);
    this.messages.set([]);
    this.clearTransientMessageMeta();
  }

  truncateTemporaryFrom(messageId: string) {
    const idx = this.messages().findIndex((message) => message.id === messageId);
    if (idx >= 0) this.messages.set(this.messages().slice(0, idx));
  }

  delete(chatId: string) {
    return this.http.delete(`${this.base}/chats/${chatId}`).pipe(
      tap(() => {
        this.chats.set(this.chats().filter((c) => c.id !== chatId));
        if (this.activeChatId() === chatId) {
          this.reset();
          void this.router.navigate(['/chat']);
        }
      }),
    );
  }

  truncateFromMessage(chatId: string, messageId: string) {
    return this.http.post<{ ok: true; deleted: number }>(
      `${this.base}/chats/${chatId}/messages/${messageId}/truncate`,
      {},
    ).pipe(
      tap(() => {
        const idx = this.messages().findIndex((message) => message.id === messageId);
        if (idx >= 0) this.messages.set(this.messages().slice(0, idx));
      }),
    );
  }

  /** Look up proposed changes attached to a specific assistant message id. */
  getProposedChanges(messageId: string): ProposedChange[] {
    return this.proposedChanges()[messageId] ?? [];
  }

  /** Look up the RAG context used to answer a specific assistant message. */
  getUsedContext(messageId: string): UsedContext[] {
    return this.usedContext()[messageId] ?? [];
  }

  getFollowUps(messageId: string): string[] {
    return this.followUps()[messageId] ?? [];
  }

  getDowngradeNote(messageId: string): string | null {
    return this.downgradeNotes()[messageId] ?? null;
  }

  getTokenMeta(messageId: string): string | null {
    return this.tokenMeta()[messageId] ?? null;
  }

  getReplyIntelligence(messageId: string): IntelligenceLevel | null {
    return this.replyIntelligence()[messageId] ?? null;
  }

  private clearTransientMessageMeta() {
    this.proposedChanges.set({});
    this.usedContext.set({});
    this.followUps.set({});
    this.downgradeNotes.set({});
    this.tokenMeta.set({});
    this.replyIntelligence.set({});
  }
}

function capitalize(value: string) {
  return value ? value[0]!.toUpperCase() + value.slice(1) : value;
}

function buildTokenMeta(res: SendResponse) {
  const parts = [
    `Used ${res.usage.tokens.toLocaleString()} tokens`,
    // `Prompt ${res.usage.promptTokens.toLocaleString()}`,
    // `Output ${res.usage.outputTokens.toLocaleString()}`,
    // `Strategy ${res.routing.strategy.replace(/_/g, ' ')}`,
  ];
  if (res.usedContext?.length) parts.push('project context used');
  return parts.join(' · ');
}

function normalizeMessageContent(value: string) {
  return value.trim().replace(/\s+/g, ' ');
}

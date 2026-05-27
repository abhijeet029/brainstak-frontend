import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, OnChanges, Output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ChatMessage, IntelligenceLevel, ProposedChange, UsedContext } from '../../core/models';

// ── Unified diff ─────────────────────────────────────────────────────────────

export type DiffLineKind = 'add' | 'remove' | 'same';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldNum: number | null;
  newNum: number | null;
}

/**
 * Computes a line-level unified diff between two strings using a simple LCS.
 * Returns at most `maxLines` lines (truncates the middle if needed).
 */
function computeUnifiedDiff(original: string, proposed: string, maxLines = 120): DiffLine[] {
  const oldLines = original === '' ? [] : original.split('\n');
  const newLines = proposed === '' ? [] : proposed.split('\n');

  // Build LCS table
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i]![j] = oldLines[i] === newLines[j]
        ? (dp[i + 1]![j + 1] ?? 0) + 1
        : Math.max(dp[i + 1]![j] ?? 0, dp[i]![j + 1] ?? 0);
    }
  }

  // Backtrack
  const lines: DiffLine[] = [];
  let i = 0, j = 0, oldNum = 1, newNum = 1;
  while (i < m || j < n) {
    if (i < m && j < n && oldLines[i] === newLines[j]) {
      lines.push({ kind: 'same', text: oldLines[i]!, oldNum: oldNum++, newNum: newNum++ });
      i++; j++;
    } else if (j < n && (i >= m || (dp[i]![j + 1] ?? 0) >= (dp[i + 1]![j] ?? 0))) {
      lines.push({ kind: 'add', text: newLines[j]!, oldNum: null, newNum: newNum++ });
      j++;
    } else {
      lines.push({ kind: 'remove', text: oldLines[i]!, oldNum: oldNum++, newNum: null });
      i++;
    }
  }

  if (lines.length <= maxLines) return lines;

  // Trim unchanged lines in the middle, keep 3 context lines around changes
  const CONTEXT = 3;
  const changed = new Set<number>();
  lines.forEach((l, idx) => { if (l.kind !== 'same') changed.add(idx); });
  const keep = new Set<number>();
  changed.forEach((idx) => {
    for (let k = Math.max(0, idx - CONTEXT); k <= Math.min(lines.length - 1, idx + CONTEXT); k++) keep.add(k);
  });

  const trimmed: DiffLine[] = [];
  let lastKept = -1;
  lines.forEach((l, idx) => {
    if (!keep.has(idx)) return;
    if (lastKept >= 0 && idx > lastKept + 1) {
      trimmed.push({ kind: 'same', text: '⋯', oldNum: null, newNum: null });
    }
    trimmed.push(l);
    lastKept = idx;
  });
  return trimmed;
}

/** Per-file status tracked in the component. */
export type FileChangeStatus = 'pending' | 'applying' | 'applied' | 'dismissed';

interface TextBlock {
  type: 'text';
  html: string;
}

interface CodeBlock {
  type: 'code';
  code: string;
  language: string | null;
  /** Relative project path when the model tagged the fence with `path:foo/bar.ts`. */
  path: string | null;
  highlightedHtml: string;
}

type MessageBlock = TextBlock | CodeBlock;

@Component({
  selector: 'app-message',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './message.component.html',
  styleUrl: './message.component.scss',
})
export class MessageComponent implements OnChanges {
  @Input({ required: true }) message!: ChatMessage;
  @Input() userInitial = 'U';
  @Input() followUps: string[] = [];
  @Input() downgradeNote: string | null = null;
  @Input() tokenMeta: string | null = null;
  @Input() replyIntelligence: IntelligenceLevel | null = null;
  @Input() checkingModel: string | null = null;
  /** Set when this message is a model-check response; shows the "Prefer" chip. */
  @Input() preferChip: { model: string; modelLabel: string } | null = null;
  /** Project files (RAG slices) that grounded this assistant reply, if any. */
  @Input() usedContext: UsedContext[] = [];
  /** Proposed file changes parsed from this reply. */
  @Input() proposedChanges: ProposedChange[] = [];

  readonly contextExpanded = signal(false);
  @Output() useFollowUp = new EventEmitter<string>();
  /** Emitted when the user clicks Apply on a SINGLE file. `done(true)` → applied, `done(false)` → failed/denied. */
  @Output() applyChange = new EventEmitter<{ change: ProposedChange; done: (success: boolean) => void }>();
  /** Emitted when the user clicks Apply All (backwards compat). */
  @Output() applyChanges = new EventEmitter<ProposedChange[]>();
  /** Emitted when the user clicks Undo on a file that was just applied. */
  @Output() undoChange = new EventEmitter<{ path: string; done: () => void }>();
  @Output() editResend = new EventEmitter<{ chatId: string; messageId: string; content: string }>();
  @Output() checkModel = new EventEmitter<{ assistantMessageId: string; model: string; modelLabel: string; intelligence: IntelligenceLevel }>();
  @Output() preferModel = new EventEmitter<{ model: string; modelLabel: string }>();
  @Output() regenerateResponse = new EventEmitter<{ assistantMessageId: string; model: string | null; modelLabel: string | null; intelligence: IntelligenceLevel }>();

  readonly copiedIndex = signal<number | null>(null);
  readonly responseCopied = signal(false);
  readonly changesPanelOpen = signal(false);
  readonly modelMenuOpen = signal(false);
  readonly suggestionMenuOpen = signal(false);
  readonly editing = signal(false);
  editDraft = '';
  private lastMessageId: string | null = null;

  /** Per-file status: key = path, value = status. */
  readonly fileStatus = signal<Record<string, FileChangeStatus>>({});
  /** Which file cards are expanded to show the diff. */
  readonly expandedFiles = signal<Record<string, boolean>>({});

  ngOnChanges() {
    const messageChanged = this.lastMessageId !== this.message.id;
    this.lastMessageId = this.message.id;

    // Initialize status for any new proposed changes
    if (this.proposedChanges.length) {
      const current = this.fileStatus();
      const next = { ...current };
      let changed = false;
      for (const c of this.proposedChanges) {
        if (!next[c.path]) {
          next[c.path] = 'pending';
          changed = true;
        }
      }
      if (changed) this.fileStatus.set(next);
      // Auto-expand all files on first load
      const exp = this.expandedFiles();
      const nextExp = { ...exp };
      let expChanged = false;
      for (const c of this.proposedChanges) {
        if (nextExp[c.path] === undefined) {
          nextExp[c.path] = true;
          expChanged = true;
        }
      }
      if (expChanged) this.expandedFiles.set(nextExp);
    } else {
      this.changesPanelOpen.set(false);
    }
    if (messageChanged) {
      this.modelMenuOpen.set(false);
      this.suggestionMenuOpen.set(false);
    }
  }

  isUser = () => this.message.role === 'user';
  author = () => (this.isUser() ? 'You' : 'Hub');
  initial = () => (this.isUser() ? this.userInitial : 'H');
  renderedBlocks = () => parseMessage(this.message.content);
  isStreamingAssistant = () => !this.isUser() && this.message.id.startsWith('tmp-assistant-');
  visibleBlocks = () => {
    const blocks = this.renderedBlocks();
    if (!this.hasProposedChanges()) return blocks;
    return blocks.filter((block) => block.type !== 'code' || !block.path);
  };
  llmLabel = () => {
    if (this.isUser() || !this.message.model) return null;
    const provider = inferProvider(this.message.model);
    return `${provider} · ${this.message.model}`;
  };
  hasFollowUps = () => !this.isUser() && this.followUps.length > 0;
  hasProposedChanges = () => !this.isUser() && this.proposedChanges.length > 0;
  alternateModels = () => {
    if (this.isUser() || !this.message.model) return [];
    return sameTierModels(this.responseIntelligence()).filter((model) => model.id !== this.message.model);
  };
  responseIntelligence = (): IntelligenceLevel =>
    this.replyIntelligence ?? (this.message.model ? levelForModel(this.message.model) : 'low');
  isCheckingModel = (modelId: string) => this.checkingModel === modelId;
  isCheckDisabled = (modelId: string) => !!this.checkingModel && this.checkingModel !== modelId;
  currentModelLabel = () =>
    this.message.model
      ? sameTierModels(this.responseIntelligence()).find((model) => model.id === this.message.model)?.label ?? this.message.model
      : null;

  toggleModelMenu() {
    if (!this.alternateModels().length) return;
    this.modelMenuOpen.set(!this.modelMenuOpen());
    this.suggestionMenuOpen.set(false);
  }

  checkWithModel(model: { id: string; label: string }) {
    this.modelMenuOpen.set(false);
    this.checkModel.emit({
      assistantMessageId: this.message.id,
      model: model.id,
      modelLabel: model.label,
      intelligence: this.responseIntelligence(),
    });
  }

  regenerateCurrentResponse() {
    if (this.isUser()) return;
    this.modelMenuOpen.set(false);
    this.regenerateResponse.emit({
      assistantMessageId: this.message.id,
      model: this.message.model,
      modelLabel: this.currentModelLabel(),
      intelligence: this.responseIntelligence(),
    });
  }

  regenerateTooltipModelLabel() {
    return this.currentModelLabel() ?? this.message.model ?? 'Current model';
  }

  toggleSuggestionMenu() {
    if (!this.hasFollowUps()) return;
    this.suggestionMenuOpen.set(!this.suggestionMenuOpen());
    this.modelMenuOpen.set(false);
  }

  useSuggestion(item: string) {
    this.suggestionMenuOpen.set(false);
    this.useFollowUp.emit(item);
  }

  startEdit() {
    this.editDraft = this.message.content;
    this.editing.set(true);
  }

  cancelEdit() {
    this.editing.set(false);
    this.editDraft = '';
  }

  submitEdit() {
    const content = this.editDraft.trim();
    if (!content) return;
    this.editing.set(false);
    this.editResend.emit({ chatId: this.message.chatId, messageId: this.message.id, content });
  }

  pendingChanges = () =>
    this.proposedChanges.filter((c) => this.fileStatus()[c.path] === 'pending');

  getFileStatus = (path: string): FileChangeStatus =>
    this.fileStatus()[path] ?? 'pending';

  isFileExpanded = (path: string): boolean =>
    this.expandedFiles()[path] ?? false;

  toggleFileExpand(path: string) {
    this.expandedFiles.update((e) => ({ ...e, [path]: !e[path] }));
  }

  getDiff(change: ProposedChange): DiffLine[] {
    if (!change.originalContent) return [];
    return computeUnifiedDiff(change.originalContent, change.content);
  }

  onApplySingle(change: ProposedChange) {
    this.fileStatus.update((s) => ({ ...s, [change.path]: 'applying' }));
    this.applyChange.emit({
      change,
      done: (success: boolean) => {
        this.fileStatus.update((s) => ({
          ...s,
          [change.path]: success ? 'applied' : 'pending',
        }));
      },
    });
  }

  onDismiss(path: string) {
    this.fileStatus.update((s) => ({ ...s, [path]: 'dismissed' }));
  }

  /** Undo a previously applied file change. Reverts both DB and local folder. */
  onUndoSingle(path: string) {
    this.fileStatus.update((s) => ({ ...s, [path]: 'applying' }));
    this.undoChange.emit({
      path,
      done: () => {
        // Snapshot is gone after revert → mark as pending again so the user can
        // re-apply if they change their mind, or dismiss to remove the card.
        this.fileStatus.update((s) => ({ ...s, [path]: 'pending' }));
      },
    });
  }

  onApplyAll() {
    const pending = this.pendingChanges();
    for (const c of pending) {
      this.fileStatus.update((s) => ({ ...s, [c.path]: 'applying' }));
    }
    // applyChanges event is handled async by chat.component; we leave the status
    // as 'applying' until it resolves. If permission is needed, status stays
    // 'applying' until the user grants access and the chat re-triggers.
    this.applyChanges.emit(pending);
    this.changesPanelOpen.set(false);
  }

  async copyCode(code: string, index: number) {
    try {
      await navigator.clipboard.writeText(code);
      this.copiedIndex.set(index);
      window.setTimeout(() => {
        if (this.copiedIndex() === index) this.copiedIndex.set(null);
      }, 1800);
    } catch {
      this.copiedIndex.set(null);
    }
  }

  async copyResponse() {
    try {
      await navigator.clipboard.writeText(stripMarkdown(this.message.content));
      this.responseCopied.set(true);
      window.setTimeout(() => this.responseCopied.set(false), 1800);
    } catch {
      this.responseCopied.set(false);
    }
  }
}

function inferProvider(model: string) {
  const lower = model.toLowerCase();
  if (lower.startsWith('gemini')) return 'Gemini';
  if (lower.startsWith('gpt') || lower.includes('openai')) return 'OpenAI';
  if (lower.startsWith('claude')) return 'Anthropic';
  return 'LLM';
}

function sameTierModels(level: IntelligenceLevel): Array<{ id: string; label: string }> {
  const cheap = [
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    { id: 'mistral-small-latest', label: 'Mistral Small' },
    { id: 'deepseek-chat', label: 'DeepSeek Chat' },
  ];
  const mid = [
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
    { id: 'deepseek-reasoner', label: 'DeepSeek R1' },
    { id: 'gpt-4.1-mini', label: 'GPT-4.1 Mini' },
  ];
  const premium = [
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    { id: 'gpt-4.1-mini', label: 'GPT-4.1 Mini' },
  ];

  if (level === 'high') return premium;
  if (level === 'medium') return mid;
  return cheap;
}

function levelForModel(modelId: string): IntelligenceLevel {
  if (modelId === 'claude-sonnet-4-6') return 'high';
  if (modelId === 'claude-haiku-4-5-20251001' || modelId === 'deepseek-reasoner' || modelId === 'gpt-4.1-mini') return 'medium';
  return 'low';
}

/**
 * Converts markdown text to clean plain text for clipboard copy,
 * similar to how ChatGPT/Claude copy buttons work.
 */
function stripMarkdown(md: string): string {
  return md
    // Fenced code blocks — keep the code content, drop the fence lines
    .replace(/```[^\n]*\n([\s\S]*?)```/g, (_, code: string) => code.trimEnd() + '\n')
    // Inline code — remove backticks
    .replace(/`([^`]+)`/g, '$1')
    // ATX headings (# ## ###) — strip the hashes
    .replace(/^#{1,6}\s+/gm, '')
    // Bold + italic (***text*** or ___text___)
    .replace(/\*{3}(.+?)\*{3}/g, '$1')
    .replace(/_{3}(.+?)_{3}/g, '$1')
    // Bold (**text** or __text__)
    .replace(/\*{2}(.+?)\*{2}/g, '$1')
    .replace(/_{2}(.+?)_{2}/g, '$1')
    // Italic (*text* or _text_)
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    // Strikethrough (~~text~~)
    .replace(/~~(.+?)~~/g, '$1')
    // Images — keep alt text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    // Links — keep link text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // Blockquotes — strip leading >
    .replace(/^>\s*/gm, '')
    // Unordered list bullets (-, *, +)
    .replace(/^[\s]*[-*+]\s+/gm, '')
    // Ordered list numbers
    .replace(/^[\s]*\d+\.\s+/gm, '')
    // Horizontal rules
    .replace(/^[-*_]{3,}\s*$/gm, '')
    // HTML tags (e.g. <br>, <strong>)
    .replace(/<[^>]+>/g, '')
    // Collapse 3+ blank lines to 2
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseMessage(text: string): MessageBlock[] {
  const blocks: MessageBlock[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const textBuffer: string[] = [];
  let codeBuffer: string[] = [];
  let inCodeBlock = false;
  let activeFence = '```';
  let activeLanguage: string | null = null;
  let activePath: string | null = null;

  const flushText = () => {
    const html = formatTextBlock(textBuffer.join('\n'));
    if (html) blocks.push({ type: 'text', html });
    textBuffer.length = 0;
  };

  const flushCode = () => {
    blocks.push({
      type: 'code',
      language: activeLanguage,
      path: activePath,
      code: trimCodeBlock(codeBuffer.join('\n')),
      highlightedHtml: highlightCode(codeBuffer.join('\n'), activeLanguage),
    });
    codeBuffer = [];
    activeLanguage = null;
    activePath = null;
    activeFence = '```';
  };

  for (const line of lines) {
    if (!inCodeBlock) {
      const opening = parseFenceStart(line);
      if (opening) {
        flushText();
        inCodeBlock = true;
        activeFence = opening.fence;
        activeLanguage = opening.language;
        activePath = opening.path;
        continue;
      }
      textBuffer.push(line);
      continue;
    }

    if (line.trim() === activeFence) {
      flushCode();
      inCodeBlock = false;
      continue;
    }

    codeBuffer.push(line);
  }

  if (inCodeBlock) {
    flushCode();
  } else {
    flushText();
  }

  return blocks.length ? blocks : [{ type: 'text', html: formatTextBlock(text) || '<p></p>' }];
}

function parseFenceStart(
  line: string,
): { fence: '```' | '``'; language: string | null; path: string | null } | null {
  const trimmed = line.trim();
  let fence: '```' | '``';
  let body: string;
  if (trimmed.startsWith('```')) {
    fence = '```';
    body = trimmed.slice(3);
  } else if (trimmed.startsWith('``')) {
    fence = '``';
    body = trimmed.slice(2);
  } else {
    return null;
  }

  // Extract `path:foo/bar.ts` or `file:foo/bar.ts` from the info string.
  let path: string | null = null;
  const pathMatch = body.match(/(?:^|\s)(?:path|file)[:=]([^\s]+)/i);
  if (pathMatch) {
    path = (pathMatch[1] ?? '').replace(/^["']|["']$/g, '') || null;
    body = body.replace(pathMatch[0], ' ').trim();
  }

  return { fence, language: normalizeLanguage(body), path };
}

function formatTextBlock(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';

  const lines = trimmed.split('\n');
  const parts: string[] = [];
  let paragraphBuffer: string[] = [];
  let listBuffer: Array<{ ordered: boolean; content: string }> = [];
  let tableBuffer: string[] = [];

  const flushParagraph = () => {
    if (!paragraphBuffer.length) return;
    const paragraph = paragraphBuffer.join('\n').trim();
    paragraphBuffer = [];
    if (!paragraph) return;

    if (paragraph.startsWith('>')) {
      const html = formatInlineMarkdown(paragraph.replace(/^>\s?/gm, '')).replace(/\n/g, '<br>');
      parts.push(`<p class="accent-line">${html}</p>`);
      return;
    }

    const headingMatch = paragraph.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      const level = Math.min(4, headingMatch[1]!.length);
      parts.push(`<h${level}>${formatInlineMarkdown(headingMatch[2]!.trim())}</h${level}>`);
      return;
    }

    parts.push(`<p>${formatInlineMarkdown(paragraph).replace(/\n/g, '<br>')}</p>`);
  };

  const flushList = () => {
    if (!listBuffer.length) return;
    const ordered = listBuffer[0]!.ordered;
    const tag = ordered ? 'ol' : 'ul';
    const items = listBuffer.map((item) => `<li>${formatInlineMarkdown(item.content)}</li>`).join('');
    parts.push(`<${tag}>${items}</${tag}>`);
    listBuffer = [];
  };

  const flushTable = () => {
    if (!tableBuffer.length) return;
    const html = formatMarkdownTable(tableBuffer);
    if (html) parts.push(html);
    else paragraphBuffer.push(...tableBuffer);
    tableBuffer = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const trimmedLine = line.trim();

    if (!trimmedLine) {
      flushParagraph();
      flushList();
      flushTable();
      continue;
    }

    // Ignore markdown horizontal-rule separators like ---, ***, ___
    // so they don't render as awkward plain text rows.
    if (/^[-*_]{3,}$/.test(trimmedLine)) {
      flushParagraph();
      flushList();
      flushTable();
      continue;
    }

    if (looksLikeTableLine(trimmedLine)) {
      flushParagraph();
      flushList();
      tableBuffer.push(trimmedLine);
      continue;
    }

    if (tableBuffer.length) flushTable();

    const headingLine = trimmedLine.match(/^(#{1,4})\s+(.+)$/);
    if (headingLine) {
      flushParagraph();
      flushList();
      flushTable();
      const level = Math.min(4, headingLine[1]!.length);
      parts.push(`<h${level}>${formatInlineMarkdown(headingLine[2]!.trim())}</h${level}>`);
      continue;
    }

    const bulletMatch = trimmedLine.match(/^[-*+]\s+(?:\[[ xX]\]\s*)?(.+)$/);
    const orderedMatch = trimmedLine.match(/^\d+\.\s+(.+)$/);
    if (bulletMatch || orderedMatch) {
      flushParagraph();
      flushTable();
      listBuffer.push({
        ordered: Boolean(orderedMatch),
        content: (orderedMatch?.[1] ?? bulletMatch?.[1] ?? '').trim(),
      });
      continue;
    }

    if (listBuffer.length) flushList();
    paragraphBuffer.push(trimmedLine);
  }

  flushParagraph();
  flushList();
  flushTable();
  return parts.join('');
}

function looksLikeTableLine(line: string): boolean {
  return line.includes('|') && line.split('|').length >= 3;
}

function isMarkdownTableSeparator(line: string): boolean {
  const cells = splitTableRow(line);
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function splitTableRow(line: string): string[] {
  return line
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function formatMarkdownTable(lines: string[]): string {
  if (lines.length < 2) return '';
  const separatorIndex = lines.findIndex(isMarkdownTableSeparator);
  if (separatorIndex <= 0) return '';

  const header = splitTableRow(lines[separatorIndex - 1]!);
  const bodyLines = lines.slice(separatorIndex + 1).filter((line) => !isMarkdownTableSeparator(line));
  if (!header.length || !bodyLines.length) return '';

  const rows = bodyLines.map(splitTableRow).filter((row) => row.length > 1);
  if (!rows.length) return '';

  const renderCell = (cell: string, tag: 'th' | 'td') => `<${tag}>${formatInlineMarkdown(cell)}</${tag}>`;
  return [
    '<div class="md-table-wrap"><table class="md-table">',
    `<thead><tr>${header.map((cell) => renderCell(cell, 'th')).join('')}</tr></thead>`,
    `<tbody>${rows.map((row) => `<tr>${header.map((_, index) => renderCell(row[index] ?? '', 'td')).join('')}</tr>`).join('')}</tbody>`,
    '</table></div>',
  ].join('');
}

function formatInlineMarkdown(text: string): string {
  let output = escapeHtml(text);

  output = output.replace(/`([^`]+)`/g, (_, code: string) => `<code class="inline-code">${code}</code>`);
  output = output.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Render markdown links [label](url). Strips any that look like auto-linked
  // code identifiers (foo.bar where "url" == "http://foo.bar") — these are
  // model hallucinations where dot-notation was mistaken for a domain.
  output = output.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_, label: string, url: string) => {
      // If the URL is just http://label (model auto-linked a code identifier),
      // strip the link and render the label as inline-code instead.
      const decodedLabel = label.replace(/\./g, '.'); // identity, for clarity
      const expectedAutoLink = `http://${decodedLabel}`;
      if (url === expectedAutoLink || url === `https://${decodedLabel}`) {
        return `<code class="inline-code">${label}</code>`;
      }
      return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    },
  );

  return output;
}

function trimCodeBlock(code: string): string {
  return code.replace(/^\n+/, '').replace(/\s+$/, '');
}

function normalizeLanguage(language: string): string | null {
  const clean = language.trim().replace(/[^a-zA-Z0-9#+._-]/g, '');
  return clean || null;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function highlightCode(code: string, language: string | null): string {
  const raw = trimCodeBlock(code);
  return isMarkupLanguage(language) ? highlightMarkup(raw) : highlightScript(raw);
}

function highlightScript(code: string): string {
  const tokenRe =
    /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#(?!include\b)[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|\b(?:const|let|var|function|return|if|else|for|while|switch|case|break|continue|try|catch|throw|new|class|extends|async|await|import|from|export|default|public|private|protected|static|interface|type|implements|null|true|false)\b|\b[A-Za-z_$][\w$]*(?=\()|[=+\-*/<>!&|%]+|[{}()[\].,;:])/g;

  return highlightByRegex(code, tokenRe, (token) => {
    if (/^(\/\/|\/\*|#)/.test(token)) return wrapToken('tok-comment', token);
    if (/^["'`]/.test(token)) return wrapToken('tok-string', token);
    if (/^\d/.test(token)) return wrapToken('tok-number', token);
    if (/^(const|let|var|function|return|if|else|for|while|switch|case|break|continue|try|catch|throw|new|class|extends|async|await|import|from|export|default|public|private|protected|static|interface|type|implements|null|true|false)$/.test(token)) {
      return wrapToken('tok-keyword', token);
    }
    if (/^[A-Za-z_$][\w$]*$/.test(token)) return wrapToken('tok-function', token);
    if (/^[=+\-*/<>!&|%]+$/.test(token)) return wrapToken('tok-operator', token);
    return wrapToken('tok-punctuation', token);
  });
}

function highlightMarkup(code: string): string {
  const tokenRe = /<!--[\s\S]*?-->|<\/?[A-Za-z][A-Za-z0-9-]*|[A-Za-z-:]+(?==)|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/?>/g;

  return highlightByRegex(code, tokenRe, (token) => {
    if (token.startsWith('<!--')) return wrapToken('tok-comment', token);
    if (/^<\/?[A-Za-z]/.test(token)) return wrapToken('tok-tag', token);
    if (/^[A-Za-z-:]+$/.test(token)) return wrapToken('tok-attr', token);
    if (/^["']/.test(token)) return wrapToken('tok-string', token);
    return wrapToken('tok-punctuation', token);
  });
}

function highlightByRegex(code: string, tokenRe: RegExp, render: (token: string) => string): string {
  let result = '';
  let lastIndex = 0;

  for (const match of code.matchAll(tokenRe)) {
    const index = match.index ?? 0;
    const token = match[0];
    result += escapeHtml(code.slice(lastIndex, index));
    result += render(token);
    lastIndex = index + token.length;
  }

  result += escapeHtml(code.slice(lastIndex));
  return result;
}

function wrapToken(className: string, token: string): string {
  return `<span class="${className}">${escapeHtml(token)}</span>`;
}

function isMarkupLanguage(language: string | null): boolean {
  return language === 'html' || language === 'xml' || language === 'svg';
}

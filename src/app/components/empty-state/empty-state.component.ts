import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output, computed } from '@angular/core';

@Component({
  selector: 'app-empty-state',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './empty-state.component.html',
  styleUrl: './empty-state.component.scss',
})
export class EmptyStateComponent {
  @Input() name = '';
  /** Active project name, or null for personal context. */
  @Input() projectName: string | null = null;
  @Input() projectFileCount = 0;
  @Output() useSuggestion = new EventEmitter<string>();

  readonly contextLabel = () =>
    this.projectName ? `In project · ${this.projectName}` : 'New chat';

  readonly suggestions = computed(() =>
    this.projectName ? this.projectSuggestions : this.personalSuggestions,
  );

  private personalSuggestions = [
    {
      title: 'Refactor Express → Fastify',
      sub: 'migrate a route handler',
      prompt: 'Refactor this Express handler to Fastify with zod validation',
    },
    {
      title: 'Session management',
      sub: 'cookies + Redis pattern',
      prompt: 'Explain how cookie-based session management works with Redis',
    },
    {
      title: 'SQL query help',
      sub: 'find duplicates',
      prompt: 'Write a SQL query to find duplicate emails in the users table',
    },
    {
      title: 'Debug an error',
      sub: 'paste a stack trace',
      prompt: 'Debug this TypeError: cannot read properties of undefined',
    },
  ];

  private projectSuggestions = [
    {
      title: 'Summarise this project',
      sub: 'overview of structure and stack',
      prompt: 'Summarise the structure and main responsibilities of the files in this project.',
    },
    {
      title: 'Find TODOs and FIXMEs',
      sub: 'list every outstanding marker',
      prompt: 'Find every TODO, FIXME, and HACK comment across the project and group them by file.',
    },
    {
      title: 'Suggest a small improvement',
      sub: 'one focused refactor',
      prompt:
        'Pick one file in the project and suggest a small, focused refactor that improves clarity or removes duplication. Return the proposed change as a `path:` fenced block.',
    },
    {
      title: 'Explain a file',
      sub: 'walk me through it',
      prompt:
        'Pick the most important file in this project and walk me through what it does, line by line where useful.',
    },
  ];
}

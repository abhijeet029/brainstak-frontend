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
      title: 'Explain pasted code',
      sub: 'paste a file or snippet',
      prompt: 'Explain this code and point out the important flow:\n\n',
    },
    {
      title: 'Debug an error',
      sub: 'paste stack trace + code',
      prompt: 'Debug this issue. I will paste the error and relevant code below:\n\n',
    },
    {
      title: 'Suggest a fix',
      sub: 'copy-paste workflow',
      prompt:
        'Based on this pasted code, suggest what to change and show the corrected version:\n\n',
    },
    {
      title: 'Review a file',
      sub: 'paste file content',
      prompt:
        'Review this file for bugs, risky logic, and easy improvements:\n\n',
    },
  ];
}

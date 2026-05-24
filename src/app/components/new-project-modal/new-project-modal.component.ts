import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Output, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ProjectService } from '../../core/project.service';
import { ToastService } from '../../core/toast.service';
import {
  fsAccessSupported,
  ensureDirectoryWritable,
  getDirectoryPicker,
  readDirectoryHandle,
  type ImportedFile,
} from '../../core/folder-import.util';

declare const bootstrap: { Modal: { getInstance(el: Element): { hide(): void } | null } };

type Step = 'choose' | 'name' | 'permission';
type PendingFlow = 'scratch' | 'folder' | null;
const DUPLICATE_PROJECT_NAME_MESSAGE = 'Another project already exists with the same name!';

@Component({
  selector: 'app-new-project-modal',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './new-project-modal.component.html',
  styleUrl: './new-project-modal.component.scss',
})
export class NewProjectModalComponent {
  /** Emitted with the new project id once import completes. */
  @Output() projectCreated = new EventEmitter<string>();

  private readonly projects = inject(ProjectService);
  private readonly toast = inject(ToastService);

  readonly fsSupported = fsAccessSupported();
  readonly step = signal<Step>('choose');
  readonly error = signal<string | null>(null);
  readonly pendingFlow = signal<PendingFlow>(null);
  readonly isCreating = signal(false);
  projectNameDraft = '';

  reset() {
    this.step.set('choose');
    this.error.set(null);
    this.pendingFlow.set(null);
    this.isCreating.set(false);
    this.projectNameDraft = '';
  }

  back() {
    if (this.step() === 'permission') {
      this.step.set('name');
      return;
    }
    this.step.set('choose');
  }

  onUseExisting() {
    this.error.set(null);
    this.pendingFlow.set('folder');
    this.projectNameDraft = '';
    this.step.set('permission');
  }

  onStartScratch() {
    this.error.set(null);
    this.pendingFlow.set('scratch');
    this.projectNameDraft = this.nextProjectName('New project');
    this.step.set('name');
  }

  onNameContinue() {
    const flow = this.pendingFlow();
    const name = this.projectNameDraft.trim();
    if (!flow || !name || this.isCreating()) return;

    this.error.set(null);
    if (flow === 'folder') {
      this.step.set('permission');
      return;
    }

    this.isCreating.set(true);
    this.projects.createProject(name).subscribe({
      next: ({ project }) => {
        this.dismiss();
        this.reset();
        this.projectCreated.emit(project.id);
      },
      error: (e) => {
        this.isCreating.set(false);
        this.error.set(extractError(e, 'Could not create project'));
      },
    });
  }

  async onPermissionContinue() {
    const pending = this.pendingFlow();
    if (!pending) {
      this.step.set('choose');
      return;
    }
    if (pending !== 'folder') {
      this.step.set('choose');
      return;
    }
    await this.runFlow();
  }

  private async runFlow() {
    this.error.set(null);
    const picker = getDirectoryPicker();
    if (!picker) {
      this.error.set('This browser does not support the File System Access API.');
      return;
    }

    // ── Dismiss the modal BEFORE opening the browser file picker ──────────
    // Chrome's "Allow this site to edit files?" permission dialog is a native
    // browser prompt. If the Bootstrap modal is still open when it fires, both
    // overlays stack on screen and feel like two separate alert boxes.
    // Closing the modal first lets the browser dialogs appear cleanly over the
    // chat, where they make contextual sense.
    this.dismiss();
    this.reset();

    let projectHandle: FileSystemDirectoryHandle;
    let projectName: string;

    try {
      // Ask for edit access immediately so Apply Changes can write later
      // without surprising the user after the project has already been imported.
      projectHandle = await picker({ mode: 'readwrite' });
      projectName = projectHandle.name;
    } catch (e) {
      const name = (e as { name?: string })?.name;
      // User cancelled the folder picker — silent, nothing to report.
      if (name === 'AbortError') return;
      this.toast.show(extractError(e, 'Could not open folder'), 'error');
      return;
    }

    const writable = await ensureDirectoryWritable(projectHandle);
    if (!writable) {
      this.toast.show('Could not get write access to this folder. Please choose a writable local folder and allow edit access.', 'error');
      return;
    }

    if (this.projectNameExists(projectName)) {
      this.toast.show(DUPLICATE_PROJECT_NAME_MESSAGE, 'error');
      return;
    }

    let files: ImportedFile[] = [];
    try {
      files = await readDirectoryHandle(projectHandle);
    } catch (e) {
      this.toast.show(extractError(e, 'Could not read folder contents'), 'error');
      return;
    }

    this.projects.createProject(projectName).subscribe({
      next: ({ project }) => {
        this.projects.bindDirectoryHandle(project.id, projectHandle);
        const finish = () => this.projectCreated.emit(project.id);
        if (files.length) {
          this.projects.importFiles(project.id, files).subscribe({
            next: () => finish(),
            error: (e) => this.toast.show(extractError(e, 'Could not import files'), 'error'),
          });
        } else {
          finish();
        }
      },
      error: (e) => this.toast.show(extractError(e, 'Could not create project'), 'error'),
    });
  }

  private dismiss() {
    const el = document.getElementById('newProjectModal');
    if (el) bootstrap.Modal.getInstance(el)?.hide();
  }

  private nextProjectName(base: string): string {
    const existing = new Set(this.projects.projects().map((project) => project.name.trim().toLowerCase()));
    if (!existing.has(base.toLowerCase())) return base;
    for (let i = 2; i < 1000; i++) {
      const candidate = `${base} ${i}`;
      if (!existing.has(candidate.toLowerCase())) return candidate;
    }
    return `${base} ${Date.now()}`;
  }

  private projectNameExists(name: string): boolean {
    const normalized = name.trim().toLowerCase();
    return this.projects.projects().some((project) => project.name.trim().toLowerCase() === normalized);
  }
}

function extractError(e: unknown, fallback: string): string {
  const code = (e as { error?: { error?: string } })?.error?.error;
  if (code === 'PROJECT_NAME_EXISTS') {
    return DUPLICATE_PROJECT_NAME_MESSAGE;
  }
  return String(
    (e as { error?: { message?: string; error?: string } })?.error?.message ??
    code ??
    (e as { message?: string })?.message ??
    fallback,
  );
}

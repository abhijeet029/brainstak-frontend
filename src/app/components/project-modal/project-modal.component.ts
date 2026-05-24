import { CommonModule } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { FolderConnectionStatus, ProjectService } from '../../core/project.service';
import { ToastService } from '../../core/toast.service';
import { fsAccessSupported } from '../../core/folder-import.util';

@Component({
  selector: 'app-project-modal',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './project-modal.component.html',
  styleUrl: './project-modal.component.scss',
})
export class ProjectModalComponent {
  private readonly projects = inject(ProjectService);
  private readonly toast = inject(ToastService);

  readonly activeProjectId = this.projects.activeProjectId;
  readonly files = this.projects.files;
  readonly selectedFileId = signal<string | null>(null);
  readonly activeProjectName = computed(() => {
    const project = this.projects.projects().find((item) => item.id === this.activeProjectId());
    return project?.name ?? 'Project files';
  });
  readonly connectionStatus = computed<FolderConnectionStatus>(() =>
    this.projects.getConnectionStatus(this.activeProjectId()),
  );
  readonly connectionLabel = computed(() => {
    switch (this.connectionStatus()) {
      case 'connected':
        return 'Folder connected';
      case 'read-only':
        return 'Write access missing';
      default:
        return 'Folder not connected';
    }
  });

  readonly fsSupported = fsAccessSupported();
  readonly isSyncing = signal(false);
  readonly syncResult = signal<string | null>(null);
  readonly renameError = signal<string | null>(null);
  readonly isRenaming = signal(false);

  path = '';
  content = '';
  projectNameDraft = '';

  syncProjectNameDraft() {
    this.projectNameDraft = this.activeProjectName();
    this.renameError.set(null);
  }

  onRenameProject() {
    const projectId = this.activeProjectId();
    const name = this.projectNameDraft.trim();
    if (!projectId || !name) return;
    if (name === this.activeProjectName()) return;

    this.isRenaming.set(true);
    this.renameError.set(null);
    this.projects.renameProject(projectId, name).subscribe({
      next: (res) => {
        this.projectNameDraft = res.project.name;
        this.isRenaming.set(false);
        this.toast.show('Project renamed.', 'success');
      },
      error: (e) => {
        this.renameError.set(extractApiError(e, 'Could not rename project'));
        this.isRenaming.set(false);
      },
    });
  }

  selectFile(fileId: string) {
    this.selectedFileId.set(fileId);
    const file = this.files().find((item) => item.id === fileId);
    this.path = file?.path ?? '';
    this.content = file?.content ?? '';
  }

  resetForm() {
    this.selectedFileId.set(null);
    this.path = '';
    this.content = '';
  }

  onSave() {
    const projectId = this.activeProjectId();
    if (!projectId || !this.path.trim()) return;
    this.projects.saveFile(projectId, { path: this.path, content: this.content }).subscribe({
      next: (res) => {
        this.projects.syncFilesToBoundDirectory(projectId, [res.file.path]);
        this.selectFile(res.file.id);
      },
      error: (e) => this.toast.show(extractApiError(e, 'Could not save file'), 'error'),
    });
  }

  onReconnectFolder() {
    const projectId = this.activeProjectId();
    if (!projectId) return;
    this.projects.reconnectProjectFolder(projectId).then((connected) => {
      this.syncResult.set(connected ? 'Folder connected for local writeback.' : 'Folder connection was not granted.');
    });
  }

  async onResyncFromFolder() {
    const projectId = this.activeProjectId();
    if (!projectId) return;

    this.isSyncing.set(true);
    this.syncResult.set(null);

    try {
      const result = await this.projects.resyncFromBoundFolder(projectId);
      if (result === null) {
        // User cancelled the picker — don't show an error
        this.syncResult.set(null);
        return;
      }
      const msg = `Re-synced ${result.upserted} file${result.upserted === 1 ? '' : 's'}${result.deleted ? `, removed ${result.deleted} stale` : ''}.`;
      this.syncResult.set(msg);
    } catch (e) {
      const msg = extractApiError(e, 'Could not re-sync folder');
      this.toast.show(msg, 'error');
      this.syncResult.set(msg);
    } finally {
      this.isSyncing.set(false);
    }
  }

  onDelete() {
    const projectId = this.activeProjectId();
    const fileId = this.selectedFileId();
    if (!projectId || !fileId) return;
    this.projects.deleteFile(projectId, fileId).subscribe(() => this.resetForm());
  }
}

function extractApiError(error: unknown, fallback: string) {
  const code = (error as { error?: { error?: string } })?.error?.error;
  if (code === 'PROJECT_NAME_EXISTS') {
    return 'Another project already exists with the same name!';
  }
  return (
    (error as { error?: { message?: string; error?: string } })?.error?.message ??
    code ??
    (error as { message?: string })?.message ??
    fallback
  );
}

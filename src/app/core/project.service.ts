import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom, tap } from 'rxjs';
import { environment } from '../../environments/environment';
import { Project, ProjectFile, ProposedChange } from './models';
import { ensureDirectoryWritable, readDirectoryHandle } from './folder-import.util';
import { PROJECT_FILE_APPLY_ENABLED } from './feature-flags';

type DirectoryHandle = FileSystemDirectoryHandle;
export type FolderConnectionStatus = 'disconnected' | 'read-only' | 'connected';

export interface PendingPermissionRequest {
  projectId: string;
  projectName: string;
  pendingFiles: Array<{ path: string; content: string }>;
}

@Injectable({ providedIn: 'root' })
export class ProjectService {
  private http = inject(HttpClient);
  private base = environment.apiUrl + '/v1';
  private readonly directoryHandles = new Map<string, DirectoryHandle>();
  private readonly folderStatuses = signal<Record<string, FolderConnectionStatus>>({});

  readonly projects = signal<Project[]>([]);
  readonly activeProjectId = signal<string | null>(null);
  readonly files = signal<ProjectFile[]>([]);
  readonly connectionStatuses = this.folderStatuses.asReadonly();
  /** Non-null when Hub needs the user to grant write access before applying file changes. */
  readonly pendingPermissionRequest = signal<PendingPermissionRequest | null>(null);

  /**
   * Maps `path` → most recent snapshot id for that file, so the per-file Undo
   * button in the message component can call the revert endpoint.
   * Cleared whenever the user navigates away from the chat.
   */
  readonly recentSnapshotByPath = signal<Record<string, string>>({});

  loadProjects() {
    return this.http
      .get<{ projects: Project[] }>(`${this.base}/projects`)
      .pipe(tap((res) => this.projects.set(res.projects)));
  }

  createProject(name: string, description?: string) {
    return this.http
      .post<{ project: Project }>(`${this.base}/projects`, { name, description })
      .pipe(
        tap((res) => {
          this.projects.set([res.project, ...this.projects()]);
          this.activeProjectId.set(res.project.id);
          this.files.set([]);
        }),
      );
  }

  renameProject(projectId: string, name: string) {
    return this.http
      .patch<{ project: Project }>(`${this.base}/projects/${projectId}`, { name })
      .pipe(
        tap((res) => {
          this.projects.set(this.projects().map((project) =>
            project.id === projectId ? res.project : project,
          ));
        }),
      );
  }

  deleteProject(projectId: string) {
    return this.http
      .delete<{ ok: true }>(`${this.base}/projects/${projectId}`)
      .pipe(
        tap(() => {
          this.projects.set(this.projects().filter((project) => project.id !== projectId));
          this.directoryHandles.delete(projectId);
          this.folderStatuses.update((current) => {
            const next = { ...current };
            delete next[projectId];
            return next;
          });
          if (this.activeProjectId() === projectId) {
            this.activeProjectId.set(null);
            this.files.set([]);
          }
        }),
      );
  }

  archiveProjectChats(projectId: string) {
    return this.http
      .post<{ ok: true }>(`${this.base}/projects/${projectId}/chats/archive`, {})
      .pipe(tap(() => undefined));
  }

  bindDirectoryHandle(projectId: string, handle: DirectoryHandle) {
    this.directoryHandles.set(projectId, handle);
    this.setFolderStatus(projectId, 'connected');
  }

  hasBoundDirectory(projectId: string) {
    return this.directoryHandles.has(projectId);
  }

  getConnectionStatus(projectId: string | null | undefined): FolderConnectionStatus {
    if (!projectId) return 'disconnected';
    return this.folderStatuses()[projectId] ?? 'disconnected';
  }

  importFiles(
    projectId: string,
    files: Array<{ path: string; content: string; language?: string }>,
  ) {
    return this.http
      .post<{ imported: number; files: Array<{ id: string; path: string }> }>(
        `${this.base}/projects/${projectId}/import`,
        { files },
      )
      .pipe(tap(() => this.loadFiles(projectId).subscribe()));
  }

  selectProject(projectId: string | null) {
    this.activeProjectId.set(projectId);
    if (!projectId) {
      this.files.set([]);
      return;
    }
    void this.refreshConnectionStatus(projectId);
    this.loadFiles(projectId).subscribe();
  }

  loadFiles(projectId: string) {
    return this.http
      .get<{ files: ProjectFile[] }>(`${this.base}/projects/${projectId}/files`)
      .pipe(tap((res) => this.files.set(res.files)));
  }

  saveFile(projectId: string, input: { path: string; content: string; language?: string }) {
    return this.http
      .put<{ file: ProjectFile }>(`${this.base}/projects/${projectId}/files`, input)
      .pipe(
        tap((res) => {
          const rest = this.files().filter((file) => file.id !== res.file.id && file.path !== res.file.path);
          this.files.set([...rest, res.file].sort((a, b) => a.path.localeCompare(b.path)));
        }),
      );
  }

  scanProject(projectId: string, folderPath: string) {
    return this.http
      .post<{ rootPath: string; imported: number; skipped: number; files: string[] }>(
        `${this.base}/projects/${projectId}/scan`,
        { folderPath },
      )
      .pipe(tap(() => this.loadFiles(projectId).subscribe()));
  }

  resync(
    projectId: string,
    files: Array<{ path: string; content: string; language?: string }>,
    deleteOthers = true,
  ) {
    return this.http
      .post<{ upserted: number; deleted: number }>(
        `${this.base}/projects/${projectId}/resync`,
        { files, deleteOthers },
      )
      .pipe(tap(() => this.loadFiles(projectId).subscribe()));
  }

  /**
   * Try to apply proposed file changes to the bound local folder.
   * - Returns 'applied' when files were written successfully.
   * - Returns 'permission_needed' and raises `pendingPermissionRequest` when
   *   the folder is not connected or lacks write access. The chat will render
   *   an inline permission card; the user clicks "Allow" which calls
   *   `grantPermissionAndApply()`.
   * - Returns 'no_project' when there is no bound project.
   */
  async applyProposedChanges(
    projectId: string,
    projectName: string,
    changes: ProposedChange[],
  ): Promise<'applied' | 'permission_needed' | 'no_project' | 'disabled'> {
    if (!PROJECT_FILE_APPLY_ENABLED) {
      this.pendingPermissionRequest.set(null);
      return 'disabled';
    }

    const files = changes.map((c) => ({ path: c.path, content: c.content }));
    const handle = this.directoryHandles.get(projectId);

    if (!handle) {
      this.pendingPermissionRequest.set({ projectId, projectName, pendingFiles: files });
      return 'permission_needed';
    }

    // Use ensureWritePermission (not just hasWritePermission) so that if the
    // browser's permission state dropped to 'prompt' after the first grant,
    // it silently re-prompts via the native browser dialog rather than
    // showing our custom permission card again. We only show the card when
    // the user actively denies the native prompt or the API is unavailable.
    const hasPermission = await ensureWritePermission(handle);
    if (!hasPermission) {
      this.pendingPermissionRequest.set({ projectId, projectName, pendingFiles: files });
      return 'permission_needed';
    }

    await this.syncProvidedFilesToBoundDirectory(projectId, files);
    return 'applied';
  }

  /**
   * Called when the user clicks "Allow folder access" in the inline
   * permission card. Opens the directory picker, stores the handle, and
   * writes any pending files once access is granted.
   */
  async grantPermissionAndApply(): Promise<boolean> {
    const req = this.pendingPermissionRequest();
    if (!req) return false;

    const granted = await this.reconnectProjectFolder(req.projectId);
    this.pendingPermissionRequest.set(null);
    if (granted && req.pendingFiles.length) {
      await this.syncProvidedFilesToBoundDirectory(req.projectId, req.pendingFiles);
    }
    return granted;
  }

  /** Dismiss the inline permission card without taking action. */
  dismissPermissionRequest(): void {
    this.pendingPermissionRequest.set(null);
  }

  /**
   * Re-read the bound FileSystemDirectoryHandle (or open a new picker) and
   * push all current files to the /resync endpoint. Stale files are removed.
   * Returns a result object or null if the user cancels the folder picker.
   */
  async resyncFromBoundFolder(projectId: string): Promise<{ upserted: number; deleted: number } | null> {
    let handle = this.directoryHandles.get(projectId);

    if (!handle) {
      const success = await this.reconnectProjectFolder(projectId);
      if (!success) return null;
      handle = this.directoryHandles.get(projectId);
      if (!handle) return null;
    }

    const files = await readDirectoryHandle(handle);
    return firstValueFrom(this.resync(projectId, files, true));
  }

  deleteFile(projectId: string, fileId: string) {
    return this.http
      .delete(`${this.base}/projects/${projectId}/files/${fileId}`)
      .pipe(tap(() => this.files.set(this.files().filter((file) => file.id !== fileId))));
  }

  async syncFilesToBoundDirectory(projectId: string, paths?: string[]) {
    if (!PROJECT_FILE_APPLY_ENABLED) return;

    const root = this.directoryHandles.get(projectId);
    if (!root) return;
    const permission = await ensureWritePermission(root);
    this.setFolderStatus(projectId, permission ? 'connected' : 'read-only');
    if (!permission) return;

    const selected = paths?.length
      ? this.files().filter((file) => paths.includes(file.path))
      : this.files();

    for (const file of selected) {
      await writeFile(root, file.path, file.content);
    }
  }

  async syncProvidedFilesToBoundDirectory(
    projectId: string,
    files: Array<{ path: string; content: string }>,
  ) {
    if (!PROJECT_FILE_APPLY_ENABLED) return;

    const root = this.directoryHandles.get(projectId);
    if (!root || !files.length) return;
    const permission = await ensureWritePermission(root);
    this.setFolderStatus(projectId, permission ? 'connected' : 'read-only');
    if (!permission) return;

    for (const file of files) {
      await writeFile(root, file.path, file.content);
    }

    // Backend Apply endpoint: snapshots each file's previous content for
    // rollback, writes the new content, re-indexes for RAG, and returns
    // the snapshot ids the UI can use to wire up per-file Undo buttons.
    try {
      const res = await firstValueFrom(
        this.http.post<{ applied: Array<{ path: string; snapshotId: string; isNewFile: boolean }> }>(
          `${this.base}/projects/${projectId}/apply`,
          { files },
        ),
      );
      // Stash snapshot ids by path so the per-file Undo button can find them.
      this.recentSnapshotByPath.update((current) => {
        const next = { ...current };
        for (const a of res.applied) next[a.path] = a.snapshotId;
        return next;
      });
      // Refresh the files signal so Sources reflects the new state.
      this.loadFiles(projectId).subscribe();
    } catch {
      // Backend recording failure is non-fatal — files are already written to disk.
    }
  }

  /**
   * Revert a single AI-applied file change. Calls the backend revert endpoint
   * (which restores the previous DB content) and also writes the previous
   * content back to the user's local folder via the FileSystem API.
   */
  async revertSnapshot(projectId: string, snapshotId: string): Promise<{ filePath: string; isFileDeletion: boolean } | null> {
    try {
      const res = await firstValueFrom(
        this.http.post<{ reverted: { filePath: string; restoredContent: string; isFileDeletion: boolean } }>(
          `${this.base}/projects/${projectId}/snapshots/revert`,
          { snapshotId },
        ),
      );

      const { filePath, restoredContent, isFileDeletion } = res.reverted;
      const root = this.directoryHandles.get(projectId);

      if (root && (await ensureWritePermission(root))) {
        if (isFileDeletion) {
          await deleteFile(root, filePath).catch(() => undefined);
        } else {
          await writeFile(root, filePath, restoredContent).catch(() => undefined);
        }
      }

      // Drop the snapshot id from the recent map — undo is no longer applicable
      this.recentSnapshotByPath.update((current) => {
        const next = { ...current };
        delete next[filePath];
        return next;
      });
      this.loadFiles(projectId).subscribe();

      return { filePath, isFileDeletion };
    } catch {
      return null;
    }
  }

  async reconnectProjectFolder(projectId: string) {
    const picker = getDirectoryPicker();
    if (!picker) return false;
    try {
      const handle = await picker({ mode: 'readwrite' });
      const permission = await ensureDirectoryWritable(handle);
      if (permission) this.bindDirectoryHandle(projectId, handle);
      else this.directoryHandles.set(projectId, handle);
      this.setFolderStatus(projectId, permission ? 'connected' : 'read-only');
      return permission;
    } catch {
      return false;
    }
  }

  async refreshConnectionStatus(projectId: string) {
    const handle = this.directoryHandles.get(projectId);
    if (!handle) {
      this.setFolderStatus(projectId, 'disconnected');
      return 'disconnected';
    }
    const granted = await hasWritePermission(handle);
    const status: FolderConnectionStatus = granted ? 'connected' : 'read-only';
    this.setFolderStatus(projectId, status);
    return status;
  }

  private setFolderStatus(projectId: string, status: FolderConnectionStatus) {
    this.folderStatuses.update((current) => ({ ...current, [projectId]: status }));
  }
}

/**
 * Delete a file from the bound directory tree. Best-effort — silently no-ops
 * if the file doesn't exist (already deleted) or the path traverses out of root.
 */
async function deleteFile(root: DirectoryHandle, filePath: string): Promise<void> {
  const parts = filePath.split('/').filter(Boolean);
  if (!parts.length) return;
  let directory = root;
  for (const segment of parts.slice(0, -1)) {
    try {
      directory = await directory.getDirectoryHandle(segment, { create: false });
    } catch {
      return; // parent dir doesn't exist → file already gone
    }
  }
  const fileName = parts[parts.length - 1]!;
  try {
    await (directory as DirectoryHandle & { removeEntry(name: string): Promise<void> }).removeEntry(fileName);
  } catch {
    // File might not exist or browser doesn't support removeEntry → skip
  }
}

async function writeFile(root: DirectoryHandle, filePath: string, content: string) {
  const parts = filePath.split('/').filter(Boolean);
  if (!parts.length) return;

  let directory = root;
  for (const segment of parts.slice(0, -1)) {
    directory = await directory.getDirectoryHandle(segment, { create: true });
  }

  const handle = await directory.getFileHandle(parts[parts.length - 1]!, { create: true });
  const writable = await handle.createWritable();
  await writable.write(content);
  await writable.close();
}

async function hasWritePermission(handle: DirectoryHandle) {
  const permission = await getPermissionApi(handle)
    ?.queryPermission?.({ mode: 'readwrite' })
    .catch(() => 'prompt');
  return permission === 'granted';
}

async function ensureWritePermission(handle: DirectoryHandle) {
  if (await hasWritePermission(handle)) return true;
  const permission = await getPermissionApi(handle)
    ?.requestPermission?.({ mode: 'readwrite' })
    .catch(() => 'denied');
  return permission === 'granted';
}

type DirectoryPicker = (options?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;

function getDirectoryPicker(): DirectoryPicker | null {
  const withPicker = window as typeof window & { showDirectoryPicker?: DirectoryPicker };
  return withPicker.showDirectoryPicker ?? null;
}

function getPermissionApi(handle: DirectoryHandle) {
  return handle as DirectoryHandle & {
    queryPermission?: (descriptor: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>;
    requestPermission?: (descriptor: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>;
  };
}

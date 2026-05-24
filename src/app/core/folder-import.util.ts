/**
 * File System Access API helpers shared by the new-project flow and any
 * other future folder-bound features.
 */

export type DirectoryPicker = (
  options?: { mode?: 'read' | 'readwrite' },
) => Promise<FileSystemDirectoryHandle>;

export interface ImportedFile {
  path: string;
  content: string;
  language?: string;
}

export function getDirectoryPicker(): DirectoryPicker | null {
  const w = window as typeof window & { showDirectoryPicker?: DirectoryPicker };
  return w.showDirectoryPicker ?? null;
}

export function fsAccessSupported(): boolean {
  return getDirectoryPicker() !== null;
}

export async function ensureDirectoryWritable(root: FileSystemDirectoryHandle): Promise<boolean> {
  const permission = await getPermissionApi(root)
    ?.queryPermission?.({ mode: 'readwrite' })
    .catch(() => 'prompt');
  const granted = permission === 'granted'
    ? true
    : await getPermissionApi(root)
        ?.requestPermission?.({ mode: 'readwrite' })
        .then((state) => state === 'granted')
        .catch(() => false);

  if (!granted) return false;
  return probeWritable(root);
}

const IGNORED_DIRS = new Set([
  '.git',
  '.angular',
  '.next',
  '.nuxt',
  '.turbo',
  '.vscode',
  '.idea',
  'coverage',
  'dist',
  'build',
  'node_modules',
  'vendor',
]);

const ALLOWED_EXT = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'md', 'mdx',
  'html', 'css', 'scss', 'sass', 'less',
  'yml', 'yaml', 'toml', 'ini', 'sh', 'bash', 'zsh',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift',
  'sql', 'graphql', 'gql', 'txt', 'xml', 'svg',
  'vue', 'svelte', 'php', 'c', 'h', 'cpp', 'hpp', 'cs',
]);

const MAX_FILES = 1000;
const MAX_FILE_BYTES = 200_000;

export async function readDirectoryHandle(
  root: FileSystemDirectoryHandle,
): Promise<ImportedFile[]> {
  const imported: ImportedFile[] = [];

  async function walk(directory: FileSystemDirectoryHandle, prefix = ''): Promise<void> {
    try {
      for await (const [name, handle] of iterateDirectory(directory)) {
        if (imported.length >= MAX_FILES) return;
        try {
          if (handle.kind === 'directory') {
            if (IGNORED_DIRS.has(name)) continue;
            await walk(handle as FileSystemDirectoryHandle, prefix ? `${prefix}/${name}` : name);
            continue;
          }
          if (!shouldImportFile(name)) continue;
          const file = await (handle as FileSystemHandle & { getFile(): Promise<File> }).getFile();
          if (file.size > MAX_FILE_BYTES) continue;
          const content = await file.text().catch(() => '');
          if (!content) continue;
          const relativePath = prefix ? `${prefix}/${name}` : name;
          imported.push({ path: relativePath, content, language: detectLanguage(relativePath) });
        } catch {
          // Some folders contain cloud placeholder files, locked files, or
          // filesystem-managed entries that the browser exposes but cannot
          // actually read. Skip those entries and keep importing the rest.
          continue;
        }
      }
    } catch {
      // If an entire subdirectory cannot be enumerated, ignore just that
      // subtree. A single protected folder should not block project import.
    }
  }

  await walk(root);
  return imported;
}

function iterateDirectory(directory: FileSystemDirectoryHandle) {
  return (
    directory as FileSystemDirectoryHandle & {
      entries(): AsyncIterable<
        [string, FileSystemDirectoryHandle | (FileSystemHandle & { getFile(): Promise<File> })]
      >;
    }
  ).entries();
}

async function probeWritable(root: FileSystemDirectoryHandle): Promise<boolean> {
  const name = `.hub-write-test-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
  try {
    const handle = await root.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write('ok');
    await writable.close();
    await root.removeEntry(name).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

function getPermissionApi(handle: FileSystemDirectoryHandle) {
  return handle as FileSystemDirectoryHandle & {
    queryPermission?: (descriptor: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>;
    requestPermission?: (descriptor: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>;
  };
}

function shouldImportFile(fileName: string): boolean {
  if (fileName.startsWith('.env')) return true;
  const ext = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : '';
  return ALLOWED_EXT.has(ext);
}

function detectLanguage(path: string): string | undefined {
  const ext = path.split('.').pop()?.toLowerCase();
  return ext || undefined;
}

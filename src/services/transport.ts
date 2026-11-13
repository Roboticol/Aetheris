import {
  AgentMode,
  AgentPatch,
  FileNode,
  RecentWorkspace,
  SearchHit,
  TerminalEntry,
  ThinkingMode,
  WorkspaceSource,
  WorkspaceSummary,
} from '../types/ide';

interface TauriInternals {
  invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: TauriInternals;
    showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
  }
}

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__?.invoke);
}

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!window.__TAURI_INTERNALS__?.invoke) {
    throw new Error('Tauri IPC is not available in browser mode');
  }
  return window.__TAURI_INTERNALS__.invoke<T>(cmd, args);
}

const SKIP_DIRS = new Set(['node_modules', 'target', '.git', 'dist', '.next', '.turbo']);

const SYMBOL_REGEX =
  /^\s*(?:pub\s+)?(?:async\s+)?(?:export\s+)?(?:default\s+)?(fn|struct|enum|trait|impl|function|class|interface|type|const|def)\s+([A-Za-z_][A-Za-z0-9_]*)/;

async function walkLocalDir(
  dirHandle: FileSystemDirectoryHandle,
  prefix = '',
  depth = 0
): Promise<FileNode[]> {
  if (depth > 8) return [];
  const dirs: FileNode[] = [];
  const files: FileNode[] = [];

  for await (const [name, handle] of (dirHandle as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
    if (SKIP_DIRS.has(name) || (name.startsWith('.') && name !== '.env.example' && name !== '.gitignore')) {
      continue;
    }
    const relPath = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === 'directory') {
      const children = await walkLocalDir(handle as FileSystemDirectoryHandle, relPath, depth + 1);
      dirs.push({ name, path: relPath, kind: 'dir', children });
    } else {
      files.push({ name, path: relPath, kind: 'file' });
    }
  }

  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  return [...dirs, ...files];
}

async function resolveLocalFileHandle(
  root: FileSystemDirectoryHandle,
  relPath: string,
  create = false
): Promise<FileSystemFileHandle> {
  const parts = relPath.split('/').filter(Boolean);
  if (parts.length === 0) throw new Error('Invalid file path');
  let curr = root;
  for (let i = 0; i < parts.length - 1; i++) {
    curr = await curr.getDirectoryHandle(parts[i], { create });
  }
  return curr.getFileHandle(parts[parts.length - 1], { create });
}

async function resolveLocalParentDir(
  root: FileSystemDirectoryHandle,
  relPath: string,
  create = false
): Promise<{ parent: FileSystemDirectoryHandle; name: string }> {
  const parts = relPath.split('/').filter(Boolean);
  if (parts.length === 0) throw new Error('Invalid path');
  let curr = root;
  for (let i = 0; i < parts.length - 1; i++) {
    curr = await curr.getDirectoryHandle(parts[i], { create });
  }
  return { parent: curr, name: parts[parts.length - 1] };
}

export interface ActiveWorkspaceContext {
  source: WorkspaceSource;
  id: string;
  name: string;
  nativeRoot?: string;
  localDirHandle?: FileSystemDirectoryHandle;
}

export async function listStarterWorkspaces(): Promise<WorkspaceSummary[]> {
  if (isTauriRuntime()) {
    return [];
  }
  if (
    typeof window !== 'undefined' &&
    window.location.protocol !== 'http:' &&
    window.location.protocol !== 'https:'
  ) {
    return [];
  }
  try {
    const res = await fetch('/api/workspaces');
    if (!res.ok) return [];
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) return [];
    const data = (await res.json()) as { workspaces?: WorkspaceSummary[] };
    return Array.isArray(data.workspaces) ? data.workspaces : [];
  } catch {
    return [];
  }
}

export async function fetchWorkspaceTree(ctx: ActiveWorkspaceContext): Promise<FileNode[]> {
  if (ctx.source === 'tauri-native' && ctx.nativeRoot) {
    return tauriInvoke<FileNode[]>('list_workspace_tree', { root: ctx.nativeRoot });
  }
  if (ctx.source === 'local-fs' && ctx.localDirHandle) {
    return walkLocalDir(ctx.localDirHandle);
  }
  const res = await fetch(`/api/workspaces/${encodeURIComponent(ctx.id)}/tree`);
  const data = (await res.json()) as { tree?: FileNode[]; error?: string };
  if (!res.ok) throw new Error(data.error ?? 'Failed to fetch workspace tree');
  return data.tree ?? [];
}

export async function readWorkspaceFile(ctx: ActiveWorkspaceContext, relPath: string): Promise<string> {
  if (ctx.source === 'tauri-native' && ctx.nativeRoot) {
    return tauriInvoke<string>('read_workspace_file', { root: ctx.nativeRoot, relPath });
  }
  if (ctx.source === 'local-fs' && ctx.localDirHandle) {
    const handle = await resolveLocalFileHandle(ctx.localDirHandle, relPath, false);
    const file = await handle.getFile();
    return file.text();
  }
  const res = await fetch(
    `/api/workspaces/${encodeURIComponent(ctx.id)}/file?path=${encodeURIComponent(relPath)}`
  );
  const data = (await res.json()) as { content?: string; error?: string };
  if (!res.ok) throw new Error(data.error ?? `Failed to read ${relPath}`);
  return data.content ?? '';
}

export async function writeWorkspaceFile(
  ctx: ActiveWorkspaceContext,
  relPath: string,
  content: string
): Promise<void> {
  if (ctx.source === 'tauri-native' && ctx.nativeRoot) {
    await tauriInvoke('write_workspace_file', { root: ctx.nativeRoot, relPath, content });
    return;
  }
  if (ctx.source === 'local-fs' && ctx.localDirHandle) {
    const handle = await resolveLocalFileHandle(ctx.localDirHandle, relPath, true);
    const writable = await handle.createWritable();
    await writable.write(content);
    await writable.close();
    return;
  }
  const res = await fetch(`/api/workspaces/${encodeURIComponent(ctx.id)}/file`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: relPath, content }),
  });
  if (!res.ok) {
    const data = (await res.json()) as { error?: string };
    throw new Error(data.error ?? 'Failed to save file');
  }
}

export async function createWorkspaceEntry(
  ctx: ActiveWorkspaceContext,
  relPath: string,
  kind: 'file' | 'dir'
): Promise<void> {
  if (ctx.source === 'tauri-native' && ctx.nativeRoot) {
    await tauriInvoke('create_workspace_entry', { root: ctx.nativeRoot, relPath, kind });
    return;
  }
  if (ctx.source === 'local-fs' && ctx.localDirHandle) {
    if (kind === 'dir') {
      const parts = relPath.split('/').filter(Boolean);
      let curr = ctx.localDirHandle;
      for (const part of parts) {
        curr = await curr.getDirectoryHandle(part, { create: true });
      }
    } else {
      const handle = await resolveLocalFileHandle(ctx.localDirHandle, relPath, true);
      const writable = await handle.createWritable();
      await writable.write('');
      await writable.close();
    }
    return;
  }
  const res = await fetch(`/api/workspaces/${encodeURIComponent(ctx.id)}/entry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: relPath, kind }),
  });
  if (!res.ok) {
    const data = (await res.json()) as { error?: string };
    throw new Error(data.error ?? 'Failed to create entry');
  }
}

export async function renameWorkspaceEntry(
  ctx: ActiveWorkspaceContext,
  oldPath: string,
  newPath: string
): Promise<void> {
  if (ctx.source === 'tauri-native' && ctx.nativeRoot) {
    await tauriInvoke('rename_workspace_entry', { root: ctx.nativeRoot, oldPath, newPath });
    return;
  }
  if (ctx.source === 'local-fs' && ctx.localDirHandle) {
    const content = await readWorkspaceFile(ctx, oldPath);
    await writeWorkspaceFile(ctx, newPath, content);
    await deleteWorkspaceEntry(ctx, oldPath);
    return;
  }
  const res = await fetch(`/api/workspaces/${encodeURIComponent(ctx.id)}/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ oldPath, newPath }),
  });
  if (!res.ok) {
    const data = (await res.json()) as { error?: string };
    throw new Error(data.error ?? 'Failed to rename entry');
  }
}

export async function deleteWorkspaceEntry(
  ctx: ActiveWorkspaceContext,
  relPath: string
): Promise<void> {
  if (ctx.source === 'tauri-native' && ctx.nativeRoot) {
    await tauriInvoke('delete_workspace_entry', { root: ctx.nativeRoot, relPath });
    return;
  }
  if (ctx.source === 'local-fs' && ctx.localDirHandle) {
    const { parent, name } = await resolveLocalParentDir(ctx.localDirHandle, relPath, false);
    await parent.removeEntry(name, { recursive: true });
    return;
  }
  const res = await fetch(
    `/api/workspaces/${encodeURIComponent(ctx.id)}/entry?path=${encodeURIComponent(relPath)}`,
    { method: 'DELETE' }
  );
  if (!res.ok) {
    const data = (await res.json()) as { error?: string };
    throw new Error(data.error ?? 'Failed to delete entry');
  }
}

export async function resetStarterWorkspace(id: string): Promise<FileNode[]> {
  const res = await fetch(`/api/workspaces/${encodeURIComponent(id)}/reset`, {
    method: 'POST',
  });
  const data = (await res.json()) as { tree?: FileNode[]; error?: string };
  if (!res.ok) throw new Error(data.error ?? 'Failed to reset workspace');
  return data.tree ?? [];
}

export function flattenFilePaths(nodes: FileNode[]): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.kind === 'file') {
      paths.push(node.path);
    } else if (node.children) {
      paths.push(...flattenFilePaths(node.children));
    }
  }
  return paths;
}

export async function searchWorkspace(
  ctx: ActiveWorkspaceContext,
  query: string,
  symbolsOnly: boolean,
  tree: FileNode[]
): Promise<SearchHit[]> {
  if (ctx.source === 'tauri-native' && ctx.nativeRoot) {
    return tauriInvoke<SearchHit[]>('search_workspace', {
      root: ctx.nativeRoot,
      query,
      symbolsOnly,
    });
  }
  if (ctx.source === 'local-fs' && ctx.localDirHandle) {
    const allPaths = flattenFilePaths(tree).slice(0, 120);
    const qLower = query.trim().toLowerCase();
    const hits: SearchHit[] = [];

    for (const filePath of allPaths) {
      if (hits.length >= 150) break;
      try {
        const text = await readWorkspaceFile(ctx, filePath);
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (hits.length >= 150) break;
          const lineText = lines[i];
          const match = SYMBOL_REGEX.exec(lineText);
          if (match) {
            const [, kind, name] = match;
            if (!qLower || name.toLowerCase().includes(qLower) || lineText.toLowerCase().includes(qLower)) {
              hits.push({
                filePath,
                line: i + 1,
                preview: lineText.trim().slice(0, 140),
                symbolKind: kind,
                symbolName: name,
              });
            }
          } else if (!symbolsOnly && qLower && lineText.toLowerCase().includes(qLower)) {
            hits.push({
              filePath,
              line: i + 1,
              preview: lineText.trim().slice(0, 140),
              symbolKind: null,
              symbolName: null,
            });
          }
        }
      } catch {
        // Skip unreadable binary files
      }
    }
    return hits;
  }

  const res = await fetch(
    `/api/workspaces/${encodeURIComponent(ctx.id)}/search?q=${encodeURIComponent(query)}&symbolsOnly=${String(symbolsOnly)}`
  );
  const data = (await res.json()) as { hits?: SearchHit[]; error?: string };
  if (!res.ok) throw new Error(data.error ?? 'Search failed');
  return data.hits ?? [];
}

export async function execWorkspaceCommand(
  ctx: ActiveWorkspaceContext,
  command: string,
  tree: FileNode[]
): Promise<Omit<TerminalEntry, 'id' | 'timestamp'>> {
  if (ctx.source === 'tauri-native' && ctx.nativeRoot) {
    const out = await tauriInvoke<{ stdout: string; stderr: string; exitCode: number }>(
      'exec_terminal_command',
      { root: ctx.nativeRoot, command }
    );
    return {
      command,
      stdout: out.stdout,
      stderr: out.stderr,
      exitCode: out.exitCode,
      cwd: ctx.nativeRoot,
    };
  }

  if (ctx.source === 'local-fs') {
    const trimmed = command.trim();
    if (trimmed === 'pwd') {
      return { command, stdout: `${ctx.name}\n`, stderr: '', exitCode: 0, cwd: ctx.name };
    }
    if (trimmed === 'ls' || trimmed.startsWith('ls ')) {
      const listing = tree.map((n) => (n.kind === 'dir' ? `${n.name}/` : n.name)).join('  ');
      return { command, stdout: `${listing}\n`, stderr: '', exitCode: 0, cwd: ctx.name };
    }
    return {
      command,
      stdout: '',
      stderr:
        'Browser security isolates local folder handles from OS shell spawning. Use the Native Rust/Tauri build on Linux/Windows for full PTY shell execution on local folders, or switch to a starter workspace to run live commands here.',
      exitCode: 1,
      cwd: ctx.name,
    };
  }

  const res = await fetch(`/api/workspaces/${encodeURIComponent(ctx.id)}/terminal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command }),
  });
  const data = (await res.json()) as {
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    error?: string;
  };
  if (!res.ok) {
    throw new Error(data.error ?? 'Terminal command failed');
  }
  return {
    command,
    stdout: data.stdout ?? '',
    stderr: data.stderr ?? '',
    exitCode: data.exitCode ?? 0,
    cwd: `~/${ctx.name}`,
  };
}

export async function runAgentPlan(params: {
  ctx: ActiveWorkspaceContext;
  prompt: string;
  activeFile: string | null;
  tree: FileNode[];
  openBuffers: Record<string, string>;
  thinkingMode: ThinkingMode;
  agentMode: AgentMode;
}): Promise<{ summary: string; steps: string[]; patches: AgentPatch[] }> {
  const { ctx, prompt, activeFile, tree, openBuffers, thinkingMode, agentMode } = params;
  const candidatePaths = flattenFilePaths(tree).slice(0, 24);

  const files: Array<{ path: string; content: string }> = [];
  for (const p of candidatePaths) {
    if (openBuffers[p] !== undefined) {
      files.push({ path: p, content: openBuffers[p] });
    } else {
      try {
        const content = await readWorkspaceFile(ctx, p);
        files.push({ path: p, content });
      } catch {
        // Ignore unreadable file
      }
    }
  }

  let rawResult: {
    summary: string;
    steps: string[];
    patches: Array<{ path: string; action: string; rationale: string; content: string }>;
  };

  if (ctx.source === 'tauri-native') {
    rawResult = await tauriInvoke('run_gemini_agent', {
      prompt,
      activeFile,
      files,
      thinkingMode,
      agentMode,
    });
  } else {
    const res = await fetch('/api/agent/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        activeFile,
        files,
        thinkingMode,
        agentMode,
      }),
    });
    const data = (await res.json()) as {
      summary?: string;
      steps?: string[];
      patches?: Array<{ path: string; action: string; rationale: string; content: string }>;
      error?: string;
    };
    if (!res.ok) {
      throw new Error(data.error ?? 'Agent failed to generate response');
    }
    rawResult = {
      summary: data.summary ?? 'Completed analysis.',
      steps: data.steps ?? [],
      patches: data.patches ?? [],
    };
  }

  const originalMap = new Map(files.map((f) => [f.path, f.content]));
  const patches: AgentPatch[] =
    agentMode === 'plan'
      ? []
      : rawResult.patches.map((p, idx) => {
          const normalizedAction =
            p.action === 'create' || p.action === 'delete' || p.action === 'modify'
              ? p.action
              : originalMap.has(p.path)
                ? 'modify'
                : 'create';

          return {
            id: `${Date.now()}-${idx}-${p.path}`,
            path: p.path,
            action: normalizedAction,
            rationale: p.rationale ?? '',
            content: p.content ?? '',
            originalContent: originalMap.get(p.path) ?? '',
            status: 'pending',
          };
        });

  return {
    summary: rawResult.summary,
    steps: rawResult.steps,
    patches,
  };
}

export async function createServerWorkspaceFolder(
  name: string,
  template: 'blank' | 'rust' | 'typescript'
): Promise<WorkspaceSummary> {
  const res = await fetch('/api/workspaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, template }),
  });
  const data = (await res.json()) as { workspace?: WorkspaceSummary; error?: string };
  if (!res.ok || !data.workspace) {
    throw new Error(data.error ?? 'Failed to create folder');
  }
  return data.workspace;
}

export async function createTauriWorkspaceFolder(
  parentDir: string,
  name: string,
  template: 'blank' | 'rust' | 'typescript'
): Promise<string> {
  const createdPath = await tauriInvoke<string>('create_new_workspace_dir', {
    parentDir,
    name,
  });

  if (template === 'rust') {
    await tauriInvoke('write_workspace_file', {
      root: createdPath,
      relPath: 'Cargo.toml',
      content: `[package]\nname = "${name.trim()}"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n`,
    });
    await tauriInvoke('write_workspace_file', {
      root: createdPath,
      relPath: 'src/main.rs',
      content: `fn main() {\n    println!("Hello from ${name.trim()}");\n}\n`,
    });
  } else if (template === 'typescript') {
    await tauriInvoke('write_workspace_file', {
      root: createdPath,
      relPath: 'package.json',
      content: `{\n  "name": "${name.trim()}",\n  "version": "0.1.0",\n  "type": "module"\n}\n`,
    });
    await tauriInvoke('write_workspace_file', {
      root: createdPath,
      relPath: 'src/index.ts',
      content: `export function main(): void {\n  console.log("Hello from ${name.trim()}");\n}\n\nmain();\n`,
    });
  } else {
    await tauriInvoke('write_workspace_file', {
      root: createdPath,
      relPath: 'README.md',
      content: `# ${name.trim()}\n\nWorkspace created in Aetheris.\n`,
    });
  }

  return createdPath;
}

export async function sendHomeChat(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
): Promise<string> {
  if (isTauriRuntime()) {
    return tauriInvoke<string>('chat_gemini', { messages });
  }
  const res = await fetch('/api/agent/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
  });
  const data = (await res.json()) as { reply?: string; error?: string };
  if (!res.ok) {
    throw new Error(data.error ?? 'Chat request failed');
  }
  return data.reply ?? '';
}

const RECENTS_KEY = 'aetheris.recentWorkspaces';
const IDB_NAME = 'aetheris-handles';
const IDB_STORE = 'dirHandles';

function openHandleDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) {
        req.result.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveLocalDirHandle(id: string, handle: FileSystemDirectoryHandle): Promise<void> {
  try {
    const db = await openHandleDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(handle, id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // IndexedDB unavailable
  }
}

export async function loadLocalDirHandle(id: string): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await openHandleDb();
    return await new Promise<FileSystemDirectoryHandle | null>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(id);
      req.onsuccess = () => resolve((req.result as FileSystemDirectoryHandle | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export function loadRecentWorkspaces(): RecentWorkspace[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as RecentWorkspace[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function recordRecentWorkspace(entry: RecentWorkspace): RecentWorkspace[] {
  const existing = loadRecentWorkspaces().filter(
    (item) => !(item.id === entry.id && item.source === entry.source)
  );
  const next = [entry, ...existing].slice(0, 8);
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    // Storage quota ignored
  }
  return next;
}

export function removeRecentWorkspace(id: string, source: WorkspaceSource): RecentWorkspace[] {
  const next = loadRecentWorkspaces().filter((item) => !(item.id === id && item.source === source));
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    // Storage quota ignored
  }
  return next;
}

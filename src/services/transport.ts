import {
  AgentActivityItem,
  AgentMode,
  AgentPatch,
  AiProviderSettings,
  CreatedProjectSummary,
  FileNode,
  GitDiffPreview,
  GitFileChangeStatus,
  GitStatusSnapshot,
  GroundingSource,
  McpServerConfig,
  McpServerSnapshot,
  McpTransportType,
  ModelEffort,
  PinnedContextItem,
  RecentWorkspace,
  SearchHit,
  ServerAiStatus,
  TerminalEntry,
  WorkspaceSource,
  WorkspaceSummary,
} from '../types/ide';

const AI_SETTINGS_STORAGE_KEY = 'aetheris.aiProviderSettings';

export const DEFAULT_AI_PROVIDER_SETTINGS: AiProviderSettings = {
  provider: 'gemini',
  geminiModel: 'gemini-4-hydrogen',
  openaiBaseUrl: 'https://api.openai.com/v1',
  openaiModel: 'gpt-4o',
  enableWebSearch: true,
};

export function loadAiProviderSettings(): AiProviderSettings {
  try {
    const raw = localStorage.getItem(AI_SETTINGS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_AI_PROVIDER_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<AiProviderSettings>;
    return {
      provider: parsed.provider === 'openai-compatible' ? 'openai-compatible' : 'gemini',
      geminiModel: parsed.geminiModel?.trim() || DEFAULT_AI_PROVIDER_SETTINGS.geminiModel,
      openaiBaseUrl: parsed.openaiBaseUrl?.trim() || DEFAULT_AI_PROVIDER_SETTINGS.openaiBaseUrl,
      openaiModel: parsed.openaiModel?.trim() || DEFAULT_AI_PROVIDER_SETTINGS.openaiModel,
      enableWebSearch: parsed.enableWebSearch !== false,
    };
  } catch {
    return { ...DEFAULT_AI_PROVIDER_SETTINGS };
  }
}

export function saveAiProviderSettings(settings: AiProviderSettings): void {
  try {
    localStorage.setItem(
      AI_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        provider: settings.provider,
        geminiModel: settings.geminiModel.trim() || DEFAULT_AI_PROVIDER_SETTINGS.geminiModel,
        openaiBaseUrl: settings.openaiBaseUrl.trim() || DEFAULT_AI_PROVIDER_SETTINGS.openaiBaseUrl,
        openaiModel: settings.openaiModel.trim() || DEFAULT_AI_PROVIDER_SETTINGS.openaiModel,
        enableWebSearch: settings.enableWebSearch,
      })
    );
  } catch {
    // Ignore storage quota errors
  }
}

export async function fetchServerAiStatus(): Promise<ServerAiStatus> {
  if (isTauriRuntime()) {
    return {
      geminiConfigured: true,
      openaiCompatConfigured: false,
      defaultOpenaiBaseUrl: 'https://api.openai.com/v1',
      defaultOpenaiModel: 'gpt-4o',
      mcpEndpointPath: '/api/mcp',
    };
  }
  const res = await fetch('/api/ai/status');
  if (!res.ok) {
    throw new Error('Failed to load AI provider status');
  }
  return (await res.json()) as ServerAiStatus;
}

export async function fetchOpenAiModels(baseUrl: string): Promise<string[]> {
  const res = await fetch('/api/ai/models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseUrl }),
  });
  const data = (await res.json()) as { models?: string[]; error?: string };
  if (!res.ok) {
    throw new Error(data.error ?? 'Failed to fetch models');
  }
  return Array.isArray(data.models) ? data.models : [];
}

export async function testAiProviderConnection(
  providerSettings: AiProviderSettings
): Promise<{ ok: boolean; latencyMs: number; replyPreview: string }> {
  const res = await fetch('/api/ai/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerSettings }),
  });
  const data = (await res.json()) as {
    ok?: boolean;
    latencyMs?: number;
    replyPreview?: string;
    error?: string;
  };
  if (!res.ok) {
    throw new Error(data.error ?? 'Connection check failed');
  }
  return {
    ok: Boolean(data.ok),
    latencyMs: data.latencyMs ?? 0,
    replyPreview: data.replyPreview ?? 'Connected',
  };
}

export async function fetchMcpServers(): Promise<McpServerSnapshot[]> {
  if (isTauriRuntime()) return [];
  try {
    const res = await fetch('/api/mcp/servers');
    if (!res.ok) return [];
    const data = (await res.json()) as { servers?: McpServerSnapshot[] };
    return Array.isArray(data.servers) ? data.servers : [];
  } catch {
    return [];
  }
}

export async function saveMcpServer(
  server: Partial<McpServerConfig> & { name: string; transport: McpTransportType }
): Promise<McpServerSnapshot[]> {
  const res = await fetch('/api/mcp/servers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(server),
  });
  const data = (await res.json()) as { servers?: McpServerSnapshot[]; error?: string };
  if (!res.ok) {
    throw new Error(data.error ?? 'Failed to save MCP server');
  }
  return data.servers ?? [];
}

export async function toggleMcpServer(
  id: string,
  enabled: boolean
): Promise<McpServerSnapshot[]> {
  const res = await fetch(`/api/mcp/servers/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  const data = (await res.json()) as { servers?: McpServerSnapshot[]; error?: string };
  if (!res.ok) {
    throw new Error(data.error ?? 'Failed to update MCP server');
  }
  return data.servers ?? [];
}

export async function deleteMcpServer(id: string): Promise<McpServerSnapshot[]> {
  const res = await fetch(`/api/mcp/servers/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  const data = (await res.json()) as { servers?: McpServerSnapshot[]; error?: string };
  if (!res.ok) {
    throw new Error(data.error ?? 'Failed to remove MCP server');
  }
  return data.servers ?? [];
}

export async function readMcpResourcePreview(params: {
  serverId: string;
  uri: string;
  workspaceId?: string;
  activeFile?: string | null;
  openBuffers?: Record<string, string>;
  terminalEntries?: Array<{
    command: string;
    stdout: string;
    stderr: string;
    exitCode: number;
    cwd?: string;
  }>;
}): Promise<{ uri: string; mimeType: string; text: string }> {
  const res = await fetch('/api/mcp/resources/read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = (await res.json()) as {
    resource?: { uri: string; mimeType: string; text: string };
    error?: string;
  };
  if (!res.ok || !data.resource) {
    throw new Error(data.error ?? 'Failed to read MCP resource');
  }
  return data.resource;
}

export async function resolveMcpPromptTemplate(params: {
  serverId: string;
  name: string;
  args?: Record<string, string>;
  workspaceId?: string;
}): Promise<{
  promptText: string;
  recommendedResources: Array<{ serverId: string; uri: string; label: string }>;
}> {
  const res = await fetch('/api/mcp/prompts/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = (await res.json()) as {
    promptText?: string;
    recommendedResources?: Array<{ serverId: string; uri: string; label: string }>;
    error?: string;
  };
  if (!res.ok) {
    throw new Error(data.error ?? 'Failed to resolve MCP prompt');
  }
  return {
    promptText: data.promptText ?? '',
    recommendedResources: Array.isArray(data.recommendedResources) ? data.recommendedResources : [],
  };
}

interface TauriInternals {
  invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  transformCallback?: (callback: (payload: unknown) => void, once?: boolean) => number;
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

async function listenTauriEvent<T>(
  eventName: string,
  handler: (payload: T) => void
): Promise<() => void> {
  const internals = window.__TAURI_INTERNALS__;
  if (!internals?.invoke || !internals.transformCallback) {
    return () => {};
  }
  try {
    const callbackId = internals.transformCallback((evt: unknown) => {
      const wrapped = evt as { payload?: T };
      if (wrapped && wrapped.payload !== undefined) {
        handler(wrapped.payload);
      }
    });
    const eventId = await internals.invoke<number>('plugin:event|listen', {
      event: eventName,
      target: { kind: 'Any' },
      handler: callbackId,
    });
    return () => {
      void internals
        .invoke('plugin:event|unlisten', { event: eventName, eventId })
        .catch(() => {});
    };
  } catch {
    return () => {};
  }
}

export async function cancelTauriAgent(): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    await tauriInvoke('cancel_gemini_agent');
  } catch {
    // Ignore cancellation race
  }
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

interface CachedSearchFile {
  lastModified: number;
  size: number;
  text: string;
  lower: string;
}

const localSearchCache = new Map<string, CachedSearchFile>();
const SEARCH_LOCKFILE_RE = /(?:^|\/)(?:cargo\.lock|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i;
const SEARCH_SKIP_FILE_RE =
  /\.(png|jpe?g|gif|webp|ico|bmp|svg|wasm|exe|dll|so|dylib|a|o|lib|zip|tar|gz|bz2|xz|7z|pdf|woff2?|ttf|otf|eot|mp3|mp4|webm|mov|avi|ogg|flac|sqlite|db|min\.js|min\.css|map)$/i;

export async function searchWorkspace(
  ctx: ActiveWorkspaceContext,
  query: string,
  symbolsOnly: boolean,
  tree: FileNode[],
  signal?: AbortSignal
): Promise<SearchHit[]> {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  if (ctx.source === 'tauri-native' && ctx.nativeRoot) {
    const res = await tauriInvoke<SearchHit[]>('search_workspace', {
      root: ctx.nativeRoot,
      query,
      symbolsOnly,
    });
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    return res;
  }

  if (ctx.source === 'local-fs' && ctx.localDirHandle) {
    const allPaths = flattenFilePaths(tree)
      .filter((p) => !SEARCH_LOCKFILE_RE.test(p) && !SEARCH_SKIP_FILE_RE.test(p))
      .slice(0, 2000);
    const qLower = query.trim().toLowerCase();
    const maxBytes = qLower ? 1_000_000 : 512_000;
    const hits: SearchHit[] = [];

    for (let idx = 0; idx < allPaths.length; idx++) {
      if (hits.length >= 150) break;
      if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      if (idx > 0 && idx % 40 === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      const filePath = allPaths[idx];
      try {
        const cacheKey = `${ctx.id}:${filePath}`;
        let cached = localSearchCache.get(cacheKey);
        const handle = await resolveLocalFileHandle(ctx.localDirHandle, filePath, false);
        const file = await handle.getFile();
        if (file.size > maxBytes) continue;

        if (!cached || cached.lastModified !== file.lastModified || cached.size !== file.size) {
          const text = await file.text();
          if (text.slice(0, 512).includes('\0')) continue;
          cached = {
            lastModified: file.lastModified,
            size: file.size,
            text,
            lower: text.toLowerCase(),
          };
          if (localSearchCache.size > 1500) {
            const firstKey = localSearchCache.keys().next().value;
            if (firstKey) localSearchCache.delete(firstKey);
          }
          localSearchCache.set(cacheKey, cached);
        }

        const { text, lower } = cached;
        if (qLower && !lower.includes(qLower)) {
          continue;
        }

        const lines = text.split(/\r?\n/);
        if (qLower) {
          const lowerLines = lower.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            if (hits.length >= 150) break;
            const lineLower = lowerLines[i] ?? lines[i].toLowerCase();
            if (!lineLower.includes(qLower)) continue;

            const lineText = lines[i];
            const match = SYMBOL_REGEX.exec(lineText);
            if (match) {
              const [, kind, name] = match;
              hits.push({
                filePath,
                line: i + 1,
                preview: lineText.trim().slice(0, 140),
                symbolKind: kind,
                symbolName: name,
              });
            } else if (!symbolsOnly) {
              hits.push({
                filePath,
                line: i + 1,
                preview: lineText.trim().slice(0, 140),
                symbolKind: null,
                symbolName: null,
              });
            }
          }
        } else {
          for (let i = 0; i < lines.length; i++) {
            if (hits.length >= 150) break;
            const lineText = lines[i];
            const match = SYMBOL_REGEX.exec(lineText);
            if (match) {
              const [, kind, name] = match;
              hits.push({
                filePath,
                line: i + 1,
                preview: lineText.trim().slice(0, 140),
                symbolKind: kind,
                symbolName: name,
              });
            }
          }
        }
      } catch {
        // Skip unreadable binary files
      }
    }
    return hits;
  }

  const res = await fetch(
    `/api/workspaces/${encodeURIComponent(ctx.id)}/search?q=${encodeURIComponent(query)}&symbolsOnly=${String(symbolsOnly)}`,
    { signal }
  );
  const data = (await res.json()) as { hits?: SearchHit[]; error?: string };
  if (!res.ok) throw new Error(data.error ?? 'Search failed');
  return data.hits ?? [];
}

function resolveVirtualPath(tree: FileNode[], cwd: string, target?: string): string | null {
  const baseParts = cwd === '.' || !cwd ? [] : cwd.split('/').filter(Boolean);
  const rawTarget = (target ?? '').trim();

  if (!rawTarget || rawTarget === '~' || rawTarget === '/') {
    return '.';
  }

  const nextParts = rawTarget.startsWith('/') ? [] : [...baseParts];
  for (const seg of rawTarget.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      nextParts.pop();
    } else {
      nextParts.push(seg);
    }
  }

  if (nextParts.length === 0) return '.';

  let nodes = tree;
  for (let i = 0; i < nextParts.length; i++) {
    const found = nodes.find((n) => n.name === nextParts[i] && n.kind === 'dir');
    if (!found) return null;
    nodes = found.children ?? [];
  }
  return nextParts.join('/');
}

function getVirtualDirChildren(tree: FileNode[], relDir: string): FileNode[] {
  if (relDir === '.' || !relDir) return tree;
  let nodes = tree;
  for (const seg of relDir.split('/').filter(Boolean)) {
    const found = nodes.find((n) => n.name === seg && n.kind === 'dir');
    if (!found) return [];
    nodes = found.children ?? [];
  }
  return nodes;
}

export async function execWorkspaceCommand(
  ctx: ActiveWorkspaceContext,
  command: string,
  tree: FileNode[],
  currentCwd = '.'
): Promise<Omit<TerminalEntry, 'id' | 'timestamp'>> {
  if (ctx.source === 'tauri-native' && ctx.nativeRoot) {
    const out = await tauriInvoke<{ stdout: string; stderr: string; exitCode: number; cwd?: string }>(
      'exec_terminal_command',
      { root: ctx.nativeRoot, command, cwd: currentCwd }
    );
    return {
      command,
      stdout: out.stdout,
      stderr: out.stderr,
      exitCode: out.exitCode,
      cwd: out.cwd ?? currentCwd,
    };
  }

  if (ctx.source === 'local-fs') {
    const segments = command
      .split(/\s*&&\s*/)
      .map((s) => s.trim())
      .filter(Boolean);

    let cwd = currentCwd || '.';
    let stdout = '';
    let stderr = '';
    let exitCode = 0;

    for (const seg of segments) {
      if (seg === 'cd' || seg.startsWith('cd ')) {
        const arg = seg.slice(2).trim().replace(/^["']|["']$/g, '');
        const resolved = resolveVirtualPath(tree, cwd, arg);
        if (resolved === null) {
          stderr += `cd: no such directory: ${arg}\n`;
          exitCode = 1;
          break;
        }
        cwd = resolved;
        continue;
      }

      if (seg === 'pwd') {
        stdout += cwd === '.' ? `${ctx.name}\n` : `${ctx.name}/${cwd}\n`;
        continue;
      }

      if (seg === 'ls' || seg.startsWith('ls ')) {
        const arg = seg
          .slice(2)
          .trim()
          .split(/\s+/)
          .filter((t) => t && !t.startsWith('-'))[0];
        const targetDir = arg ? resolveVirtualPath(tree, cwd, arg) : cwd;
        if (targetDir === null) {
          stderr += `ls: cannot access '${arg}': No such file or directory\n`;
          exitCode = 1;
          break;
        }
        const children = getVirtualDirChildren(tree, targetDir);
        const listing = children.map((n) => (n.kind === 'dir' ? `${n.name}/` : n.name)).join('  ');
        stdout += listing ? `${listing}\n` : '';
        continue;
      }

      stderr +=
        'Browser security isolates local folder handles from OS shell spawning. Use the Native Rust/Tauri build on Linux/Windows for full PTY shell execution on local folders, or switch to a starter workspace to run live commands here.\n';
      exitCode = 1;
      break;
    }

    return { command, stdout, stderr, exitCode, cwd };
  }

  const res = await fetch(`/api/workspaces/${encodeURIComponent(ctx.id)}/terminal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command, cwd: currentCwd }),
  });
  const data = (await res.json()) as {
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    cwd?: string;
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
    cwd: data.cwd ?? currentCwd,
  };
}

export type AgentStreamEvent =
  | { type: 'activity'; activity: AgentActivityItem }
  | { type: 'thought'; delta: string };

const BINARY_EXT_RE =
  /\.(png|jpe?g|gif|webp|ico|bmp|wasm|exe|dll|so|dylib|a|o|lib|zip|tar|gz|bz2|xz|7z|pdf|woff2?|ttf|otf|eot|mp3|mp4|webm|mov|avi|ogg|flac|sqlite|db)$/i;

export async function runAgentPlan(params: {
  ctx: ActiveWorkspaceContext;
  prompt: string;
  activeFile: string | null;
  tree: FileNode[];
  openBuffers: Record<string, string>;
  effort: ModelEffort;
  agentMode: AgentMode;
  autopilot?: boolean;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  providerSettings?: AiProviderSettings;
  pinnedContext?: PinnedContextItem[];
  terminalEntries?: TerminalEntry[];
  signal?: AbortSignal;
  onEvent?: (event: AgentStreamEvent) => void;
}): Promise<{
  summary: string;
  steps: string[];
  patches: AgentPatch[];
  thoughts: string;
  thinkingDurationMs: number;
  sources: GroundingSource[];
  searchQueries: string[];
}> {
  const {
    ctx,
    prompt,
    activeFile,
    tree,
    openBuffers,
    effort,
    agentMode,
    autopilot,
    history,
    providerSettings,
    pinnedContext,
    terminalEntries,
    signal,
    onEvent,
  } = params;

  const originalMap = new Map<string, string>(Object.entries(openBuffers));

  let rawResult: {
    summary: string;
    steps: string[];
    patches: Array<{
      path: string;
      action: string;
      rationale: string;
      content: string;
      originalContent?: string;
    }>;
    thoughts: string;
    thinkingDurationMs: number;
    sources: GroundingSource[];
    searchQueries: string[];
  };

  if (ctx.source === 'tauri-native' && ctx.nativeRoot) {
    const unlisten = await listenTauriEvent<AgentStreamEvent>('aetheris-agent-event', (evt) => {
      onEvent?.(evt);
    });
    const onAbort = () => {
      void cancelTauriAgent();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const tauriRes = await tauriInvoke<{
        summary: string;
        steps: string[];
        patches: Array<{
          path: string;
          action: string;
          rationale: string;
          content: string;
          originalContent?: string;
        }>;
        thoughts?: string;
        thinkingDurationMs?: number;
        sources?: GroundingSource[];
        searchQueries?: string[];
      }>('run_gemini_agent', {
        root: ctx.nativeRoot,
        prompt,
        activeFile,
        openBuffers,
        effort,
        agentMode,
        autopilot: Boolean(autopilot),
        history,
      });

      rawResult = {
        summary: tauriRes.summary ?? 'Completed analysis.',
        steps: tauriRes.steps ?? [],
        patches: tauriRes.patches ?? [],
        thoughts: tauriRes.thoughts ?? '',
        thinkingDurationMs: tauriRes.thinkingDurationMs ?? 0,
        sources: Array.isArray(tauriRes.sources) ? tauriRes.sources : [],
        searchQueries: Array.isArray(tauriRes.searchQueries) ? tauriRes.searchQueries : [],
      };
    } catch (err) {
      if (signal?.aborted || (err instanceof Error && err.message === 'CANCELLED')) {
        throw new DOMException('Aborted', 'AbortError');
      }
      throw err;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      unlisten();
    }
  } else {
    let localFiles: Array<{ path: string; content: string }> | undefined;
    if (ctx.source === 'local-fs' && ctx.localDirHandle) {
      localFiles = [];
      const candidatePaths = flattenFilePaths(tree)
        .filter((p) => !BINARY_EXT_RE.test(p))
        .slice(0, 200);
      for (const p of candidatePaths) {
        if (signal?.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }
        if (openBuffers[p] !== undefined) {
          localFiles.push({ path: p, content: openBuffers[p] });
        } else {
          try {
            const handle = await resolveLocalFileHandle(ctx.localDirHandle, p, false);
            const file = await handle.getFile();
            if (file.size <= 512_000) {
              const content = await file.text();
              localFiles.push({ path: p, content });
              originalMap.set(p, content);
            }
          } catch {
            // Ignore unreadable or binary files
          }
        }
      }
    }

    const res = await fetch('/api/agent/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        workspaceId: ctx.source === 'starter' ? ctx.id : undefined,
        prompt,
        activeFile,
        openBuffers,
        files: localFiles,
        effort,
        agentMode,
        autopilot: Boolean(autopilot),
        history,
        providerSettings: providerSettings ?? loadAiProviderSettings(),
        pinnedContext,
        terminalEntries: (terminalEntries ?? []).slice(-6).map((t) => ({
          command: t.command,
          stdout: t.stdout,
          stderr: t.stderr,
          exitCode: t.exitCode,
          cwd: t.cwd,
        })),
      }),
    });

    if (!res.ok) {
      let errMessage = 'Agent failed to generate response';
      try {
        const errData = (await res.json()) as { error?: string };
        if (errData.error) errMessage = errData.error;
      } catch {
        // Ignore non-JSON error body
      }
      throw new Error(errMessage);
    }

    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('application/x-ndjson') && res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finalResult: typeof rawResult | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newlineIdx = buffer.indexOf('\n');
        while (newlineIdx !== -1) {
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);

          if (line) {
            const evt = JSON.parse(line) as
              | { type: 'activity'; activity: AgentActivityItem }
              | { type: 'thought'; delta: string }
              | {
                  type: 'result';
                  summary?: string;
                  steps?: string[];
                  patches?: Array<{
                    path: string;
                    action: string;
                    rationale: string;
                    content: string;
                    originalContent?: string;
                  }>;
                  thoughts?: string;
                  thinkingDurationMs?: number;
                  sources?: GroundingSource[];
                  searchQueries?: string[];
                }
              | { type: 'error'; error?: string };

            if (evt.type === 'activity' || evt.type === 'thought') {
              onEvent?.(evt);
            } else if (evt.type === 'error') {
              throw new Error(evt.error ?? 'Agent failed during streaming');
            } else if (evt.type === 'result') {
              finalResult = {
                summary: evt.summary ?? 'Completed analysis.',
                steps: evt.steps ?? [],
                patches: evt.patches ?? [],
                thoughts: evt.thoughts ?? '',
                thinkingDurationMs: evt.thinkingDurationMs ?? 0,
                sources: Array.isArray(evt.sources) ? evt.sources : [],
                searchQueries: Array.isArray(evt.searchQueries) ? evt.searchQueries : [],
              };
            }
          }

          newlineIdx = buffer.indexOf('\n');
        }
      }

      if (!finalResult) {
        if (signal?.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }
        throw new Error('Agent stream ended before returning a result');
      }
      rawResult = finalResult;
    } else {
      const data = (await res.json()) as {
        summary?: string;
        steps?: string[];
        patches?: Array<{
          path: string;
          action: string;
          rationale: string;
          content: string;
          originalContent?: string;
        }>;
        thoughts?: string;
        thinkingDurationMs?: number;
        sources?: GroundingSource[];
        searchQueries?: string[];
      };
      rawResult = {
        summary: data.summary ?? 'Completed analysis.',
        steps: data.steps ?? [],
        patches: data.patches ?? [],
        thoughts: data.thoughts ?? '',
        thinkingDurationMs: data.thinkingDurationMs ?? 0,
        sources: Array.isArray(data.sources) ? data.sources : [],
        searchQueries: Array.isArray(data.searchQueries) ? data.searchQueries : [],
      };
    }
  }

  const patches: AgentPatch[] =
    agentMode === 'plan'
      ? []
      : rawResult.patches.map((p, idx) => {
          const baseline = p.originalContent ?? originalMap.get(p.path) ?? '';
          const normalizedAction =
            p.action === 'create' || p.action === 'delete' || p.action === 'modify'
              ? p.action
              : baseline
                ? 'modify'
                : 'create';

          return {
            id: `${Date.now()}-${idx}-${p.path}`,
            path: p.path,
            action: normalizedAction,
            rationale: p.rationale ?? '',
            content: p.content ?? '',
            originalContent: baseline,
            status: 'pending',
          };
        });

  return {
    summary: rawResult.summary,
    steps: rawResult.steps,
    patches,
    thoughts: rawResult.thoughts,
    thinkingDurationMs: rawResult.thinkingDurationMs,
    sources: rawResult.sources,
    searchQueries: rawResult.searchQueries,
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
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  providerSettings?: AiProviderSettings
): Promise<{
  reply: string;
  createdProjects: CreatedProjectSummary[];
  sources: GroundingSource[];
  searchQueries: string[];
}> {
  if (isTauriRuntime()) {
    const res = await tauriInvoke<{
      reply?: string;
      createdProjects?: CreatedProjectSummary[];
      sources?: GroundingSource[];
      searchQueries?: string[];
    }>('chat_gemini', { messages });
    return {
      reply: res.reply ?? '',
      createdProjects: Array.isArray(res.createdProjects) ? res.createdProjects : [],
      sources: Array.isArray(res.sources) ? res.sources : [],
      searchQueries: Array.isArray(res.searchQueries) ? res.searchQueries : [],
    };
  }
  const res = await fetch('/api/agent/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages,
      providerSettings: providerSettings ?? loadAiProviderSettings(),
    }),
  });
  const data = (await res.json()) as {
    reply?: string;
    createdProjects?: CreatedProjectSummary[];
    sources?: GroundingSource[];
    searchQueries?: string[];
    error?: string;
  };
  if (!res.ok) {
    throw new Error(data.error ?? 'Chat request failed');
  }
  return {
    reply: data.reply ?? '',
    createdProjects: Array.isArray(data.createdProjects) ? data.createdProjects : [],
    sources: Array.isArray(data.sources) ? data.sources : [],
    searchQueries: Array.isArray(data.searchQueries) ? data.searchQueries : [],
  };
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

const EMPTY_GIT_SNAPSHOT: GitStatusSnapshot = {
  isRepo: false,
  branch: '',
  branches: [],
  remoteUrl: null,
  ahead: 0,
  behind: 0,
  hasUpstream: false,
  staged: [],
  changes: [],
  unpushedFiles: [],
  pushedFiles: [],
  commits: [],
  userName: null,
  userEmail: null,
  ghAvailable: false,
};

async function gitApiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) {
    throw new Error(data.error ?? 'Git operation failed');
  }
  return data;
}

export async function fetchGitStatus(ctx: ActiveWorkspaceContext): Promise<GitStatusSnapshot> {
  if (ctx.source === 'tauri-native' && ctx.nativeRoot) {
    return tauriInvoke<GitStatusSnapshot>('git_status', { root: ctx.nativeRoot });
  }
  if (ctx.source === 'local-fs') {
    return EMPTY_GIT_SNAPSHOT;
  }
  return gitApiRequest<GitStatusSnapshot>(
    `/api/workspaces/${encodeURIComponent(ctx.id)}/git/status`
  );
}

export async function fetchGitFileDiff(
  ctx: ActiveWorkspaceContext,
  relPath: string,
  staged: boolean,
  status: GitFileChangeStatus
): Promise<GitDiffPreview> {
  if (ctx.source === 'tauri-native' && ctx.nativeRoot) {
    return tauriInvoke<GitDiffPreview>('git_diff_file', {
      root: ctx.nativeRoot,
      relPath,
      staged,
      status,
    });
  }
  if (ctx.source === 'local-fs') {
    throw new Error('Git CLI diff requires native desktop or local server workspace.');
  }
  return gitApiRequest<GitDiffPreview>(
    `/api/workspaces/${encodeURIComponent(ctx.id)}/git/diff?path=${encodeURIComponent(relPath)}&staged=${String(staged)}&status=${encodeURIComponent(status)}`
  );
}

export async function initGitRepository(ctx: ActiveWorkspaceContext): Promise<GitStatusSnapshot> {
  if (ctx.source === 'tauri-native' && ctx.nativeRoot) {
    return tauriInvoke<GitStatusSnapshot>('git_init_repo', { root: ctx.nativeRoot });
  }
  if (ctx.source === 'local-fs') {
    throw new Error('Open this folder in the native Rust/Tauri app to run Git commands directly on local folders.');
  }
  return gitApiRequest<GitStatusSnapshot>(
    `/api/workspaces/${encodeURIComponent(ctx.id)}/git/init`,
    { method: 'POST' }
  );
}

export async function stageGitFiles(
  ctx: ActiveWorkspaceContext,
  paths: string[],
  all = false
): Promise<GitStatusSnapshot> {
  if (ctx.source === 'tauri-native' && ctx.nativeRoot) {
    return tauriInvoke<GitStatusSnapshot>('git_stage', { root: ctx.nativeRoot, paths, all });
  }
  return gitApiRequest<GitStatusSnapshot>(
    `/api/workspaces/${encodeURIComponent(ctx.id)}/git/stage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths, all }),
    }
  );
}

export async function unstageGitFiles(
  ctx: ActiveWorkspaceContext,
  paths: string[],
  all = false
): Promise<GitStatusSnapshot> {
  if (ctx.source === 'tauri-native' && ctx.nativeRoot) {
    return tauriInvoke<GitStatusSnapshot>('git_unstage', { root: ctx.nativeRoot, paths, all });
  }
  return gitApiRequest<GitStatusSnapshot>(
    `/api/workspaces/${encodeURIComponent(ctx.id)}/git/unstage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths, all }),
    }
  );
}

export async function discardGitChange(
  ctx: ActiveWorkspaceContext,
  relPath: string,
  untracked: boolean
): Promise<GitStatusSnapshot> {
  if (ctx.source === 'tauri-native' && ctx.nativeRoot) {
    return tauriInvoke<GitStatusSnapshot>('git_discard', {
      root: ctx.nativeRoot,
      relPath,
      untracked,
    });
  }
  return gitApiRequest<GitStatusSnapshot>(
    `/api/workspaces/${encodeURIComponent(ctx.id)}/git/discard`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: relPath, untracked }),
    }
  );
}

export async function commitGitChanges(
  ctx: ActiveWorkspaceContext,
  params: {
    message: string;
    stageAllIfEmpty?: boolean;
    userName?: string;
    userEmail?: string;
  }
): Promise<GitStatusSnapshot> {
  if (ctx.source === 'tauri-native' && ctx.nativeRoot) {
    return tauriInvoke<GitStatusSnapshot>('git_commit', {
      root: ctx.nativeRoot,
      message: params.message,
      stageAllIfEmpty: params.stageAllIfEmpty ?? false,
      userName: params.userName ?? null,
      userEmail: params.userEmail ?? null,
    });
  }
  return gitApiRequest<GitStatusSnapshot>(
    `/api/workspaces/${encodeURIComponent(ctx.id)}/git/commit`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    }
  );
}

export async function runGitBranchAction(
  ctx: ActiveWorkspaceContext,
  action: 'checkout' | 'create',
  name: string
): Promise<GitStatusSnapshot> {
  if (ctx.source === 'tauri-native' && ctx.nativeRoot) {
    return tauriInvoke<GitStatusSnapshot>('git_branch', {
      root: ctx.nativeRoot,
      action,
      name,
    });
  }
  return gitApiRequest<GitStatusSnapshot>(
    `/api/workspaces/${encodeURIComponent(ctx.id)}/git/branch`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, name }),
    }
  );
}

export async function setGitRemoteOrigin(
  ctx: ActiveWorkspaceContext,
  url: string
): Promise<GitStatusSnapshot> {
  if (ctx.source === 'tauri-native' && ctx.nativeRoot) {
    return tauriInvoke<GitStatusSnapshot>('git_set_remote', {
      root: ctx.nativeRoot,
      url,
    });
  }
  return gitApiRequest<GitStatusSnapshot>(
    `/api/workspaces/${encodeURIComponent(ctx.id)}/git/remote`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    }
  );
}

export async function syncGitRemote(
  ctx: ActiveWorkspaceContext,
  action: 'fetch' | 'pull' | 'push' | 'sync'
): Promise<GitStatusSnapshot> {
  if (ctx.source === 'tauri-native' && ctx.nativeRoot) {
    return tauriInvoke<GitStatusSnapshot>('git_sync', {
      root: ctx.nativeRoot,
      action,
    });
  }
  return gitApiRequest<GitStatusSnapshot>(
    `/api/workspaces/${encodeURIComponent(ctx.id)}/git/sync`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    }
  );
}

export async function generateGitCommitMessage(
  ctx: ActiveWorkspaceContext,
  providerSettings?: AiProviderSettings
): Promise<string> {
  if (ctx.source === 'tauri-native' && ctx.nativeRoot) {
    return tauriInvoke<string>('git_generate_commit_message', { root: ctx.nativeRoot });
  }
  const res = await gitApiRequest<{ message?: string }>(
    `/api/workspaces/${encodeURIComponent(ctx.id)}/git/commit-message`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        providerSettings: providerSettings ?? loadAiProviderSettings(),
      }),
    }
  );
  return res.message ?? '';
}


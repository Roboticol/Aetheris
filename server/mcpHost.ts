import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { Type, type FunctionDeclaration, type Schema } from '@google/genai';

export type McpTransportType = 'builtin' | 'stdio' | 'http';

export interface McpServerConfig {
  id: string;
  name: string;
  transport: McpTransportType;
  enabled: boolean;
  description?: string;
  command?: string;
  args?: string[];
  url?: string;
}

export interface McpToolInfo {
  serverId: string;
  serverName: string;
  name: string;
  qualifiedName: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpResourceInfo {
  serverId: string;
  serverName: string;
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface McpPromptInfo {
  serverId: string;
  serverName: string;
  name: string;
  description?: string;
  arguments?: McpPromptArgument[];
}

export interface McpServerSnapshot extends McpServerConfig {
  status: 'connected' | 'disabled' | 'error';
  error?: string;
  protocolVersion?: string;
  tools: McpToolInfo[];
  resources: McpResourceInfo[];
  prompts: McpPromptInfo[];
}

export interface McpWorkspaceContext {
  workspaceRoot?: string;
  workspaceName?: string;
  activeFile?: string | null;
  openBuffers?: Record<string, string>;
  virtualFiles?: Map<string, string>;
  terminalEntries?: Array<{
    command: string;
    stdout: string;
    stderr: string;
    exitCode: number;
    cwd?: string;
  }>;
}

const MCP_CONFIG_PATH = '/tmp/aetheris-mcp-servers.json';
const MCP_PROTOCOL_VERSION = '2024-11-05';

const BUILTIN_SERVER: McpServerConfig = {
  id: 'builtin-workspace',
  name: 'Aetheris Workspace MCP',
  transport: 'builtin',
  enabled: true,
  description:
    'Built-in Model Context Protocol server exposing live Git status/diffs, workspace symbol index, directory structure, and IDE diagnostics.',
};

const SYMBOL_REGEX =
  /^\s*(?:pub\s+)?(?:async\s+)?(?:export\s+)?(?:default\s+)?(fn|struct|enum|trait|impl|function|class|interface|type|const|def)\s+([A-Za-z_][A-Za-z0-9_]*)/;

const SKIP_DIRS = new Set([
  'node_modules',
  'target',
  '.git',
  'dist',
  '.next',
  '.turbo',
  'build',
]);

function sanitizeServerSlug(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 28) || 'mcp';
}

export function buildQualifiedMcpToolName(serverId: string, toolName: string): string {
  const cleanServer = sanitizeServerSlug(serverId);
  const cleanTool = toolName.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 34);
  return `mcp__${cleanServer}__${cleanTool}`;
}

function runGitHelper(
  cwd: string,
  args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
        maxBuffer: 4 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as { code?: unknown }).code === 'number'
            ? ((err as { code: number }).code)
            : err
              ? 1
              : 0;
        resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
      }
    );
  });
}

async function collectWorkspaceFiles(ctx: McpWorkspaceContext): Promise<string[]> {
  const results = new Set<string>();
  if (ctx.virtualFiles) {
    for (const p of ctx.virtualFiles.keys()) results.add(p);
  }
  if (ctx.openBuffers) {
    for (const p of Object.keys(ctx.openBuffers)) results.add(p);
  }
  if (ctx.workspaceRoot) {
    const walk = async (dir: string, depth = 0): Promise<void> => {
      if (depth > 9 || results.size >= 800) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (results.size >= 800) return;
        if (SKIP_DIRS.has(entry.name) || entry.name === '.aetheris-project.json') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full, depth + 1);
        } else {
          const rel = path.relative(ctx.workspaceRoot!, full).split(path.sep).join('/');
          results.add(rel);
        }
      }
    };
    await walk(ctx.workspaceRoot);
  }
  return Array.from(results).sort();
}

async function readCtxFile(ctx: McpWorkspaceContext, relPath: string): Promise<string | null> {
  if (ctx.openBuffers && ctx.openBuffers[relPath] !== undefined) {
    return ctx.openBuffers[relPath];
  }
  if (ctx.virtualFiles && ctx.virtualFiles.has(relPath)) {
    return ctx.virtualFiles.get(relPath)!;
  }
  if (ctx.workspaceRoot) {
    const resolved = path.resolve(ctx.workspaceRoot, relPath);
    if (!resolved.startsWith(path.resolve(ctx.workspaceRoot))) return null;
    try {
      const stat = await fs.stat(resolved);
      if (stat.size > 512_000) return null;
      return await fs.readFile(resolved, 'utf-8');
    } catch {
      return null;
    }
  }
  return null;
}

async function collectSymbols(
  ctx: McpWorkspaceContext,
  queryFilter = '',
  kindFilter = '',
  maxHits = 120
): Promise<Array<{ file: string; line: number; kind: string; name: string; signature: string }>> {
  const files = await collectWorkspaceFiles(ctx);
  const qLower = queryFilter.trim().toLowerCase();
  const kLower = kindFilter.trim().toLowerCase();
  const symbols: Array<{ file: string; line: number; kind: string; name: string; signature: string }> =
    [];

  for (const rel of files) {
    if (symbols.length >= maxHits) break;
    if (/\.(png|jpe?g|gif|webp|ico|wasm|lock|svg|min\.js|map)$/i.test(rel)) continue;
    const text = await readCtxFile(ctx, rel);
    if (!text || text.slice(0, 256).includes('\0')) continue;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (symbols.length >= maxHits) break;
      const m = SYMBOL_REGEX.exec(lines[i]);
      if (!m) continue;
      const [, kind, name] = m;
      if (kLower && kind.toLowerCase() !== kLower) continue;
      if (qLower && !name.toLowerCase().includes(qLower) && !rel.toLowerCase().includes(qLower)) {
        continue;
      }
      symbols.push({
        file: rel,
        line: i + 1,
        kind,
        name,
        signature: lines[i].trim().slice(0, 140),
      });
    }
  }
  return symbols;
}

function getBuiltinTools(): McpToolInfo[] {
  const serverId = BUILTIN_SERVER.id;
  const serverName = BUILTIN_SERVER.name;
  return [
    {
      serverId,
      serverName,
      name: 'git_inspect_diff',
      qualifiedName: buildQualifiedMcpToolName(serverId, 'git_inspect_diff'),
      description:
        'MCP Workspace Tool: Read live Git branch status, staged/unstaged file changes, and unified Git diff (optionally filtered to a specific file path).',
      inputSchema: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Optional relative file path to scope the git diff to.',
          },
          staged_only: {
            type: 'boolean',
            description: 'If true, return only staged (--cached) diff.',
          },
        },
      },
    },
    {
      serverId,
      serverName,
      name: 'symbol_lookup',
      qualifiedName: buildQualifiedMcpToolName(serverId, 'symbol_lookup'),
      description:
        'MCP Workspace Tool: Query extracted code symbols (functions, structs, classes, interfaces, types) across the workspace.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Optional symbol name or file path filter.',
          },
          kind: {
            type: 'string',
            description: 'Optional symbol kind filter (fn, struct, enum, class, interface, function, type).',
          },
        },
      },
    },
    {
      serverId,
      serverName,
      name: 'git_commit_log',
      qualifiedName: buildQualifiedMcpToolName(serverId, 'git_commit_log'),
      description:
        'MCP Workspace Tool: Retrieve recent Git commit history with hashes, authors, timestamps, and commit subjects.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: {
            type: 'integer',
            description: 'Maximum commits to return (default 15, max 40).',
          },
        },
      },
    },
  ];
}

function getBuiltinResources(): McpResourceInfo[] {
  const serverId = BUILTIN_SERVER.id;
  const serverName = BUILTIN_SERVER.name;
  return [
    {
      serverId,
      serverName,
      uri: 'mcp://workspace/git-status',
      name: 'Git Repository Status',
      description: 'Current Git branch, ahead/behind sync state, staged/unstaged files, and recent commits.',
      mimeType: 'text/markdown',
    },
    {
      serverId,
      serverName,
      uri: 'mcp://workspace/git-diff',
      name: 'Uncommitted Git Diff',
      description: 'Unified diff of working tree and staged Git changes across the workspace.',
      mimeType: 'text/x-diff',
    },
    {
      serverId,
      serverName,
      uri: 'mcp://workspace/symbols',
      name: 'Workspace Symbol Index',
      description: 'Indexed functions, classes, structs, interfaces, and types with file line numbers.',
      mimeType: 'text/markdown',
    },
    {
      serverId,
      serverName,
      uri: 'mcp://workspace/structure',
      name: 'Directory Tree & Manifest',
      description: 'Complete workspace file manifest and language distribution.',
      mimeType: 'text/markdown',
    },
    {
      serverId,
      serverName,
      uri: 'mcp://workspace/ide-session',
      name: 'Active Editor & Terminal Context',
      description: 'Open editor buffers, active file, and recent terminal commands with stdout/stderr.',
      mimeType: 'text/markdown',
    },
  ];
}

function getBuiltinPrompts(): McpPromptInfo[] {
  const serverId = BUILTIN_SERVER.id;
  const serverName = BUILTIN_SERVER.name;
  return [
    {
      serverId,
      serverName,
      name: 'review-changes',
      description: 'Audit uncommitted Git changes for bugs, edge cases, and regressions.',
      arguments: [
        { name: 'focus', description: 'Optional area of focus (e.g. security, performance)', required: false },
      ],
    },
    {
      serverId,
      serverName,
      name: 'debug-terminal',
      description: 'Diagnose recent terminal command failures using stdout/stderr and open buffers.',
      arguments: [],
    },
    {
      serverId,
      serverName,
      name: 'architecture-brief',
      description: 'Generate an architectural map using workspace structure and symbol definitions.',
      arguments: [],
    },
  ];
}

async function readBuiltinResource(uri: string, ctx: McpWorkspaceContext): Promise<string> {
  if (uri === 'mcp://workspace/git-status') {
    if (!ctx.workspaceRoot) {
      return 'Git CLI status is unavailable for virtual browser handles without a server/native root.';
    }
    const statusOut = await runGitHelper(ctx.workspaceRoot, ['status', '--short', '--branch']);
    if (statusOut.code !== 0) {
      return 'Workspace is not currently initialized as a Git repository.';
    }
    const logOut = await runGitHelper(ctx.workspaceRoot, [
      'log',
      '-n',
      '10',
      '--pretty=format:%h %ad | %s (%an)',
      '--date=short',
    ]);
    return `### Git Status\n\`\`\`\n${statusOut.stdout.trim() || 'Clean working tree'}\n\`\`\`\n\n### Recent Commits\n\`\`\`\n${logOut.stdout.trim() || 'No commits yet'}\n\`\`\``;
  }

  if (uri === 'mcp://workspace/git-diff') {
    if (!ctx.workspaceRoot) {
      return 'Git diff requires a server or native workspace root.';
    }
    const staged = await runGitHelper(ctx.workspaceRoot, ['diff', '--cached']);
    const unstaged = await runGitHelper(ctx.workspaceRoot, ['diff']);
    const combined = [
      staged.stdout.trim() ? `# Staged Changes\n${staged.stdout.trim()}` : '',
      unstaged.stdout.trim() ? `# Working Tree Changes\n${unstaged.stdout.trim()}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    return (combined || 'No uncommitted Git diffs found.').slice(0, 18_000);
  }

  if (uri === 'mcp://workspace/symbols') {
    const syms = await collectSymbols(ctx, '', '', 160);
    if (syms.length === 0) return 'No top-level symbols indexed in workspace.';
    return syms
      .map((s) => `- \`${s.file}:${s.line}\` [${s.kind}] **${s.name}** — \`${s.signature}\``)
      .join('\n');
  }

  if (uri === 'mcp://workspace/structure') {
    const files = await collectWorkspaceFiles(ctx);
    const extCounts = new Map<string, number>();
    for (const f of files) {
      const ext = path.extname(f).toLowerCase() || '(no-ext)';
      extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1);
    }
    const breakdown = Array.from(extCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([ext, count]) => `${ext}: ${count}`)
      .join(', ');
    return `Total files: ${files.length}\nExtensions: ${breakdown || 'none'}\n\nFiles:\n${files.slice(0, 350).join('\n')}`;
  }

  if (uri === 'mcp://workspace/ide-session') {
    const openPaths = Object.keys(ctx.openBuffers ?? {});
    const term = (ctx.terminalEntries ?? []).slice(-6);
    const termBlock =
      term.length === 0
        ? 'No terminal commands run in this session yet.'
        : term
            .map(
              (t) =>
                `$ ${t.command} (cwd: ${t.cwd ?? '.'}, exit: ${t.exitCode})\n${(t.stdout + (t.stderr ? `\nSTDERR:\n${t.stderr}` : '')).trim().slice(0, 1500)}`
            )
            .join('\n\n---\n\n');
    return `Active File: ${ctx.activeFile ?? 'none'}\nOpen Tabs (${openPaths.length}): ${openPaths.join(', ') || 'none'}\n\n### Recent Terminal Output\n${termBlock}`;
  }

  throw new Error(`Unknown built-in MCP resource URI: ${uri}`);
}

async function callBuiltinTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: McpWorkspaceContext
): Promise<Record<string, unknown>> {
  if (toolName === 'git_inspect_diff') {
    if (!ctx.workspaceRoot) {
      return { error: 'Git repository inspection requires a server or native workspace.' };
    }
    const filePath = typeof args.file_path === 'string' ? args.file_path.trim() : '';
    const stagedOnly = Boolean(args.staged_only);
    const statusOut = await runGitHelper(ctx.workspaceRoot, ['status', '--short', '--branch']);
    if (statusOut.code !== 0) {
      return { isRepo: false, message: 'Workspace is not a Git repository.' };
    }
    const diffArgs = stagedOnly ? ['diff', '--cached'] : ['diff', 'HEAD'];
    if (filePath) diffArgs.push('--', filePath);
    let diffOut = await runGitHelper(ctx.workspaceRoot, diffArgs);
    if (diffOut.code !== 0 && !stagedOnly) {
      const fallbackArgs = ['diff'];
      if (filePath) fallbackArgs.push('--', filePath);
      diffOut = await runGitHelper(ctx.workspaceRoot, fallbackArgs);
    }
    return {
      isRepo: true,
      status: statusOut.stdout.trim(),
      diff: diffOut.stdout.slice(0, 16_000) || '(No diff output)',
    };
  }

  if (toolName === 'symbol_lookup') {
    const query = typeof args.query === 'string' ? args.query : '';
    const kind = typeof args.kind === 'string' ? args.kind : '';
    const symbols = await collectSymbols(ctx, query, kind, 100);
    return { count: symbols.length, symbols };
  }

  if (toolName === 'git_commit_log') {
    if (!ctx.workspaceRoot) {
      return { error: 'Git commit log requires a server or native workspace.' };
    }
    const limit = Math.max(1, Math.min(40, Number(args.limit ?? 15) || 15));
    const logOut = await runGitHelper(ctx.workspaceRoot, [
      'log',
      `-n`,
      String(limit),
      '--pretty=format:%h|%an|%ar|%s',
    ]);
    if (logOut.code !== 0) {
      return { commits: [], message: 'No Git commits found.' };
    }
    const commits = logOut.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [hash, author, relativeTime, ...rest] = line.split('|');
        return { hash, author, relativeTime, message: rest.join('|') };
      });
    return { count: commits.length, commits };
  }

  return { error: `Unknown built-in MCP tool: ${toolName}` };
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string; data?: unknown };
}

async function sendHttpJsonRpc(
  url: string,
  method: string,
  params?: Record<string, unknown>,
  sessionId?: string
): Promise<{ response: JsonRpcResponse; sessionId?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    const isNotification = method.startsWith('notifications/');
    const payload = isNotification
      ? { jsonrpc: '2.0', method, ...(params ? { params } : {}) }
      : { jsonrpc: '2.0', id: Date.now(), method, ...(params ? { params } : {}) };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const nextSession = res.headers.get('mcp-session-id') ?? sessionId;
    if (isNotification) {
      return { response: { jsonrpc: '2.0', result: {} }, sessionId: nextSession };
    }

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from MCP server`);
    }

    const ct = (res.headers.get('content-type') ?? '').toLowerCase();
    const raw = await res.text();
    if (ct.includes('text/event-stream')) {
      const dataLines = raw
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .filter(Boolean);
      for (let i = dataLines.length - 1; i >= 0; i--) {
        try {
          const parsed = JSON.parse(dataLines[i]) as JsonRpcResponse;
          if (parsed.result !== undefined || parsed.error !== undefined) {
            return { response: parsed, sessionId: nextSession };
          }
        } catch {
          // Continue scanning SSE events
        }
      }
      throw new Error('No JSON-RPC payload found in MCP SSE stream');
    }

    const parsed = JSON.parse(raw) as JsonRpcResponse;
    return { response: parsed, sessionId: nextSession };
  } finally {
    clearTimeout(timer);
  }
}

async function runStdioMcpSession<T>(
  command: string,
  args: string[],
  work: (
    request: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>
  ) => Promise<T>
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let nextId = 1;
    let stdoutBuf = '';
    let stderrBuf = '';
    const pending = new Map<
      number,
      { resolve: (val: Record<string, unknown>) => void; reject: (err: Error) => void }
    >();

    const cleanup = () => {
      try {
        child.kill('SIGTERM');
      } catch {
        // Ignore kill race
      }
    };

    const overallTimer = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error('STDIO MCP server timed out (12s)'));
      }
    }, 12_000);

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(overallTimer);
        reject(err);
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuf = (stderrBuf + chunk.toString('utf-8')).slice(-2000);
    });

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf-8');
      let idx = stdoutBuf.indexOf('\n');
      while (idx !== -1) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (line.startsWith('{')) {
          try {
            const msg = JSON.parse(line) as JsonRpcResponse;
            if (typeof msg.id === 'number' && pending.has(msg.id)) {
              const waiter = pending.get(msg.id)!;
              pending.delete(msg.id);
              if (msg.error) {
                waiter.reject(new Error(msg.error.message ?? 'MCP JSON-RPC error'));
              } else {
                waiter.resolve((msg.result as Record<string, unknown>) ?? {});
              }
            }
          } catch {
            // Ignore non-JSON stdout banners
          }
        }
        idx = stdoutBuf.indexOf('\n');
      }
    });

    child.on('close', (code) => {
      for (const [, waiter] of pending) {
        waiter.reject(
          new Error(
            `MCP process exited with code ${code ?? 1}${stderrBuf.trim() ? `: ${stderrBuf.trim().slice(0, 240)}` : ''}`
          )
        );
      }
      pending.clear();
    });

    const sendRpc = (
      method: string,
      params?: Record<string, unknown>
    ): Promise<Record<string, unknown>> => {
      if (method.startsWith('notifications/')) {
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })}\n`
        );
        return Promise.resolve({});
      }
      const id = nextId++;
      return new Promise((resRpc, rejRpc) => {
        pending.set(id, { resolve: resRpc, reject: rejRpc });
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`
        );
      });
    };

    (async () => {
      try {
        await sendRpc('initialize', {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { roots: { listChanged: false } },
          clientInfo: { name: 'aetheris-ide', version: '1.0.0' },
        });
        await sendRpc('notifications/initialized');
        const out = await work(sendRpc);
        if (!settled) {
          settled = true;
          clearTimeout(overallTimer);
          cleanup();
          resolve(out);
        }
      } catch (err) {
        if (!settled) {
          settled = true;
          clearTimeout(overallTimer);
          cleanup();
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    })();
  });
}

async function inspectExternalServer(cfg: McpServerConfig): Promise<McpServerSnapshot> {
  if (!cfg.enabled) {
    return {
      ...cfg,
      status: 'disabled',
      tools: [],
      resources: [],
      prompts: [],
    };
  }

  try {
    if (cfg.transport === 'http') {
      if (!cfg.url) throw new Error('HTTP MCP server URL is required.');
      const initRes = await sendHttpJsonRpc(cfg.url, 'initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'aetheris-ide', version: '1.0.0' },
      });
      if (initRes.response.error) {
        throw new Error(initRes.response.error.message ?? 'MCP initialize failed');
      }
      const sessionId = initRes.sessionId;
      await sendHttpJsonRpc(cfg.url, 'notifications/initialized', undefined, sessionId).catch(
        () => {}
      );

      const [toolsRes, resourcesRes, promptsRes] = await Promise.all([
        sendHttpJsonRpc(cfg.url, 'tools/list', {}, sessionId).catch(() => null),
        sendHttpJsonRpc(cfg.url, 'resources/list', {}, sessionId).catch(() => null),
        sendHttpJsonRpc(cfg.url, 'prompts/list', {}, sessionId).catch(() => null),
      ]);

      const rawTools = Array.isArray(toolsRes?.response.result?.tools)
        ? (toolsRes!.response.result!.tools as Array<Record<string, unknown>>)
        : [];
      const rawResources = Array.isArray(resourcesRes?.response.result?.resources)
        ? (resourcesRes!.response.result!.resources as Array<Record<string, unknown>>)
        : [];
      const rawPrompts = Array.isArray(promptsRes?.response.result?.prompts)
        ? (promptsRes!.response.result!.prompts as Array<Record<string, unknown>>)
        : [];

      return {
        ...cfg,
        status: 'connected',
        protocolVersion:
          typeof initRes.response.result?.protocolVersion === 'string'
            ? initRes.response.result.protocolVersion
            : MCP_PROTOCOL_VERSION,
        tools: rawTools.map((t) => ({
          serverId: cfg.id,
          serverName: cfg.name,
          name: String(t.name ?? ''),
          qualifiedName: buildQualifiedMcpToolName(cfg.id, String(t.name ?? '')),
          description: String(t.description ?? ''),
          inputSchema: (t.inputSchema as Record<string, unknown> | undefined) ?? {
            type: 'object',
            properties: {},
          },
        })),
        resources: rawResources.map((r) => ({
          serverId: cfg.id,
          serverName: cfg.name,
          uri: String(r.uri ?? ''),
          name: String(r.name ?? r.uri ?? ''),
          description: typeof r.description === 'string' ? r.description : undefined,
          mimeType: typeof r.mimeType === 'string' ? r.mimeType : undefined,
        })),
        prompts: rawPrompts.map((p) => ({
          serverId: cfg.id,
          serverName: cfg.name,
          name: String(p.name ?? ''),
          description: typeof p.description === 'string' ? p.description : undefined,
          arguments: Array.isArray(p.arguments)
            ? (p.arguments as McpPromptArgument[])
            : undefined,
        })),
      };
    }

    if (cfg.transport === 'stdio') {
      if (!cfg.command) throw new Error('STDIO command is required.');
      return await runStdioMcpSession(cfg.command, cfg.args ?? [], async (rpc) => {
        const [toolsRes, resourcesRes, promptsRes] = await Promise.all([
          rpc('tools/list', {}).catch((): Record<string, unknown> => ({})),
          rpc('resources/list', {}).catch((): Record<string, unknown> => ({})),
          rpc('prompts/list', {}).catch((): Record<string, unknown> => ({})),
        ]);
        const rawTools = Array.isArray(toolsRes.tools)
          ? (toolsRes.tools as Array<Record<string, unknown>>)
          : [];
        const rawResources = Array.isArray(resourcesRes.resources)
          ? (resourcesRes.resources as Array<Record<string, unknown>>)
          : [];
        const rawPrompts = Array.isArray(promptsRes.prompts)
          ? (promptsRes.prompts as Array<Record<string, unknown>>)
          : [];

        return {
          ...cfg,
          status: 'connected',
          protocolVersion: MCP_PROTOCOL_VERSION,
          tools: rawTools.map((t) => ({
            serverId: cfg.id,
            serverName: cfg.name,
            name: String(t.name ?? ''),
            qualifiedName: buildQualifiedMcpToolName(cfg.id, String(t.name ?? '')),
            description: String(t.description ?? ''),
            inputSchema: (t.inputSchema as Record<string, unknown> | undefined) ?? {
              type: 'object',
              properties: {},
            },
          })),
          resources: rawResources.map((r) => ({
            serverId: cfg.id,
            serverName: cfg.name,
            uri: String(r.uri ?? ''),
            name: String(r.name ?? r.uri ?? ''),
            description: typeof r.description === 'string' ? r.description : undefined,
            mimeType: typeof r.mimeType === 'string' ? r.mimeType : undefined,
          })),
          prompts: rawPrompts.map((p) => ({
            serverId: cfg.id,
            serverName: cfg.name,
            name: String(p.name ?? ''),
            description: typeof p.description === 'string' ? p.description : undefined,
            arguments: Array.isArray(p.arguments)
              ? (p.arguments as McpPromptArgument[])
              : undefined,
          })),
        };
      });
    }

    throw new Error(`Unsupported transport: ${cfg.transport}`);
  } catch (err) {
    return {
      ...cfg,
      status: 'error',
      error: err instanceof Error ? err.message : 'Connection failed',
      tools: [],
      resources: [],
      prompts: [],
    };
  }
}

export class McpHostManager {
  private configs: McpServerConfig[] = [{ ...BUILTIN_SERVER }];
  private loaded = false;

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await fs.readFile(MCP_CONFIG_PATH, 'utf-8');
      const parsed = JSON.parse(raw) as McpServerConfig[];
      if (Array.isArray(parsed)) {
        const builtinSaved = parsed.find((s) => s.id === BUILTIN_SERVER.id);
        const externals = parsed.filter(
          (s) => s.id !== BUILTIN_SERVER.id && (s.transport === 'http' || s.transport === 'stdio')
        );
        this.configs = [
          {
            ...BUILTIN_SERVER,
            enabled: builtinSaved ? Boolean(builtinSaved.enabled) : true,
          },
          ...externals,
        ];
      }
    } catch {
      this.configs = [{ ...BUILTIN_SERVER }];
    }
  }

  private async persist(): Promise<void> {
    try {
      await fs.writeFile(MCP_CONFIG_PATH, JSON.stringify(this.configs, null, 2), 'utf-8');
    } catch {
      // Ignore write error in read-only sandboxes
    }
  }

  async listSnapshots(): Promise<McpServerSnapshot[]> {
    await this.ensureLoaded();
    return Promise.all(
      this.configs.map(async (cfg) => {
        if (cfg.transport === 'builtin') {
          if (!cfg.enabled) {
            return {
              ...cfg,
              status: 'disabled',
              tools: [],
              resources: [],
              prompts: [],
            };
          }
          return {
            ...cfg,
            status: 'connected',
            protocolVersion: MCP_PROTOCOL_VERSION,
            tools: getBuiltinTools(),
            resources: getBuiltinResources(),
            prompts: getBuiltinPrompts(),
          };
        }
        return inspectExternalServer(cfg);
      })
    );
  }

  async upsertServer(input: Partial<McpServerConfig> & { name: string; transport: McpTransportType }): Promise<McpServerSnapshot[]> {
    await this.ensureLoaded();
    if (input.id === BUILTIN_SERVER.id || input.transport === 'builtin') {
      this.configs = this.configs.map((c) =>
        c.id === BUILTIN_SERVER.id ? { ...c, enabled: Boolean(input.enabled ?? c.enabled) } : c
      );
      await this.persist();
      return this.listSnapshots();
    }

    const id =
      (input.id ?? '')
        .trim()
        .replace(/[^a-zA-Z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '') ||
      `${input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'mcp'}-${Date.now().toString(36).slice(-4)}`;

    const nextCfg: McpServerConfig = {
      id,
      name: input.name.trim(),
      transport: input.transport,
      enabled: input.enabled ?? true,
      description: input.description?.trim() || undefined,
      command: input.transport === 'stdio' ? input.command?.trim() : undefined,
      args: input.transport === 'stdio' ? (input.args ?? []) : undefined,
      url: input.transport === 'http' ? input.url?.trim() : undefined,
    };

    const existingIdx = this.configs.findIndex((c) => c.id === id);
    if (existingIdx >= 0) {
      this.configs[existingIdx] = nextCfg;
    } else {
      this.configs.push(nextCfg);
    }
    await this.persist();
    return this.listSnapshots();
  }

  async setServerEnabled(id: string, enabled: boolean): Promise<McpServerSnapshot[]> {
    await this.ensureLoaded();
    this.configs = this.configs.map((c) => (c.id === id ? { ...c, enabled } : c));
    await this.persist();
    return this.listSnapshots();
  }

  async removeServer(id: string): Promise<McpServerSnapshot[]> {
    await this.ensureLoaded();
    if (id === BUILTIN_SERVER.id) {
      throw new Error('The built-in Workspace MCP server cannot be deleted (toggle it off instead).');
    }
    this.configs = this.configs.filter((c) => c.id !== id);
    await this.persist();
    return this.listSnapshots();
  }

  async getEnabledTools(): Promise<McpToolInfo[]> {
    const snapshots = await this.listSnapshots();
    return snapshots.filter((s) => s.status === 'connected').flatMap((s) => s.tools);
  }

  async readResource(
    serverId: string,
    uri: string,
    ctx: McpWorkspaceContext
  ): Promise<{ uri: string; mimeType: string; text: string }> {
    await this.ensureLoaded();
    const cfg = this.configs.find((c) => c.id === serverId);
    if (!cfg) throw new Error(`MCP server "${serverId}" not found.`);

    if (cfg.transport === 'builtin') {
      const text = await readBuiltinResource(uri, ctx);
      return { uri, mimeType: 'text/markdown', text };
    }

    if (cfg.transport === 'http' && cfg.url) {
      const init = await sendHttpJsonRpc(cfg.url, 'initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'aetheris-ide', version: '1.0.0' },
      });
      const res = await sendHttpJsonRpc(cfg.url, 'resources/read', { uri }, init.sessionId);
      if (res.response.error) throw new Error(res.response.error.message ?? 'MCP resource read failed');
      const contents = Array.isArray(res.response.result?.contents)
        ? (res.response.result!.contents as Array<{ text?: string; mimeType?: string }>)
        : [];
      const combined = contents.map((c) => c.text ?? '').join('\n');
      return {
        uri,
        mimeType: contents[0]?.mimeType ?? 'text/plain',
        text: combined.slice(0, 20_000),
      };
    }

    if (cfg.transport === 'stdio' && cfg.command) {
      return runStdioMcpSession(cfg.command, cfg.args ?? [], async (rpc) => {
        const res = await rpc('resources/read', { uri });
        const contents = Array.isArray(res.contents)
          ? (res.contents as Array<{ text?: string; mimeType?: string }>)
          : [];
        return {
          uri,
          mimeType: contents[0]?.mimeType ?? 'text/plain',
          text: contents.map((c) => c.text ?? '').join('\n').slice(0, 20_000),
        };
      });
    }

    throw new Error(`MCP server "${serverId}" is misconfigured.`);
  }

  async resolvePromptTemplate(
    serverId: string,
    promptName: string,
    args: Record<string, string>,
    ctx: McpWorkspaceContext
  ): Promise<{ promptText: string; recommendedResources: Array<{ serverId: string; uri: string; label: string }> }> {
    await this.ensureLoaded();
    const cfg = this.configs.find((c) => c.id === serverId);
    if (!cfg) throw new Error(`MCP server "${serverId}" not found.`);

    if (cfg.transport === 'builtin') {
      if (promptName === 'review-changes') {
        const focus = args.focus ? ` Focus especially on ${args.focus}.` : '';
        return {
          promptText: `Review the uncommitted Git changes in this workspace using the attached MCP Git status and diff context. Identify potential bugs, missing edge cases, or regressions.${focus}`,
          recommendedResources: [
            { serverId: BUILTIN_SERVER.id, uri: 'mcp://workspace/git-status', label: 'Git Repository Status' },
            { serverId: BUILTIN_SERVER.id, uri: 'mcp://workspace/git-diff', label: 'Uncommitted Git Diff' },
          ],
        };
      }
      if (promptName === 'debug-terminal') {
        return {
          promptText:
            'Inspect the attached IDE session and recent terminal command outputs/errors, identify the root cause of any failure, and propose the minimal fix.',
          recommendedResources: [
            {
              serverId: BUILTIN_SERVER.id,
              uri: 'mcp://workspace/ide-session',
              label: 'Active Editor & Terminal Context',
            },
          ],
        };
      }
      return {
        promptText:
          'Using the attached workspace directory tree and symbol index, provide a concise architectural overview of modules, entry points, and data flow.',
        recommendedResources: [
          { serverId: BUILTIN_SERVER.id, uri: 'mcp://workspace/structure', label: 'Directory Tree & Manifest' },
          { serverId: BUILTIN_SERVER.id, uri: 'mcp://workspace/symbols', label: 'Workspace Symbol Index' },
        ],
      };
    }

    if (cfg.transport === 'http' && cfg.url) {
      const init = await sendHttpJsonRpc(cfg.url, 'initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'aetheris-ide', version: '1.0.0' },
      });
      const res = await sendHttpJsonRpc(
        cfg.url,
        'prompts/get',
        { name: promptName, arguments: args },
        init.sessionId
      );
      const msgs = Array.isArray(res.response.result?.messages)
        ? (res.response.result!.messages as Array<{ content?: { text?: string } | string }>)
        : [];
      const text = msgs
        .map((m) => (typeof m.content === 'string' ? m.content : m.content?.text ?? ''))
        .filter(Boolean)
        .join('\n\n');
      return { promptText: text || `Run MCP prompt: ${promptName}`, recommendedResources: [] };
    }

    if (cfg.transport === 'stdio' && cfg.command) {
      return runStdioMcpSession(cfg.command, cfg.args ?? [], async (rpc) => {
        const res = await rpc('prompts/get', { name: promptName, arguments: args });
        const msgs = Array.isArray(res.messages)
          ? (res.messages as Array<{ content?: { text?: string } | string }>)
          : [];
        const text = msgs
          .map((m) => (typeof m.content === 'string' ? m.content : m.content?.text ?? ''))
          .filter(Boolean)
          .join('\n\n');
        return {
          promptText: text || `Run MCP prompt: ${promptName}`,
          recommendedResources: [],
        };
      });
    }

    return { promptText: `Run MCP prompt ${promptName}`, recommendedResources: [] };
  }

  async callToolByQualifiedName(
    qualifiedName: string,
    args: Record<string, unknown>,
    ctx: McpWorkspaceContext
  ): Promise<{ serverName: string; toolName: string; output: Record<string, unknown> } | null> {
    const enabledTools = await this.getEnabledTools();
    const match = enabledTools.find((t) => t.qualifiedName === qualifiedName);
    if (!match) return null;

    const cfg = this.configs.find((c) => c.id === match.serverId);
    if (!cfg || !cfg.enabled) return null;

    if (cfg.transport === 'builtin') {
      const output = await callBuiltinTool(match.name, args, ctx);
      return { serverName: cfg.name, toolName: match.name, output };
    }

    if (cfg.transport === 'http' && cfg.url) {
      const init = await sendHttpJsonRpc(cfg.url, 'initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'aetheris-ide', version: '1.0.0' },
      });
      const res = await sendHttpJsonRpc(
        cfg.url,
        'tools/call',
        { name: match.name, arguments: args },
        init.sessionId
      );
      if (res.response.error) {
        return {
          serverName: cfg.name,
          toolName: match.name,
          output: { error: res.response.error.message ?? 'MCP tool call failed' },
        };
      }
      return {
        serverName: cfg.name,
        toolName: match.name,
        output: (res.response.result as Record<string, unknown>) ?? {},
      };
    }

    if (cfg.transport === 'stdio' && cfg.command) {
      const result = await runStdioMcpSession(cfg.command, cfg.args ?? [], async (rpc) => {
        return rpc('tools/call', { name: match.name, arguments: args });
      });
      return { serverName: cfg.name, toolName: match.name, output: result };
    }

    return null;
  }

  async handleJsonRpcEndpoint(
    body: { jsonrpc?: string; id?: number | string | null; method?: string; params?: Record<string, unknown> },
    defaultCtx: McpWorkspaceContext
  ): Promise<Record<string, unknown> | null> {
    const id = body.id ?? null;
    const method = body.method ?? '';

    if (method === 'notifications/initialized') {
      return null;
    }

    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {
            tools: { listChanged: false },
            resources: { subscribe: false, listChanged: false },
            prompts: { listChanged: false },
          },
          serverInfo: {
            name: 'aetheris-workspace-mcp',
            version: '1.0.0',
          },
        },
      };
    }

    if (method === 'ping') {
      return { jsonrpc: '2.0', id, result: {} };
    }

    if (method === 'tools/list') {
      const tools = getBuiltinTools().map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
      }));
      return { jsonrpc: '2.0', id, result: { tools } };
    }

    if (method === 'tools/call') {
      const toolName = String(body.params?.name ?? '');
      const toolArgs = (body.params?.arguments as Record<string, unknown>) ?? {};
      const out = await callBuiltinTool(toolName, toolArgs, defaultCtx);
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
          isError: Boolean(out.error),
        },
      };
    }

    if (method === 'resources/list') {
      const resources = getBuiltinResources().map((r) => ({
        uri: r.uri,
        name: r.name,
        description: r.description,
        mimeType: r.mimeType,
      }));
      return { jsonrpc: '2.0', id, result: { resources } };
    }

    if (method === 'resources/read') {
      const uri = String(body.params?.uri ?? '');
      try {
        const text = await readBuiltinResource(uri, defaultCtx);
        return {
          jsonrpc: '2.0',
          id,
          result: {
            contents: [{ uri, mimeType: 'text/markdown', text }],
          },
        };
      } catch (err) {
        return {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32602,
            message: err instanceof Error ? err.message : 'Resource not found',
          },
        };
      }
    }

    if (method === 'prompts/list') {
      const prompts = getBuiltinPrompts().map((p) => ({
        name: p.name,
        description: p.description,
        arguments: p.arguments ?? [],
      }));
      return { jsonrpc: '2.0', id, result: { prompts } };
    }

    if (method === 'prompts/get') {
      const name = String(body.params?.name ?? '');
      const promptArgs = (body.params?.arguments as Record<string, string>) ?? {};
      const resolved = await this.resolvePromptTemplate(
        BUILTIN_SERVER.id,
        name,
        promptArgs,
        defaultCtx
      );
      return {
        jsonrpc: '2.0',
        id,
        result: {
          description: `Aetheris MCP Prompt: ${name}`,
          messages: [
            {
              role: 'user',
              content: { type: 'text', text: resolved.promptText },
            },
          ],
        },
      };
    }

    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    };
  }
}

export function mcpToolToGeminiDeclaration(tool: McpToolInfo): FunctionDeclaration {
  const convertSchema = (raw?: Record<string, unknown>): Schema => {
    if (!raw || typeof raw !== 'object') {
      return { type: Type.OBJECT, properties: {} };
    }
    const rawType = String(raw.type ?? 'object').toLowerCase();
    if (rawType === 'string') {
      return {
        type: Type.STRING,
        description: typeof raw.description === 'string' ? raw.description : undefined,
      };
    }
    if (rawType === 'integer') {
      return {
        type: Type.INTEGER,
        description: typeof raw.description === 'string' ? raw.description : undefined,
      };
    }
    if (rawType === 'number') {
      return {
        type: Type.NUMBER,
        description: typeof raw.description === 'string' ? raw.description : undefined,
      };
    }
    if (rawType === 'boolean') {
      return {
        type: Type.BOOLEAN,
        description: typeof raw.description === 'string' ? raw.description : undefined,
      };
    }
    if (rawType === 'array') {
      return {
        type: Type.ARRAY,
        description: typeof raw.description === 'string' ? raw.description : undefined,
        items: convertSchema((raw.items as Record<string, unknown> | undefined) ?? { type: 'string' }),
      };
    }

    const propsRaw = (raw.properties as Record<string, Record<string, unknown>> | undefined) ?? {};
    const convertedProps: Record<string, Schema> = {};
    for (const [k, v] of Object.entries(propsRaw)) {
      convertedProps[k] = convertSchema(v);
    }
    const req = Array.isArray(raw.required)
      ? (raw.required.filter((x) => typeof x === 'string') as string[])
      : undefined;

    return {
      type: Type.OBJECT,
      description: typeof raw.description === 'string' ? raw.description : undefined,
      properties: convertedProps,
      ...(req && req.length > 0 ? { required: req } : {}),
    };
  };

  return {
    name: tool.qualifiedName,
    description: `[MCP: ${tool.serverName}] ${tool.description || tool.name}`,
    parameters: convertSchema(tool.inputSchema),
  };
}

export function mcpToolToOpenAiSchema(tool: McpToolInfo): {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
} {
  return {
    type: 'function',
    function: {
      name: tool.qualifiedName,
      description: `[MCP: ${tool.serverName}] ${tool.description || tool.name}`,
      parameters:
        tool.inputSchema && typeof tool.inputSchema === 'object'
          ? tool.inputSchema
          : { type: 'object', properties: {} },
    },
  };
}

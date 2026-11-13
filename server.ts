import 'dotenv/config';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;
const WORKSPACES_ROOT = '/tmp/aetheris-workspaces';

interface StarterTemplate {
  id: string;
  name: string;
  description: string;
  language: string;
  files: Record<string, string>;
}

const STARTER_TEMPLATES: StarterTemplate[] = [
  {
    id: 'rust-cli-indexer',
    name: 'rust-cli-indexer',
    description: 'Fast parallel Rust workspace symbol scanner and CLI utility',
    language: 'Rust',
    files: {
      'Cargo.toml': `[package]
name = "rust-cli-indexer"
version = "0.1.0"
edition = "2021"

[dependencies]
clap = "4.5"
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
`,
      'src/main.rs': `mod scanner;
mod models;

use models::ScanConfig;
use scanner::scan_directory;

fn main() {
    let config = ScanConfig {
        root: String::from("./src"),
        symbols_only: true,
        max_results: 100,
    };

    println!("Indexing workspace at {}", config.root);
    let hits = scan_directory(&config);
    for hit in hits {
        println!("[{}:{}] {} {}", hit.file, hit.line, hit.kind, hit.name);
    }
}
`,
      'src/models.rs': `use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanConfig {
    pub root: String,
    pub symbols_only: bool,
    pub max_results: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SymbolHit {
    pub file: String,
    pub line: usize,
    pub kind: String,
    pub name: String,
}
`,
      'src/scanner.rs': `use crate::models::{ScanConfig, SymbolHit};

pub fn extract_symbol(line: &str) -> Option<(String, String)> {
    let trimmed = line.trim();
    for prefix in ["pub fn ", "fn ", "pub struct ", "struct ", "pub enum ", "enum "] {
        if let Some(rest) = trimmed.strip_prefix(prefix) {
            let name: String = rest
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '_')
                .collect();
            if !name.is_empty() {
                let kind = prefix.trim().replace("pub ", "");
                return Some((kind, name));
            }
        }
    }
    None
}

pub fn scan_directory(config: &ScanConfig) -> Vec<SymbolHit> {
    let sample = [
        ("src/main.rs", 6, "fn main() {"),
        ("src/models.rs", 4, "pub struct ScanConfig {"),
        ("src/models.rs", 11, "pub struct SymbolHit {"),
        ("src/scanner.rs", 3, "pub fn extract_symbol(line: &str)"),
    ];

    sample
        .iter()
        .take(config.max_results)
        .filter_map(|(file, line, src)| {
            extract_symbol(src).map(|(kind, name)| SymbolHit {
                file: (*file).to_string(),
                line: *line,
                kind,
                name,
            })
        })
        .collect()
}
`,
      'README.md': `# rust-cli-indexer

Lightweight Rust symbol scanner starter project.

## Commands
- Inspect source files or ask the Aetheris Agent to add multi-threaded file walking, regex support, or JSON output flags.
`,
    },
  },
  {
    id: 'ts-edge-gateway',
    name: 'ts-edge-gateway',
    description: 'Zero-dependency TypeScript HTTP router and rate limiter',
    language: 'TypeScript',
    files: {
      'package.json': `{
  "name": "ts-edge-gateway",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "start": "node src/index.mjs"
  }
}
`,
      'src/router.ts': `export interface RouteContext {
  method: string;
  path: string;
  headers: Record<string, string>;
}

export interface RouteResponse {
  status: number;
  body: unknown;
}

export type RouteHandler = (ctx: RouteContext) => Promise<RouteResponse> | RouteResponse;

export class EdgeRouter {
  private routes = new Map<string, RouteHandler>();

  register(method: string, path: string, handler: RouteHandler): void {
    this.routes.set(\`\${method.toUpperCase()}:\${path}\`, handler);
  }

  async dispatch(ctx: RouteContext): Promise<RouteResponse> {
    const key = \`\${ctx.method.toUpperCase()}:\${ctx.path}\`;
    const handler = this.routes.get(key);
    if (!handler) {
      return { status: 404, body: { error: 'Route not found', path: ctx.path } };
    }
    return handler(ctx);
  }
}
`,
      'src/rateLimiter.ts': `export interface BucketState {
  tokens: number;
  lastRefillMs: number;
}

export class TokenBucketLimiter {
  private buckets = new Map<string, BucketState>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number
  ) {}

  allow(clientKey: string, nowMs = Date.now()): boolean {
    const existing = this.buckets.get(clientKey) ?? {
      tokens: this.capacity,
      lastRefillMs: nowMs,
    };

    const elapsedSec = Math.max(0, (nowMs - existing.lastRefillMs) / 1000);
    const replenished = Math.min(
      this.capacity,
      existing.tokens + elapsedSec * this.refillPerSecond
    );

    if (replenished < 1) {
      this.buckets.set(clientKey, { tokens: replenished, lastRefillMs: nowMs });
      return false;
    }

    this.buckets.set(clientKey, {
      tokens: replenished - 1,
      lastRefillMs: nowMs,
    });
    return true;
  }
}
`,
      'src/index.ts': `import { EdgeRouter } from './router';
import { TokenBucketLimiter } from './rateLimiter';

const router = new EdgeRouter();
const limiter = new TokenBucketLimiter(10, 2);

router.register('GET', '/health', () => ({
  status: 200,
  body: { ok: true, service: 'ts-edge-gateway' },
}));

export async function handleRequest(ip: string, method: string, path: string) {
  if (!limiter.allow(ip)) {
    return { status: 429, body: { error: 'Rate limit exceeded' } };
  }
  return router.dispatch({ method, path, headers: {} });
}
`,
    },
  },
];

async function ensureStartersSeeded(): Promise<void> {
  await fs.mkdir(WORKSPACES_ROOT, { recursive: true });
  for (const tpl of STARTER_TEMPLATES) {
    const dir = path.join(WORKSPACES_ROOT, tpl.id);
    try {
      await fs.access(dir);
    } catch {
      await fs.mkdir(dir, { recursive: true });
      for (const [relPath, content] of Object.entries(tpl.files)) {
        const target = path.join(dir, relPath);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content, 'utf-8');
      }
    }
  }
}

function resolveSafeWorkspacePath(workspaceId: string, relPath = ''): { root: string; target: string } {
  if (!/^[a-zA-Z0-9_-]+$/.test(workspaceId)) {
    throw new Error('Invalid workspace identifier');
  }
  const root = path.resolve(WORKSPACES_ROOT, workspaceId);
  const target = path.resolve(root, relPath);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error('Path traversal outside workspace is prohibited');
  }
  return { root, target };
}

interface TreeNode {
  name: string;
  path: string;
  kind: 'file' | 'dir';
  children?: TreeNode[];
}

async function buildFileTree(dir: string, root: string): Promise<TreeNode[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const dirs: TreeNode[] = [];
  const files: TreeNode[] = [];

  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'target' || entry.name === '.git' || entry.name === 'dist') {
      continue;
    }
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full).split(path.sep).join('/');
    if (entry.isDirectory()) {
      const children = await buildFileTree(full, root);
      dirs.push({ name: entry.name, path: rel, kind: 'dir', children });
    } else {
      files.push({ name: entry.name, path: rel, kind: 'file' });
    }
  }

  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  return [...dirs, ...files];
}

const SYMBOL_REGEX =
  /^\s*(?:pub\s+)?(?:async\s+)?(?:export\s+)?(?:default\s+)?(fn|struct|enum|trait|impl|function|class|interface|type|const|def)\s+([A-Za-z_][A-Za-z0-9_]*)/;

async function searchDirectory(
  dir: string,
  root: string,
  query: string,
  symbolsOnly: boolean,
  hits: Array<{ filePath: string; line: number; preview: string; symbolKind: string | null; symbolName: string | null }>
): Promise<void> {
  if (hits.length >= 150) return;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const qLower = query.trim().toLowerCase();

  for (const entry of entries) {
    if (hits.length >= 150) return;
    if (entry.name === 'node_modules' || entry.name === 'target' || entry.name === '.git' || entry.name === 'dist') {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await searchDirectory(full, root, query, symbolsOnly, hits);
      continue;
    }

    let content = '';
    try {
      content = await fs.readFile(full, 'utf-8');
    } catch {
      continue;
    }

    const rel = path.relative(root, full).split(path.sep).join('/');
    const lines = content.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      if (hits.length >= 150) return;
      const lineText = lines[i];
      const match = SYMBOL_REGEX.exec(lineText);
      if (match) {
        const [, kind, name] = match;
        const matchesQuery =
          !qLower ||
          name.toLowerCase().includes(qLower) ||
          lineText.toLowerCase().includes(qLower);
        if (matchesQuery) {
          hits.push({
            filePath: rel,
            line: i + 1,
            preview: lineText.trim().slice(0, 140),
            symbolKind: kind,
            symbolName: name,
          });
        }
      } else if (!symbolsOnly && qLower && lineText.toLowerCase().includes(qLower)) {
        hits.push({
          filePath: rel,
          line: i + 1,
          preview: lineText.trim().slice(0, 140),
          symbolKind: null,
          symbolName: null,
        });
      }
    }
  }
}

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured in the server environment.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function runGit(
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
        maxBuffer: 8 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as { code?: unknown }).code === 'number'
            ? ((err as { code: number }).code)
            : err
              ? 1
              : 0;
        resolve({
          code,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
        });
      }
    );
  });
}

function mapGitCode(ch: string): 'M' | 'A' | 'D' | 'R' | 'U' | 'C' {
  if (ch === 'A') return 'A';
  if (ch === 'D') return 'D';
  if (ch === 'R') return 'R';
  if (ch === 'U') return 'C';
  if (ch === '?') return 'U';
  return 'M';
}

async function getGitStatusSnapshot(root: string) {
  const inside = await runGit(root, ['rev-parse', '--is-inside-work-tree']);
  const ghCheck = await new Promise<boolean>((resolve) => {
    execFile('gh', ['--version'], (err) => resolve(!err));
  });

  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    const uName = (await runGit(root, ['config', 'user.name'])).stdout.trim() || null;
    const uEmail = (await runGit(root, ['config', 'user.email'])).stdout.trim() || null;
    return {
      isRepo: false,
      branch: '',
      branches: [] as string[],
      remoteUrl: null as string | null,
      ahead: 0,
      behind: 0,
      hasUpstream: false,
      staged: [],
      changes: [],
      unpushedFiles: [] as string[],
      pushedFiles: [] as string[],
      commits: [],
      userName: uName,
      userEmail: uEmail,
      ghAvailable: ghCheck,
    };
  }

  const statusRes = await runGit(root, ['status', '--porcelain=v1', '-b', '-uall']);
  const lines = statusRes.stdout.split(/\r?\n/).filter((l) => l.length > 0);
  let branch = 'main';
  const staged: Array<{ path: string; status: 'M' | 'A' | 'D' | 'R' | 'U' | 'C'; staged: boolean }> = [];
  const changes: Array<{ path: string; status: 'M' | 'A' | 'D' | 'R' | 'U' | 'C'; staged: boolean }> = [];

  for (const line of lines) {
    if (line.startsWith('## ')) {
      const header = line.slice(3).trim();
      if (header.startsWith('No commits yet on ')) {
        branch = header.replace('No commits yet on ', '').trim();
      } else {
        const dotIdx = header.indexOf('...');
        const spaceIdx = header.indexOf(' ');
        if (dotIdx !== -1) {
          branch = header.slice(0, dotIdx).trim();
        } else if (spaceIdx !== -1) {
          branch = header.slice(0, spaceIdx).trim();
        } else {
          branch = header;
        }
      }
      continue;
    }

    if (line.length < 4) continue;
    const x = line[0];
    const y = line[1];
    let filePath = line.slice(3).trim();
    if (filePath.includes(' -> ')) {
      filePath = filePath.split(' -> ').pop()!.trim();
    }
    if (filePath.startsWith('"') && filePath.endsWith('"')) {
      filePath = filePath.slice(1, -1);
    }

    if (x === '?' && y === '?') {
      changes.push({ path: filePath, status: 'U', staged: false });
      continue;
    }

    if (x !== ' ') {
      staged.push({
        path: filePath,
        status: mapGitCode(x),
        staged: true,
      });
    }
    if (y !== ' ') {
      changes.push({
        path: filePath,
        status: mapGitCode(y),
        staged: false,
      });
    }
  }

  const branchRes = await runGit(root, ['branch', '--format=%(refname:short)']);
  const branches = branchRes.stdout
    .split(/\r?\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  if (branch && !branches.includes(branch)) {
    branches.unshift(branch);
  }

  const remoteRes = await runGit(root, ['remote', 'get-url', 'origin']);
  const remoteUrl = remoteRes.code === 0 ? remoteRes.stdout.trim() || null : null;

  const upstreamRes = await runGit(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  let upstreamRef = upstreamRes.code === 0 ? upstreamRes.stdout.trim() : '';
  if (!upstreamRef && branch && remoteUrl) {
    const originBranchCheck = await runGit(root, ['rev-parse', '--verify', `origin/${branch}`]);
    if (originBranchCheck.code === 0) {
      upstreamRef = `origin/${branch}`;
    }
  }

  const hasUpstream = Boolean(upstreamRef);
  let ahead = 0;
  let behind = 0;
  const unpushedSet = new Set<string>();
  const unpushedHashes = new Set<string>();

  if (upstreamRef) {
    const countRes = await runGit(root, ['rev-list', '--left-right', '--count', `${upstreamRef}...HEAD`]);
    if (countRes.code === 0) {
      const parts = countRes.stdout.trim().split(/\s+/);
      behind = Number(parts[0] ?? 0) || 0;
      ahead = Number(parts[1] ?? 0) || 0;
    }

    const diffRes = await runGit(root, ['diff', '--name-only', `${upstreamRef}..HEAD`]);
    if (diffRes.code === 0) {
      for (const f of diffRes.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
        unpushedSet.add(f);
      }
    }

    const revRes = await runGit(root, ['rev-list', `${upstreamRef}..HEAD`]);
    if (revRes.code === 0) {
      for (const h of revRes.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
        unpushedHashes.add(h);
      }
    }
  }

  const trackedRes = await runGit(root, ['ls-files']);
  const trackedFiles = trackedRes.code === 0
    ? trackedRes.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    : [];

  const dirtySet = new Set<string>([
    ...staged.map((s) => s.path),
    ...changes.map((c) => c.path),
  ]);

  if (!hasUpstream) {
    for (const f of trackedFiles) {
      if (!dirtySet.has(f)) {
        unpushedSet.add(f);
      }
    }
  }

  const pushedFiles = hasUpstream
    ? trackedFiles.filter((f) => !dirtySet.has(f) && !unpushedSet.has(f))
    : [];

  const logRes = await runGit(root, [
    'log',
    '-n',
    '15',
    '--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%ar',
  ]);
  const commits =
    logRes.code === 0
      ? logRes.stdout
          .split(/\r?\n/)
          .filter(Boolean)
          .map((row) => {
            const [hash = '', shortHash = '', message = '', author = '', relativeTime = ''] =
              row.split('\x1f');
            return {
              hash,
              shortHash,
              message,
              author,
              relativeTime,
              pushed: hasUpstream ? !unpushedHashes.has(hash) : false,
            };
          })
      : [];

  if (!hasUpstream && commits.length > 0) {
    ahead = commits.length;
  }

  const uName = (await runGit(root, ['config', 'user.name'])).stdout.trim() || null;
  const uEmail = (await runGit(root, ['config', 'user.email'])).stdout.trim() || null;

  return {
    isRepo: true,
    branch,
    branches,
    remoteUrl,
    ahead,
    behind,
    hasUpstream,
    staged,
    changes,
    unpushedFiles: Array.from(unpushedSet),
    pushedFiles,
    commits,
    userName: uName,
    userEmail: uEmail,
    ghAvailable: ghCheck,
  };
}

async function startServer() {
  await ensureStartersSeeded();

  const app = express();
  app.use(express.json({ limit: '8mb' }));

  app.get('/api/workspaces', async (_req, res) => {
    try {
      const entries = await fs.readdir(WORKSPACES_ROOT, { withFileTypes: true });
      const starterMap = new Map(STARTER_TEMPLATES.map((t) => [t.id, t]));
      const list = entries
        .filter((e) => e.isDirectory())
        .map((e) => {
          const tpl = starterMap.get(e.name);
          if (tpl) {
            return {
              id: tpl.id,
              name: tpl.name,
              description: tpl.description,
              language: tpl.language,
            };
          }
          return {
            id: e.name,
            name: e.name,
            description: 'Custom workspace folder',
            language: 'Folder',
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      res.json({ workspaces: list });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to list workspaces' });
    }
  });

  app.post('/api/workspaces', async (req, res) => {
    try {
      const { name, template } = req.body as {
        name?: string;
        template?: 'blank' | 'rust' | 'typescript';
      };
      const slug = (name ?? '')
        .trim()
        .replace(/[^a-zA-Z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '');
      if (!slug) {
        res.status(400).json({ error: 'Folder name must contain letters or numbers.' });
        return;
      }

      const { root } = resolveSafeWorkspacePath(slug);
      await fs.mkdir(root, { recursive: true });

      if (template === 'rust') {
        await fs.mkdir(path.join(root, 'src'), { recursive: true });
        await fs.writeFile(
          path.join(root, 'Cargo.toml'),
          `[package]\nname = "${slug}"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n`,
          'utf-8'
        );
        await fs.writeFile(
          path.join(root, 'src', 'main.rs'),
          `fn main() {\n    println!("Hello from ${slug}");\n}\n`,
          'utf-8'
        );
      } else if (template === 'typescript') {
        await fs.mkdir(path.join(root, 'src'), { recursive: true });
        await fs.writeFile(
          path.join(root, 'package.json'),
          `{\n  "name": "${slug}",\n  "version": "0.1.0",\n  "type": "module"\n}\n`,
          'utf-8'
        );
        await fs.writeFile(
          path.join(root, 'src', 'index.ts'),
          `export function main(): void {\n  console.log("Hello from ${slug}");\n}\n\nmain();\n`,
          'utf-8'
        );
      } else {
        await fs.writeFile(
          path.join(root, 'README.md'),
          `# ${slug}\n\nWorkspace created in Aetheris.\n`,
          'utf-8'
        );
      }

      res.json({
        workspace: {
          id: slug,
          name: slug,
          description: 'Custom workspace folder',
          language: template === 'rust' ? 'Rust' : template === 'typescript' ? 'TypeScript' : 'Folder',
        },
      });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create folder' });
    }
  });

  app.get('/api/workspaces/:id/tree', async (req, res) => {
    try {
      const { root } = resolveSafeWorkspacePath(req.params.id);
      const tree = await buildFileTree(root, root);
      res.json({ tree });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to list tree' });
    }
  });

  app.post('/api/workspaces/:id/reset', async (req, res) => {
    try {
      const tpl = STARTER_TEMPLATES.find((t) => t.id === req.params.id);
      if (!tpl) {
        res.status(404).json({ error: 'Starter workspace not found' });
        return;
      }
      const { root } = resolveSafeWorkspacePath(req.params.id);
      await fs.rm(root, { recursive: true, force: true });
      await fs.mkdir(root, { recursive: true });
      for (const [relPath, content] of Object.entries(tpl.files)) {
        const target = path.join(root, relPath);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content, 'utf-8');
      }
      const tree = await buildFileTree(root, root);
      res.json({ tree });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Reset failed' });
    }
  });

  app.get('/api/workspaces/:id/file', async (req, res) => {
    try {
      const relPath = String(req.query.path ?? '');
      const { target } = resolveSafeWorkspacePath(req.params.id, relPath);
      const content = await fs.readFile(target, 'utf-8');
      res.json({ path: relPath, content });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : 'File not found' });
    }
  });

  app.put('/api/workspaces/:id/file', async (req, res) => {
    try {
      const { path: relPath, content } = req.body as { path: string; content: string };
      const { target } = resolveSafeWorkspacePath(req.params.id, relPath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content ?? '', 'utf-8');
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to write file' });
    }
  });

  app.post('/api/workspaces/:id/entry', async (req, res) => {
    try {
      const { path: relPath, kind } = req.body as { path: string; kind: 'file' | 'dir' };
      const { target } = resolveSafeWorkspacePath(req.params.id, relPath);
      if (kind === 'dir') {
        await fs.mkdir(target, { recursive: true });
      } else {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, '', 'utf-8');
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create entry' });
    }
  });

  app.post('/api/workspaces/:id/rename', async (req, res) => {
    try {
      const { oldPath, newPath } = req.body as { oldPath: string; newPath: string };
      const { target: src } = resolveSafeWorkspacePath(req.params.id, oldPath);
      const { target: dst } = resolveSafeWorkspacePath(req.params.id, newPath);
      await fs.mkdir(path.dirname(dst), { recursive: true });
      await fs.rename(src, dst);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Rename failed' });
    }
  });

  app.delete('/api/workspaces/:id/entry', async (req, res) => {
    try {
      const relPath = String(req.query.path ?? '');
      const { target } = resolveSafeWorkspacePath(req.params.id, relPath);
      await fs.rm(target, { recursive: true, force: true });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Delete failed' });
    }
  });

  app.get('/api/workspaces/:id/search', async (req, res) => {
    try {
      const query = String(req.query.q ?? '');
      const symbolsOnly = req.query.symbolsOnly === 'true';
      const { root } = resolveSafeWorkspacePath(req.params.id);
      const hits: Array<{
        filePath: string;
        line: number;
        preview: string;
        symbolKind: string | null;
        symbolName: string | null;
      }> = [];
      await searchDirectory(root, root, query, symbolsOnly, hits);
      res.json({ hits });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Search failed' });
    }
  });

  app.post('/api/workspaces/:id/terminal', async (req, res) => {
    try {
      const { command } = req.body as { command: string };
      if (!command || !command.trim()) {
        res.status(400).json({ error: 'Command cannot be empty' });
        return;
      }
      const { root } = resolveSafeWorkspacePath(req.params.id);

      const child = spawn('sh', ['-c', command], {
        cwd: root,
        env: { ...process.env, TERM: 'dumb' },
      });

      let stdout = '';
      let stderr = '';
      let killedByTimeout = false;

      const timer = setTimeout(() => {
        killedByTimeout = true;
        child.kill('SIGTERM');
      }, 15000);

      child.stdout.on('data', (chunk) => {
        if (stdout.length < 64000) stdout += chunk.toString();
      });

      child.stderr.on('data', (chunk) => {
        if (stderr.length < 64000) stderr += chunk.toString();
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (killedByTimeout) {
          stderr += '\nProcess terminated after 15s command timeout.';
        }
        res.json({
          stdout,
          stderr,
          exitCode: code ?? 1,
        });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        res.status(500).json({ error: err.message });
      });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Terminal execution failed' });
    }
  });

  app.post('/api/agent/plan', async (req, res) => {
    const abortController = new AbortController();
    let clientClosed = false;
    req.on('close', () => {
      if (!res.writableEnded) {
        clientClosed = true;
        abortController.abort();
      }
    });

    const emitEvent = (payload: Record<string, unknown>) => {
      if (clientClosed || res.writableEnded) return;
      res.write(`${JSON.stringify(payload)}\n`);
    };

    try {
      const {
        prompt,
        activeFile,
        files,
        effort,
        agentMode,
        history,
      } = req.body as {
        prompt: string;
        activeFile?: string | null;
        files: Array<{ path: string; content: string }>;
        effort?: 'low' | 'medium' | 'high' | 'xhigh';
        agentMode?: 'plan' | 'action';
        history?: Array<{ role: 'user' | 'assistant'; content: string }>;
      };

      if (!prompt || !prompt.trim()) {
        res.status(400).json({ error: 'Prompt is required.' });
        return;
      }

      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();

      const startedAt = Date.now();
      const isPlanMode = agentMode === 'plan';
      const ai = getGeminiClient();
      const workspaceFiles = (files ?? []).slice(0, 28);

      // Emit initial inspection activity (Follow AI can track active/indexed files)
      const inspectedFiles = activeFile
        ? [activeFile, ...workspaceFiles.map((f) => f.path).filter((p) => p !== activeFile)].slice(0, 4)
        : workspaceFiles.map((f) => f.path).slice(0, 3);

      for (const filePath of inspectedFiles) {
        emitEvent({
          type: 'activity',
          activity: {
            id: `read-${filePath}`,
            kind: 'read',
            label: `Inspecting ${filePath}`,
            filePath,
            status: 'done',
          },
        });
      }

      emitEvent({
        type: 'activity',
        activity: {
          id: 'phase-think',
          kind: 'think',
          label: isPlanMode ? 'Analyzing architecture & plan' : 'Reasoning over workspace edits',
          status: 'running',
        },
      });

      const contextFiles = workspaceFiles
        .map((f) => `--- FILE: ${f.path} ---\n${f.content.slice(0, 18000)}`)
        .join('\n\n');

      const thinkingLevel =
        effort === 'xhigh'
          ? ThinkingLevel.XHIGH
          : effort === 'high'
            ? ThinkingLevel.HIGH
            : effort === 'low'
              ? ThinkingLevel.LOW
              : ThinkingLevel.MEDIUM;

      const systemInstruction = isPlanMode
        ? 'You are Aetheris in PLAN MODE (read-only architectural and implementation planning). Inspect the provided workspace files carefully and produce a concrete, step-by-step engineering plan explaining which files, functions, and data flows should change and why. Do NOT emit file edits in Plan Mode: always return an empty patches array [].'
        : 'You are Aetheris in ACTION MODE (autonomous multi-file coding). Inspect the provided workspace files carefully. Respond with a concise engineering summary, clear verification/inspection steps you took, and structured multi-file patches. Whenever creating or modifying a file, provide the COMPLETE updated file content (never truncate with ellipses or placeholders).';

      const priorTurns = (history ?? [])
        .filter((h) => h.content && h.content.trim())
        .slice(-10)
        .map((h) => ({
          role: h.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: h.content.slice(0, 4000) }],
        }));

      const currentTurnText = `Mode: ${isPlanMode ? 'PLAN (read-only)' : 'ACTION (generate patches)'}\nActive editor file: ${activeFile ?? 'none'}\n\nUser request:\n${prompt}\n\nWorkspace context:\n${contextFiles}`;

      const contents = [
        ...priorTurns,
        { role: 'user', parts: [{ text: currentTurnText }] },
      ];

      const stream = await ai.models.generateContentStream({
        model: 'gemini-4-hydrogen',
        contents,
        config: {
          abortSignal: abortController.signal,
          systemInstruction,
          thinkingConfig: {
            thinkingLevel,
            includeThoughts: true,
          },
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              summary: {
                type: Type.STRING,
                description: isPlanMode
                  ? 'Clear architectural analysis and implementation plan overview.'
                  : 'Clear, concise technical explanation of findings and proposed edits.',
              },
              steps: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: isPlanMode
                  ? 'Concrete ordered implementation steps referencing exact file paths and symbols.'
                  : 'Ordered trace of workspace inspection and editing steps.',
              },
              patches: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    path: { type: Type.STRING, description: 'Relative workspace path.' },
                    action: { type: Type.STRING, description: 'One of: create, modify, delete' },
                    rationale: { type: Type.STRING, description: 'Why this file change is needed.' },
                    content: { type: Type.STRING, description: 'Complete file contents for create or modify; empty string for delete.' },
                  },
                  required: ['path', 'action', 'rationale', 'content'],
                },
              },
            },
            required: ['summary', 'steps', 'patches'],
          },
        },
      });

      let rawAnswer = '';
      let thoughtsAccum = '';
      let thoughtStartMs: number | null = null;
      let thoughtEndMs: number | null = null;
      let emittedDrafting = false;
      const seenEditPaths = new Set<string>();

      for await (const chunk of stream) {
        if (clientClosed || abortController.signal.aborted) break;

        const parts = chunk.candidates?.[0]?.content?.parts ?? [];
        for (const part of parts) {
          const textPiece = typeof part.text === 'string' ? part.text : '';
          if (!textPiece) continue;

          if ((part as { thought?: boolean }).thought) {
            if (thoughtStartMs === null) thoughtStartMs = Date.now();
            thoughtEndMs = Date.now();
            thoughtsAccum += textPiece;
            emitEvent({ type: 'thought', delta: textPiece });
          } else {
            if (!emittedDrafting) {
              emittedDrafting = true;
              if (thoughtStartMs !== null && thoughtEndMs === null) {
                thoughtEndMs = Date.now();
              }
              emitEvent({
                type: 'activity',
                activity: {
                  id: 'phase-think',
                  kind: 'think',
                  label: isPlanMode ? 'Analyzed architecture & plan' : 'Finished reasoning',
                  status: 'done',
                },
              });
              emitEvent({
                type: 'activity',
                activity: {
                  id: 'phase-draft',
                  kind: isPlanMode ? 'plan' : 'edit',
                  label: isPlanMode ? 'Writing step-by-step plan' : 'Drafting workspace patches',
                  status: 'running',
                },
              });
            }

            rawAnswer += textPiece;

            if (!isPlanMode) {
              const pathMatches = rawAnswer.matchAll(/"path"\s*:\s*"([^"\\]+)"/g);
              for (const m of pathMatches) {
                const patchedPath = m[1];
                if (patchedPath && !seenEditPaths.has(patchedPath)) {
                  seenEditPaths.add(patchedPath);
                  emitEvent({
                    type: 'activity',
                    activity: {
                      id: `edit-${patchedPath}`,
                      kind: 'edit',
                      label: `Preparing edit -> ${patchedPath}`,
                      filePath: patchedPath,
                      status: 'done',
                    },
                  });
                }
              }
            }
          }
        }
      }

      if (clientClosed || abortController.signal.aborted) {
        if (!res.writableEnded) res.end();
        return;
      }

      const parsed = JSON.parse((rawAnswer || '{}').trim()) as {
        summary?: string;
        steps?: string[];
        patches?: Array<{ path: string; action: string; rationale: string; content: string }>;
      };

      const thinkingDurationMs =
        thoughtStartMs !== null
          ? Math.max(200, (thoughtEndMs ?? Date.now()) - thoughtStartMs)
          : Date.now() - startedAt;

      emitEvent({
        type: 'activity',
        activity: {
          id: 'phase-think',
          kind: 'think',
          label: isPlanMode ? 'Analyzed architecture & plan' : 'Completed reasoning',
          status: 'done',
        },
      });
      emitEvent({
        type: 'activity',
        activity: {
          id: 'phase-draft',
          kind: 'done',
          label: isPlanMode ? 'Plan ready' : `Prepared ${Array.isArray(parsed.patches) ? parsed.patches.length : 0} file change(s)`,
          status: 'done',
        },
      });

      emitEvent({
        type: 'result',
        summary: parsed.summary ?? 'Completed workspace analysis.',
        steps: Array.isArray(parsed.steps) ? parsed.steps : [],
        patches: isPlanMode ? [] : Array.isArray(parsed.patches) ? parsed.patches : [],
        thoughts: thoughtsAccum.trim(),
        thinkingDurationMs,
      });

      if (!res.writableEnded) res.end();
    } catch (err) {
      if (clientClosed || abortController.signal.aborted) {
        if (!res.writableEnded) res.end();
        return;
      }
      const message = err instanceof Error ? err.message : 'Agent request failed';
      if (!res.headersSent) {
        res.status(500).json({ error: message });
      } else {
        emitEvent({ type: 'error', error: message });
        if (!res.writableEnded) res.end();
      }
    }
  });

  app.post('/api/agent/chat', async (req, res) => {
    try {
      const { messages } = req.body as {
        messages?: Array<{ role: 'user' | 'assistant'; content: string }>;
      };
      const cleaned = (messages ?? []).filter((m) => m.content && m.content.trim());
      if (cleaned.length === 0) {
        res.status(400).json({ error: 'Message cannot be empty.' });
        return;
      }

      const ai = getGeminiClient();
      const contents = cleaned.slice(-16).map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents,
        config: {
          systemInstruction:
            'You are Aetheris, a friendly, concise engineering companion on the IDE home screen. Chat naturally for smalltalk, brainstorm ideas, or answer quick technical questions concisely.',
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        },
      });

      res.json({ reply: (response.text ?? '').trim() || 'No response returned.' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Chat request failed';
      res.status(500).json({ error: message });
    }
  });

  app.get('/api/workspaces/:id/git/status', async (req, res) => {
    try {
      const { root } = resolveSafeWorkspacePath(req.params.id);
      const snapshot = await getGitStatusSnapshot(root);
      res.json(snapshot);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Git status failed' });
    }
  });

  app.get('/api/workspaces/:id/git/diff', async (req, res) => {
    try {
      const relPath = String(req.query.path ?? '');
      const staged = req.query.staged === 'true';
      const status = String(req.query.status ?? 'M');
      const { root, target } = resolveSafeWorkspacePath(req.params.id, relPath);

      let originalContent = '';
      let modifiedContent = '';

      if (staged) {
        const headOut = await runGit(root, ['show', `HEAD:${relPath}`]);
        if (headOut.code === 0) originalContent = headOut.stdout;
        if (status !== 'D') {
          const idxOut = await runGit(root, ['show', `:${relPath}`]);
          if (idxOut.code === 0) modifiedContent = idxOut.stdout;
        }
      } else {
        if (status !== 'U') {
          const idxOut = await runGit(root, ['show', `:${relPath}`]);
          if (idxOut.code === 0) {
            originalContent = idxOut.stdout;
          } else {
            const headOut = await runGit(root, ['show', `HEAD:${relPath}`]);
            if (headOut.code === 0) originalContent = headOut.stdout;
          }
        }
        if (status !== 'D') {
          try {
            modifiedContent = await fs.readFile(target, 'utf-8');
          } catch {
            modifiedContent = '';
          }
        }
      }

      res.json({
        path: relPath,
        status,
        staged,
        originalContent,
        modifiedContent,
      });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Git diff failed' });
    }
  });

  app.post('/api/workspaces/:id/git/init', async (req, res) => {
    try {
      const { root } = resolveSafeWorkspacePath(req.params.id);
      let out = await runGit(root, ['init', '-b', 'main']);
      if (out.code !== 0) {
        out = await runGit(root, ['init']);
      }
      if (out.code !== 0) {
        res.status(400).json({ error: out.stderr || 'Failed to initialize git repository' });
        return;
      }
      res.json(await getGitStatusSnapshot(root));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Git init failed' });
    }
  });

  app.post('/api/workspaces/:id/git/stage', async (req, res) => {
    try {
      const { root } = resolveSafeWorkspacePath(req.params.id);
      const { paths, all } = req.body as { paths?: string[]; all?: boolean };
      const args = all ? ['add', '-A'] : ['add', '--', ...(paths ?? [])];
      const out = await runGit(root, args);
      if (out.code !== 0) {
        res.status(400).json({ error: out.stderr || 'Failed to stage changes' });
        return;
      }
      res.json(await getGitStatusSnapshot(root));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Stage failed' });
    }
  });

  app.post('/api/workspaces/:id/git/unstage', async (req, res) => {
    try {
      const { root } = resolveSafeWorkspacePath(req.params.id);
      const { paths, all } = req.body as { paths?: string[]; all?: boolean };
      const hasHead = (await runGit(root, ['rev-parse', '--verify', 'HEAD'])).code === 0;
      const args = hasHead
        ? all
          ? ['reset', 'HEAD']
          : ['reset', 'HEAD', '--', ...(paths ?? [])]
        : all
          ? ['rm', '-r', '--cached', '.']
          : ['rm', '--cached', '--', ...(paths ?? [])];
      const out = await runGit(root, args);
      if (out.code !== 0) {
        res.status(400).json({ error: out.stderr || 'Failed to unstage changes' });
        return;
      }
      res.json(await getGitStatusSnapshot(root));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Unstage failed' });
    }
  });

  app.post('/api/workspaces/:id/git/discard', async (req, res) => {
    try {
      const { path: relPath, untracked } = req.body as { path: string; untracked?: boolean };
      const { root, target } = resolveSafeWorkspacePath(req.params.id, relPath);
      if (untracked) {
        await fs.rm(target, { recursive: true, force: true });
      } else {
        const out = await runGit(root, ['checkout', '--', relPath]);
        if (out.code !== 0) {
          res.status(400).json({ error: out.stderr || 'Failed to discard changes' });
          return;
        }
      }
      res.json(await getGitStatusSnapshot(root));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Discard failed' });
    }
  });

  app.post('/api/workspaces/:id/git/commit', async (req, res) => {
    try {
      const { root } = resolveSafeWorkspacePath(req.params.id);
      const { message, stageAllIfEmpty, userName, userEmail } = req.body as {
        message: string;
        stageAllIfEmpty?: boolean;
        userName?: string;
        userEmail?: string;
      };
      if (!message || !message.trim()) {
        res.status(400).json({ error: 'Commit message is required.' });
        return;
      }
      if (userName?.trim()) {
        await runGit(root, ['config', 'user.name', userName.trim()]);
      }
      if (userEmail?.trim()) {
        await runGit(root, ['config', 'user.email', userEmail.trim()]);
      }

      const snap = await getGitStatusSnapshot(root);
      if (snap.staged.length === 0 && stageAllIfEmpty) {
        await runGit(root, ['add', '-A']);
      }

      const out = await runGit(root, ['commit', '-m', message.trim()]);
      if (out.code !== 0) {
        res.status(400).json({ error: out.stderr || out.stdout || 'Commit failed' });
        return;
      }
      res.json(await getGitStatusSnapshot(root));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Commit failed' });
    }
  });

  app.post('/api/workspaces/:id/git/branch', async (req, res) => {
    try {
      const { root } = resolveSafeWorkspacePath(req.params.id);
      const { action, name } = req.body as { action: 'checkout' | 'create'; name: string };
      if (!name || !name.trim()) {
        res.status(400).json({ error: 'Branch name is required.' });
        return;
      }
      const args = action === 'create' ? ['checkout', '-b', name.trim()] : ['checkout', name.trim()];
      const out = await runGit(root, args);
      if (out.code !== 0) {
        res.status(400).json({ error: out.stderr || 'Branch switch failed' });
        return;
      }
      res.json(await getGitStatusSnapshot(root));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Branch action failed' });
    }
  });

  app.post('/api/workspaces/:id/git/remote', async (req, res) => {
    try {
      const { root } = resolveSafeWorkspacePath(req.params.id);
      const { url } = req.body as { url: string };
      const trimmed = (url ?? '').trim();
      if (!trimmed) {
        res.status(400).json({ error: 'Remote URL is required.' });
        return;
      }
      const existing = await runGit(root, ['remote', 'get-url', 'origin']);
      const out =
        existing.code === 0
          ? await runGit(root, ['remote', 'set-url', 'origin', trimmed])
          : await runGit(root, ['remote', 'add', 'origin', trimmed]);
      if (out.code !== 0) {
        res.status(400).json({ error: out.stderr || 'Failed to configure remote origin' });
        return;
      }
      res.json(await getGitStatusSnapshot(root));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Remote update failed' });
    }
  });

  app.post('/api/workspaces/:id/git/sync', async (req, res) => {
    try {
      const { root } = resolveSafeWorkspacePath(req.params.id);
      const { action } = req.body as { action: 'fetch' | 'pull' | 'push' | 'sync' };
      const snap = await getGitStatusSnapshot(root);

      if (!snap.remoteUrl) {
        res.status(400).json({ error: 'No GitHub remote "origin" configured yet.' });
        return;
      }

      if (action === 'fetch') {
        const out = await runGit(root, ['fetch', '--all', '--prune']);
        if (out.code !== 0) {
          res.status(400).json({ error: out.stderr || 'Fetch failed' });
          return;
        }
      } else if (action === 'pull') {
        const out = await runGit(root, ['pull', '--rebase']);
        if (out.code !== 0) {
          res.status(400).json({ error: out.stderr || 'Pull failed' });
          return;
        }
      } else if (action === 'push') {
        const args = snap.hasUpstream ? ['push'] : ['push', '-u', 'origin', snap.branch || 'main'];
        const out = await runGit(root, args);
        if (out.code !== 0) {
          res.status(400).json({ error: out.stderr || 'Push failed' });
          return;
        }
      } else {
        if (snap.hasUpstream) {
          const pullOut = await runGit(root, ['pull', '--rebase']);
          if (pullOut.code !== 0) {
            res.status(400).json({ error: pullOut.stderr || 'Pull during sync failed' });
            return;
          }
        }
        const pushArgs = snap.hasUpstream ? ['push'] : ['push', '-u', 'origin', snap.branch || 'main'];
        const pushOut = await runGit(root, pushArgs);
        if (pushOut.code !== 0) {
          res.status(400).json({ error: pushOut.stderr || 'Push during sync failed' });
          return;
        }
      }

      res.json(await getGitStatusSnapshot(root));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Git sync failed' });
    }
  });

  app.post('/api/workspaces/:id/git/commit-message', async (req, res) => {
    try {
      const { root } = resolveSafeWorkspacePath(req.params.id);
      const stagedDiff = await runGit(root, ['diff', '--cached']);
      const workingDiff = stagedDiff.stdout.trim()
        ? stagedDiff.stdout
        : (await runGit(root, ['diff'])).stdout;
      const statusShort = (await runGit(root, ['status', '--short'])).stdout;
      const diffInput = (workingDiff.trim() || statusShort.trim()).slice(0, 12000);
      if (!diffInput) {
        res.status(400).json({ error: 'No changes to summarize.' });
        return;
      }

      const ai = getGeminiClient();
      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: `Write a single concise conventional git commit message (<= 72 chars on first line, no quotes or markdown) for these changes:\n\n${diffInput}`,
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        },
      });
      res.json({ message: (response.text ?? '').trim().replace(/^["'`]+|["'`]+$/g, '') });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to generate commit message' });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.join(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Aetheris server listening on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

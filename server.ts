import 'dotenv/config';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  GoogleGenAI,
  ThinkingLevel,
  Type,
  type Content,
  type FunctionDeclaration,
  type Part,
} from '@google/genai';

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
    if (
      entry.name === 'node_modules' ||
      entry.name === 'target' ||
      entry.name === '.git' ||
      entry.name === 'dist' ||
      entry.name === '.aetheris-project.json'
    ) {
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
    if (
      entry.name === 'node_modules' ||
      entry.name === 'target' ||
      entry.name === '.git' ||
      entry.name === 'dist' ||
      entry.name === '.aetheris-project.json'
    ) {
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
  app.use(express.json({ limit: '24mb' }));

  app.get('/api/workspaces', async (_req, res) => {
    try {
      const entries = await fs.readdir(WORKSPACES_ROOT, { withFileTypes: true });
      const starterMap = new Map(STARTER_TEMPLATES.map((t) => [t.id, t]));
      const list = await Promise.all(
        entries
          .filter((e) => e.isDirectory())
          .map(async (e) => {
            const tpl = starterMap.get(e.name);
            if (tpl) {
              return {
                id: tpl.id,
                name: tpl.name,
                description: tpl.description,
                language: tpl.language,
              };
            }
            let description = 'Custom workspace folder';
            let language = 'Folder';
            try {
              const metaRaw = await fs.readFile(
                path.join(WORKSPACES_ROOT, e.name, '.aetheris-project.json'),
                'utf-8'
              );
              const meta = JSON.parse(metaRaw) as { description?: string; language?: string };
              if (meta.description) description = meta.description;
              if (meta.language) language = meta.language;
            } catch {
              // No metadata file
            }
            return {
              id: e.name,
              name: e.name,
              description,
              language,
            };
          })
      );
      list.sort((a, b) => a.name.localeCompare(b.name));
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
      const { command, cwd } = req.body as { command: string; cwd?: string };
      if (!command || !command.trim()) {
        res.status(400).json({ error: 'Command cannot be empty' });
        return;
      }
      const { root } = resolveSafeWorkspacePath(req.params.id);
      const realRoot = await fs.realpath(root);

      let startCwd = realRoot;
      let startRelCwd = '.';
      if (cwd && cwd.trim() && cwd.trim() !== '.') {
        try {
          const candidate = path.resolve(realRoot, cwd.trim());
          const candidateReal = await fs.realpath(candidate);
          const relFromRoot = path.relative(realRoot, candidateReal);
          if (
            relFromRoot === '' ||
            (!relFromRoot.startsWith('..') && !path.isAbsolute(relFromRoot))
          ) {
            const stat = await fs.stat(candidateReal);
            if (stat.isDirectory()) {
              startCwd = candidateReal;
              startRelCwd = relFromRoot ? relFromRoot.split(path.sep).join('/') : '.';
            }
          }
        } catch {
          // Fallback to workspace root if prior directory no longer exists
        }
      }

      const wrappedScript =
        'eval "$AETHERIS_CMD"\n__aetheris_ec=$?\nprintf \'\\n__AETHERIS_CWD__:%s\\n\' "$(pwd -P)"\nexit $__aetheris_ec';

      const child = spawn('sh', ['-c', wrappedScript], {
        cwd: startCwd,
        env: {
          ...process.env,
          HOME: realRoot,
          TERM: 'dumb',
          AETHERIS_CMD: command,
        },
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

        let nextRelCwd = startRelCwd;
        const markerRe = /\r?\n?__AETHERIS_CWD__:([^\r\n]+)\r?\n?$/;
        const match = markerRe.exec(stdout);
        if (match) {
          const capturedAbs = match[1].trim();
          stdout = stdout.slice(0, match.index);
          if (capturedAbs) {
            const relFromRoot = path.relative(realRoot, path.resolve(capturedAbs));
            if (relFromRoot === '') {
              nextRelCwd = '.';
            } else if (!relFromRoot.startsWith('..') && !path.isAbsolute(relFromRoot)) {
              nextRelCwd = relFromRoot.split(path.sep).join('/');
            } else {
              nextRelCwd = '.';
            }
          }
        }

        res.json({
          stdout,
          stderr,
          exitCode: code ?? 1,
          cwd: nextRelCwd,
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
    res.on('close', () => {
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
        workspaceId,
        prompt,
        activeFile,
        openBuffers,
        files,
        effort,
        agentMode,
        autopilot,
        history,
      } = req.body as {
        workspaceId?: string;
        prompt: string;
        activeFile?: string | null;
        openBuffers?: Record<string, string>;
        files?: Array<{ path: string; content: string }>;
        effort?: 'low' | 'medium' | 'high' | 'xhigh';
        agentMode?: 'plan' | 'action';
        autopilot?: boolean;
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
      const bufferMap = new Map<string, string>(Object.entries(openBuffers ?? {}));
      const virtualMap = new Map<string, string>(
        (files ?? []).map((f) => [f.path, f.content])
      );
      const useDisk = Boolean(workspaceId);
      const workspaceRoot = workspaceId ? resolveSafeWorkspacePath(workspaceId).root : '';

      const listAllRelPaths = async (): Promise<string[]> => {
        if (!useDisk) {
          const paths = new Set<string>([...virtualMap.keys(), ...bufferMap.keys()]);
          return Array.from(paths).sort();
        }
        const results: string[] = [];
        const walk = async (dir: string, depth = 0): Promise<void> => {
          if (depth > 12 || results.length >= 1000) return;
          const entries = await fs.readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (results.length >= 1000) return;
            if (
              entry.name === 'node_modules' ||
              entry.name === 'target' ||
              entry.name === '.git' ||
              entry.name === 'dist' ||
              entry.name === '.aetheris-project.json'
            ) {
              continue;
            }
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              await walk(full, depth + 1);
            } else {
              const rel = path.relative(workspaceRoot, full).split(path.sep).join('/');
              results.push(rel);
            }
          }
        };
        await walk(workspaceRoot);
        for (const p of bufferMap.keys()) {
          if (!results.includes(p)) results.push(p);
        }
        return results.sort();
      };

      const readRawFile = async (relPath: string): Promise<string | null> => {
        if (bufferMap.has(relPath)) return bufferMap.get(relPath)!;
        if (!useDisk) {
          return virtualMap.get(relPath) ?? null;
        }
        try {
          const { target } = resolveSafeWorkspacePath(workspaceId!, relPath);
          return await fs.readFile(target, 'utf-8');
        } catch {
          return null;
        }
      };

      interface StagedPatch {
        path: string;
        action: 'create' | 'modify' | 'delete';
        rationale: string;
        content: string;
        originalContent: string;
      }
      const stagedPatches = new Map<string, StagedPatch>();
      const stepTrace: string[] = [];

      const getCurrentEditableText = async (relPath: string): Promise<string | null> => {
        const staged = stagedPatches.get(relPath);
        if (staged) {
          return staged.action === 'delete' ? null : staged.content;
        }
        return readRawFile(relPath);
      };

      const getOriginalBaseline = async (relPath: string): Promise<string> => {
        const existingStaged = stagedPatches.get(relPath);
        if (existingStaged) return existingStaged.originalContent;
        return (await readRawFile(relPath)) ?? '';
      };

      const listToolDecl: FunctionDeclaration = {
        name: 'list_workspace_files',
        description:
          'List all files in the workspace. Use optional directory prefix or substring filter to inspect large repositories.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            directory: {
              type: Type.STRING,
              description: 'Optional relative directory prefix (e.g. "src" or "src-tauri").',
            },
            filter: {
              type: Type.STRING,
              description: 'Optional case-insensitive path substring filter.',
            },
          },
        },
      };

      const readToolDecl: FunctionDeclaration = {
        name: 'read_file',
        description:
          'Read complete or line-ranged contents of any workspace file with line numbers. Read large files in slices (e.g. 1..400, 401..800) so nothing is missed.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            path: { type: Type.STRING, description: 'Relative file path inside workspace.' },
            start_line: { type: Type.INTEGER, description: '1-based start line (default 1).' },
            end_line: {
              type: Type.INTEGER,
              description: '1-based inclusive end line (default up to start_line + 449).',
            },
          },
          required: ['path'],
        },
      };

      const searchToolDecl: FunctionDeclaration = {
        name: 'search_workspace',
        description:
          'Search across all workspace files for a text string or symbol name. Returns matching file paths, line numbers, and line previews.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            query: { type: Type.STRING, description: 'Text or symbol substring to search for.' },
            case_sensitive: { type: Type.BOOLEAN, description: 'Match exact case if true.' },
          },
          required: ['query'],
        },
      };

      const editToolDecl: FunctionDeclaration = {
        name: 'propose_edit',
        description:
          'Propose targeted search-and-replace hunks on an existing file without rewriting unrelated parts of the file. Always read the relevant lines first so old_text matches verbatim.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            path: { type: Type.STRING, description: 'Relative path of existing file to modify.' },
            rationale: { type: Type.STRING, description: 'Concise reason for this edit.' },
            edits: {
              type: Type.ARRAY,
              description: 'Ordered list of exact search-and-replace hunks.',
              items: {
                type: Type.OBJECT,
                properties: {
                  old_text: {
                    type: Type.STRING,
                    description: 'Exact existing lines in the file to replace (must match uniquely).',
                  },
                  new_text: {
                    type: Type.STRING,
                    description: 'Replacement code for old_text.',
                  },
                },
                required: ['old_text', 'new_text'],
              },
            },
          },
          required: ['path', 'rationale', 'edits'],
        },
      };

      const createToolDecl: FunctionDeclaration = {
        name: 'propose_create_file',
        description: 'Stage creation of a brand new file in the workspace for diff review.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            path: { type: Type.STRING, description: 'Relative path for the new file.' },
            rationale: { type: Type.STRING, description: 'Why this file is being created.' },
            content: { type: Type.STRING, description: 'Complete contents of the new file.' },
          },
          required: ['path', 'rationale', 'content'],
        },
      };

      const deleteToolDecl: FunctionDeclaration = {
        name: 'propose_delete_file',
        description: 'Stage deletion of a workspace file for review.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            path: { type: Type.STRING, description: 'Relative path of file to delete.' },
            rationale: { type: Type.STRING, description: 'Why this file should be removed.' },
          },
          required: ['path', 'rationale'],
        },
      };

      const declarations: FunctionDeclaration[] = isPlanMode
        ? [listToolDecl, readToolDecl, searchToolDecl]
        : [
            listToolDecl,
            readToolDecl,
            searchToolDecl,
            propose_edit_alias(editToolDecl),
            createToolDecl,
            deleteToolDecl,
          ];

      function propose_edit_alias(d: FunctionDeclaration): FunctionDeclaration {
        return d;
      }

      const executeTool = async (
        name: string,
        args: Record<string, unknown>,
        callIdx: number
      ): Promise<Record<string, unknown>> => {
        const actId = `tool-${Date.now()}-${callIdx}`;
        if (name === 'list_workspace_files') {
          const dirPrefix = typeof args.directory === 'string' ? args.directory.replace(/^\/+|\/+$/g, '') : '';
          const filterStr = typeof args.filter === 'string' ? args.filter.trim().toLowerCase() : '';
          emitEvent({
            type: 'activity',
            activity: {
              id: actId,
              kind: 'read',
              label: dirPrefix ? `Listing files in ${dirPrefix}` : 'Listing workspace files',
              status: 'running',
            },
          });
          let all = await listAllRelPaths();
          if (dirPrefix) {
            all = all.filter((p) => p === dirPrefix || p.startsWith(`${dirPrefix}/`));
          }
          if (filterStr) {
            all = all.filter((p) => p.toLowerCase().includes(filterStr));
          }
          emitEvent({
            type: 'activity',
            activity: {
              id: actId,
              kind: 'read',
              label: `Indexed ${all.length} file(s)`,
              status: 'done',
            },
          });
          stepTrace.push(`Indexed ${all.length} workspace file(s)${dirPrefix ? ` under ${dirPrefix}` : ''}`);
          return { totalCount: all.length, files: all.slice(0, 500) };
        }

        if (name === 'read_file') {
          const relPath = String(args.path ?? '').replace(/^\/+/, '');
          const startLine = Math.max(1, Number(args.start_line ?? 1) || 1);
          const requestedEnd = args.end_line ? Number(args.end_line) : startLine + 449;
          const endLine = Math.max(startLine, Math.min(startLine + 499, requestedEnd));
          emitEvent({
            type: 'activity',
            activity: {
              id: actId,
              kind: 'read',
              label: `Reading ${relPath}`,
              filePath: relPath,
              status: 'running',
            },
          });
          const text = await getCurrentEditableText(relPath);
          if (text === null) {
            emitEvent({
              type: 'activity',
              activity: {
                id: actId,
                kind: 'read',
                label: `File not found: ${relPath}`,
                status: 'done',
              },
            });
            return { error: `File not found: ${relPath}` };
          }
          const lines = text.split(/\r?\n/);
          const clampedEnd = Math.min(lines.length, endLine);
          const numbered = lines
            .slice(startLine - 1, clampedEnd)
            .map((l, idx) => `${startLine + idx}: ${l}`)
            .join('\n');
          emitEvent({
            type: 'activity',
            activity: {
              id: actId,
              kind: 'read',
              label: `Read ${relPath} (${startLine}-${clampedEnd}/${lines.length})`,
              filePath: relPath,
              status: 'done',
            },
          });
          stepTrace.push(`Inspected ${relPath} (lines ${startLine}–${clampedEnd} of ${lines.length})`);
          return {
            path: relPath,
            totalLines: lines.length,
            startLine,
            endLine: clampedEnd,
            truncated: clampedEnd < lines.length,
            content: numbered,
          };
        }

        if (name === 'search_workspace') {
          const query = String(args.query ?? '');
          const caseSensitive = Boolean(args.case_sensitive);
          emitEvent({
            type: 'activity',
            activity: {
              id: actId,
              kind: 'read',
              label: `Searching for "${query.slice(0, 32)}"`,
              status: 'running',
            },
          });
          const all = await listAllRelPaths();
          const needle = caseSensitive ? query : query.toLowerCase();
          const matches: Array<{ path: string; line: number; text: string }> = [];
          for (const relPath of all) {
            if (matches.length >= 80) break;
            const raw = await readRawFile(relPath);
            if (!raw) continue;
            const lines = raw.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
              if (matches.length >= 80) break;
              const hay = caseSensitive ? lines[i] : lines[i].toLowerCase();
              if (hay.includes(needle)) {
                matches.push({ path: relPath, line: i + 1, text: lines[i].trim().slice(0, 160) });
              }
            }
          }
          emitEvent({
            type: 'activity',
            activity: {
              id: actId,
              kind: 'read',
              label: `Search "${query.slice(0, 24)}" -> ${matches.length} hit(s)`,
              status: 'done',
            },
          });
          stepTrace.push(`Searched workspace for "${query}" (${matches.length} matches)`);
          return { matchCount: matches.length, matches };
        }

        if (name === 'propose_edit' && !isPlanMode) {
          const relPath = String(args.path ?? '').replace(/^\/+/, '');
          const rationale = String(args.rationale ?? 'Update file');
          const edits = Array.isArray(args.edits)
            ? (args.edits as Array<{ old_text?: string; new_text?: string }>)
            : [];
          emitEvent({
            type: 'activity',
            activity: {
              id: actId,
              kind: 'edit',
              label: `Editing ${relPath}`,
              filePath: relPath,
              status: 'running',
            },
          });

          const current = await getCurrentEditableText(relPath);
          if (current === null) {
            return { error: `Cannot edit "${relPath}" because it does not exist. Use propose_create_file instead.` };
          }
          const baseline = await getOriginalBaseline(relPath);
          let nextContent = current;

          for (let i = 0; i < edits.length; i++) {
            const oldText = typeof edits[i]?.old_text === 'string' ? edits[i].old_text! : '';
            const newText = typeof edits[i]?.new_text === 'string' ? edits[i].new_text! : '';
            if (!oldText) {
              return { error: `Edit #${i + 1} has empty old_text. Call read_file to copy exact lines.` };
            }

            let occurrences = nextContent.split(oldText).length - 1;
            let resolvedOld = oldText;
            let resolvedNew = newText;

            if (occurrences === 0 && nextContent.includes('\r\n')) {
              const crlfOld = oldText.replace(/\r?\n/g, '\r\n');
              const crlfNew = newText.replace(/\r?\n/g, '\r\n');
              const crlfOcc = nextContent.split(crlfOld).length - 1;
              if (crlfOcc > 0) {
                resolvedOld = crlfOld;
                resolvedNew = crlfNew;
                occurrences = crlfOcc;
              }
            }

            if (occurrences === 0) {
              return {
                error: `Edit #${i + 1} old_text not found in "${relPath}". Call read_file on "${relPath}" to verify exact whitespace and lines.`,
              };
            }
            if (occurrences > 1) {
              return {
                error: `Edit #${i + 1} old_text matched ${occurrences} places in "${relPath}". Include 2-3 surrounding context lines so it is unique.`,
              };
            }

            nextContent = nextContent.replace(resolvedOld, () => resolvedNew);
          }

          stagedPatches.set(relPath, {
            path: relPath,
            action: stagedPatches.get(relPath)?.action === 'create' ? 'create' : 'modify',
            rationale,
            content: nextContent,
            originalContent: baseline,
          });
          emitEvent({
            type: 'activity',
            activity: {
              id: actId,
              kind: 'edit',
              label: `Staged edit -> ${relPath}`,
              filePath: relPath,
              status: 'done',
            },
          });
          stepTrace.push(`Proposed ${edits.length} targeted edit(s) in ${relPath}`);
          return { ok: true, path: relPath, appliedEdits: edits.length };
        }

        if (name === 'propose_create_file' && !isPlanMode) {
          const relPath = String(args.path ?? '').replace(/^\/+/, '');
          const rationale = String(args.rationale ?? 'Create new file');
          const content = String(args.content ?? '');
          const baseline = await getOriginalBaseline(relPath);
          stagedPatches.set(relPath, {
            path: relPath,
            action: baseline ? 'modify' : 'create',
            rationale,
            content,
            originalContent: baseline,
          });
          emitEvent({
            type: 'activity',
            activity: {
              id: actId,
              kind: 'edit',
              label: `Staged new file -> ${relPath}`,
              filePath: relPath,
              status: 'done',
            },
          });
          stepTrace.push(`Proposed new file ${relPath}`);
          return { ok: true, path: relPath };
        }

        if (name === 'propose_delete_file' && !isPlanMode) {
          const relPath = String(args.path ?? '').replace(/^\/+/, '');
          const rationale = String(args.rationale ?? 'Remove file');
          const baseline = await getOriginalBaseline(relPath);
          stagedPatches.set(relPath, {
            path: relPath,
            action: 'delete',
            rationale,
            content: '',
            originalContent: baseline,
          });
          emitEvent({
            type: 'activity',
            activity: {
              id: actId,
              kind: 'edit',
              label: `Staged deletion -> ${relPath}`,
              filePath: relPath,
              status: 'done',
            },
          });
          stepTrace.push(`Proposed removal of ${relPath}`);
          return { ok: true, path: relPath };
        }

        return { error: `Unknown or disallowed tool: ${name}` };
      };

      const allPaths = await listAllRelPaths();
      const previewTreeList = allPaths.slice(0, 120).join('\n');
      const activePreview = activeFile ? await readRawFile(activeFile) : null;

      emitEvent({
        type: 'activity',
        activity: {
          id: 'phase-think',
          kind: 'think',
          label: isPlanMode ? 'Analyzing architecture & plan' : 'Inspecting workspace with tools',
          status: 'running',
        },
      });

      const thinkingLevel =
        effort === 'xhigh'
          ? ThinkingLevel.XHIGH
          : effort === 'high'
            ? ThinkingLevel.HIGH
            : effort === 'low'
              ? ThinkingLevel.LOW
              : ThinkingLevel.MEDIUM;

      const maxTurns =
        effort === 'xhigh' ? 24 : effort === 'high' ? 18 : effort === 'low' ? 8 : 14;

      const autopilotClause =
        !isPlanMode && autopilot
          ? ' AUTOPILOT IS ENABLED: Execute the user request completely end-to-end without pausing to ask for permission or confirmation; stage every required edit, creation, and deletion in this run so they can be applied automatically.'
          : '';

      const systemInstruction = isPlanMode
        ? 'You are Aetheris in PLAN MODE (read-only). You have full workspace tools (list_workspace_files, read_file with line ranges, search_workspace) AND live Google Search grounding. Always inspect all relevant workspace files before planning, and use Google Search whenever you need up-to-date library docs, package versions, APIs, or web facts. Never guess file contents. Respond in clean Markdown prose with headings and numbered steps citing exact file paths and symbols—never wrap your whole explanation inside a fenced code block.'
        : `You are Aetheris in ACTION MODE (autonomous multi-file coding agent). You have full workspace tools (list_workspace_files, read_file, search_workspace, propose_edit, propose_create_file, propose_delete_file) AND live Google Search grounding. ALWAYS read files via read_file before editing them (read large files in line slices if needed). Use Google Search whenever you need up-to-date documentation, APIs, package versions, or web information. Use propose_edit with exact verbatim old_text hunks instead of rewriting whole large files. Respond in clean Markdown prose (never wrap your whole response inside a fenced code block—use fenced code blocks only for short code snippets).${autopilotClause}`;

      const priorTurns: Content[] = (history ?? [])
        .filter((h) => h.content && h.content.trim())
        .slice(-10)
        .map((h) => ({
          role: h.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: h.content.slice(0, 4000) }],
        }));

      const activeSnippet =
        activePreview !== null
          ? `\nActive editor file (${activeFile}, ${activePreview.split(/\r?\n/).length} lines) — use read_file for full or other files.`
          : '';

      const initialPrompt = `Mode: ${isPlanMode ? 'PLAN (read-only)' : 'ACTION (tool-based edits)'}\nActive editor file: ${activeFile ?? 'none'}${activeSnippet}\nTotal workspace files: ${allPaths.length}\nFiles overview (call list_workspace_files for full list if needed):\n${previewTreeList}\n\nUser request:\n${prompt}`;

      const contents: Content[] = [
        ...priorTurns,
        { role: 'user', parts: [{ text: initialPrompt }] },
      ];

      let finalAnswerText = '';
      let thoughtsAccum = '';
      let thoughtStartMs: number | null = null;
      let thoughtEndMs: number | null = null;
      const groundingSourcesMap = new Map<string, { title: string; uri: string }>();
      const searchQueriesSet = new Set<string>();
      const emittedSearchQueries = new Set<string>();

      for (let turn = 0; turn < maxTurns; turn++) {
        if (clientClosed || abortController.signal.aborted) break;

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
            tools: [
              { googleSearch: {} },
              { functionDeclarations: declarations },
            ],
            toolConfig: { includeServerSideToolInvocations: true },
          },
        });

        const modelParts: Part[] = [];
        const functionCalls: Array<{ id?: string; name: string; args: Record<string, unknown> }> = [];
        let turnText = '';

        for await (const chunk of stream) {
          if (clientClosed || abortController.signal.aborted) break;

          const gm = chunk.candidates?.[0]?.groundingMetadata;
          if (gm) {
            if (Array.isArray(gm.webSearchQueries)) {
              for (const q of gm.webSearchQueries) {
                const trimmedQ = typeof q === 'string' ? q.trim() : '';
                if (!trimmedQ) continue;
                searchQueriesSet.add(trimmedQ);
                if (!emittedSearchQueries.has(trimmedQ)) {
                  emittedSearchQueries.add(trimmedQ);
                  emitEvent({
                    type: 'activity',
                    activity: {
                      id: `gsearch-${turn}-${emittedSearchQueries.size}`,
                      kind: 'search',
                      label: `Google Search: "${trimmedQ.slice(0, 48)}"`,
                      status: 'done',
                    },
                  });
                }
              }
            }
            if (Array.isArray(gm.groundingChunks)) {
              for (const gChunk of gm.groundingChunks) {
                const uri = gChunk.web?.uri?.trim();
                if (!uri) continue;
                const title = gChunk.web?.title?.trim() || uri;
                if (!groundingSourcesMap.has(uri)) {
                  groundingSourcesMap.set(uri, { title, uri });
                }
              }
            }
          }

          const parts = chunk.candidates?.[0]?.content?.parts ?? [];
          for (const part of parts) {
            const pAny = part as Part & {
              thought?: boolean;
              thoughtSignature?: string;
              toolCall?: { id?: string; toolType?: string; args?: Record<string, unknown> };
              toolResponse?: unknown;
            };
            const textPiece = typeof pAny.text === 'string' ? pAny.text : '';

            if (pAny.thought) {
              if (textPiece) {
                if (thoughtStartMs === null) thoughtStartMs = Date.now();
                thoughtEndMs = Date.now();
                thoughtsAccum += textPiece;
                emitEvent({ type: 'thought', delta: textPiece });
              }
              continue;
            }

            if (pAny.functionCall) {
              modelParts.push(part);
              functionCalls.push({
                id: pAny.functionCall.id,
                name: pAny.functionCall.name ?? '',
                args: (pAny.functionCall.args as Record<string, unknown>) ?? {},
              });
            } else if (pAny.toolCall || pAny.toolResponse) {
              // Preserve server-side tool invocation & response parts for multi-turn hybrid grounding
              modelParts.push(part);
            } else if (textPiece || pAny.thoughtSignature) {
              if (textPiece) turnText += textPiece;
              const last = modelParts[modelParts.length - 1] as
                | (Part & { thoughtSignature?: string })
                | undefined;
              if (
                last &&
                typeof last.text === 'string' &&
                !last.functionCall &&
                !last.toolCall &&
                !last.toolResponse &&
                !last.thoughtSignature &&
                !pAny.thoughtSignature
              ) {
                last.text += textPiece;
              } else {
                modelParts.push({ ...part });
              }
            } else {
              modelParts.push(part);
            }
          }
        }

        if (clientClosed || abortController.signal.aborted) break;

        if (modelParts.length > 0) {
          contents.push({ role: 'model', parts: modelParts });
        }

        if (functionCalls.length === 0) {
          finalAnswerText = turnText.trim();
          break;
        }

        const responseParts: Part[] = [];
        for (let i = 0; i < functionCalls.length; i++) {
          const fc = functionCalls[i];
          const toolOut = await executeTool(fc.name, fc.args, i + turn * 20);
          responseParts.push({
            functionResponse: {
              id: fc.id,
              name: fc.name,
              response: toolOut,
            },
          });
        }

        contents.push({ role: 'user', parts: responseParts });
      }

      if (clientClosed || abortController.signal.aborted) {
        if (!res.writableEnded) res.end();
        return;
      }

      const patches = isPlanMode ? [] : Array.from(stagedPatches.values());
      const thinkingDurationMs =
        thoughtStartMs !== null
          ? Math.max(200, (thoughtEndMs ?? Date.now()) - thoughtStartMs)
          : Date.now() - startedAt;

      emitEvent({
        type: 'activity',
        activity: {
          id: 'phase-think',
          kind: 'think',
          label: isPlanMode ? 'Analyzed architecture & plan' : 'Completed workspace execution',
          status: 'done',
        },
      });
      emitEvent({
        type: 'activity',
        activity: {
          id: 'phase-draft',
          kind: 'done',
          label: isPlanMode
            ? 'Plan ready'
            : `Prepared ${patches.length} file change(s)`,
          status: 'done',
        },
      });

      emitEvent({
        type: 'result',
        summary:
          finalAnswerText ||
          (patches.length > 0
            ? `Prepared ${patches.length} file change(s) for review.`
            : 'Completed workspace analysis.'),
        steps: [],
        patches,
        thoughts: thoughtsAccum.trim(),
        thinkingDurationMs,
        sources: Array.from(groundingSourcesMap.values()),
        searchQueries: Array.from(searchQueriesSet),
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
      const createdProjectsMap = new Map<
        string,
        { id: string; name: string; description: string; language: string }
      >();

      const createProjectDecl: FunctionDeclaration = {
        name: 'create_project',
        description:
          'Create a brand-new starter project workspace with folders and starter files. Automatically registers it on the Home screen project list. Create-only: never overwrites existing files.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            project_name: {
              type: Type.STRING,
              description: 'Slug folder name (letters, numbers, hyphens, underscores).',
            },
            description: { type: Type.STRING, description: 'Short 1-line project summary.' },
            language: { type: Type.STRING, description: 'Primary language (e.g. Rust, TypeScript, Python).' },
            folders: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: 'Optional relative folder paths to create inside the project.',
            },
            files: {
              type: Type.ARRAY,
              description: 'Starter files to create inside the project.',
              items: {
                type: Type.OBJECT,
                properties: {
                  path: { type: Type.STRING, description: 'Relative path inside project.' },
                  content: { type: Type.STRING, description: 'Initial file content.' },
                },
                required: ['path', 'content'],
              },
            },
          },
          required: ['project_name', 'description', 'language', 'files'],
        },
      };

      const createFolderDecl: FunctionDeclaration = {
        name: 'create_folder',
        description:
          'Create a new folder inside a project workspace (creates the project if it is new). Does not modify or delete existing files.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            project_name: { type: Type.STRING, description: 'Project directory slug.' },
            folder_path: { type: Type.STRING, description: 'Relative folder path inside project.' },
          },
          required: ['project_name', 'folder_path'],
        },
      };

      const createFileDecl: FunctionDeclaration = {
        name: 'create_file',
        description:
          'Create a NEW file inside a project workspace. Strictly create-only: fails if the file already exists (Quick Chat cannot edit existing files).',
        parameters: {
          type: Type.OBJECT,
          properties: {
            project_name: { type: Type.STRING, description: 'Project directory slug.' },
            file_path: { type: Type.STRING, description: 'Relative file path inside project.' },
            content: { type: Type.STRING, description: 'Initial content for the new file.' },
          },
          required: ['project_name', 'file_path', 'content'],
        },
      };

      const sanitizeProjectSlug = (raw: string): string => {
        const slug = raw
          .trim()
          .replace(/[^a-zA-Z0-9_-]+/g, '-')
          .replace(/^-+|-+$/g, '');
        if (!slug) throw new Error('Project name must contain letters or numbers.');
        return slug;
      };

      const ensureProjectRegistered = async (
        slug: string,
        description = 'Project created via Quick Chat',
        language = 'Folder'
      ) => {
        const { root } = resolveSafeWorkspacePath(slug);
        let existed = true;
        try {
          await fs.access(root);
        } catch {
          existed = false;
        }
        await fs.mkdir(root, { recursive: true });
        if (!existed) {
          await fs.writeFile(
            path.join(root, '.aetheris-project.json'),
            JSON.stringify({ description, language }, null, 2),
            'utf-8'
          );
        }
        createdProjectsMap.set(slug, { id: slug, name: slug, description, language });
        return { root, existed };
      };

      const runQuickChatTool = async (
        name: string,
        args: Record<string, unknown>
      ): Promise<Record<string, unknown>> => {
        try {
          if (name === 'create_project') {
            const slug = sanitizeProjectSlug(String(args.project_name ?? ''));
            const description = String(args.description ?? 'Project created via Quick Chat').slice(0, 120);
            const language = String(args.language ?? 'Folder').slice(0, 40);
            const folders = Array.isArray(args.folders) ? (args.folders as string[]) : [];
            const files = Array.isArray(args.files)
              ? (args.files as Array<{ path?: string; content?: string }>)
              : [];

            const { root, existed } = await ensureProjectRegistered(slug, description, language);
            if (existed) {
              return {
                error: `Project "${slug}" already exists. Quick Chat only creates new projects/files and cannot overwrite existing projects.`,
              };
            }

            for (const folder of folders) {
              const { target } = resolveSafeWorkspacePath(slug, String(folder));
              await fs.mkdir(target, { recursive: true });
            }

            const createdFiles: string[] = [];
            for (const f of files) {
              const rel = String(f.path ?? '').replace(/^\/+/, '');
              if (!rel) continue;
              const { target } = resolveSafeWorkspacePath(slug, rel);
              await fs.mkdir(path.dirname(target), { recursive: true });
              await fs.writeFile(target, String(f.content ?? ''), { encoding: 'utf-8', flag: 'wx' });
              createdFiles.push(rel);
            }

            if (createdFiles.length === 0) {
              await fs.writeFile(
                path.join(root, 'README.md'),
                `# ${slug}\n\n${description}\n`,
                { encoding: 'utf-8', flag: 'wx' }
              );
              createdFiles.push('README.md');
            }

            return { ok: true, project: slug, createdFiles };
          }

          if (name === 'create_folder') {
            const slug = sanitizeProjectSlug(String(args.project_name ?? ''));
            const folderPath = String(args.folder_path ?? '').replace(/^\/+/, '');
            await ensureProjectRegistered(slug);
            const { target } = resolveSafeWorkspacePath(slug, folderPath);
            await fs.mkdir(target, { recursive: true });
            return { ok: true, project: slug, folder: folderPath };
          }

          if (name === 'create_file') {
            const slug = sanitizeProjectSlug(String(args.project_name ?? ''));
            const rel = String(args.file_path ?? '').replace(/^\/+/, '');
            const content = String(args.content ?? '');
            await ensureProjectRegistered(slug);
            const { target } = resolveSafeWorkspacePath(slug, rel);
            await fs.mkdir(path.dirname(target), { recursive: true });
            try {
              await fs.writeFile(target, content, { encoding: 'utf-8', flag: 'wx' });
            } catch (err) {
              if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') {
                return {
                  error: `Permission denied: "${rel}" already exists. Quick Chat has create-only permissions and cannot edit existing files.`,
                };
              }
              throw err;
            }
            return { ok: true, project: slug, file: rel };
          }

          return { error: `Unknown tool: ${name}` };
        } catch (err) {
          return { error: err instanceof Error ? err.message : 'Tool failed' };
        }
      };

      const contents: Content[] = cleaned.slice(-16).map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

      let replyText = '';
      const groundingSourcesMap = new Map<string, { title: string; uri: string }>();
      const searchQueriesSet = new Set<string>();

      for (let turn = 0; turn < 8; turn++) {
        const response = await ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents,
          config: {
            systemInstruction:
              'You are Aetheris Quick Chat on the Home Screen. You help users brainstorm, look up current technical information via Google Search, or start new projects. PERMISSIONS: You have CREATE-ONLY workspace permissions via create_project, create_folder, and create_file. You MUST NEVER edit, overwrite, or delete existing files (if the user asks to modify an existing file or project, explain that Quick Chat is create-only and they should open the project in the IDE editor to edit files). Whenever the user asks to create a new project, call create_project (or create_folder/create_file) immediately—the created project is automatically added to the Home screen list. Use Google Search grounding whenever up-to-date web facts, documentation, or current information are needed.',
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
            tools: [
              { googleSearch: {} },
              { functionDeclarations: [createProjectDecl, createFolderDecl, createFileDecl] },
            ],
            toolConfig: { includeServerSideToolInvocations: true },
          },
        });

        const gm = response.candidates?.[0]?.groundingMetadata;
        if (gm) {
          if (Array.isArray(gm.webSearchQueries)) {
            for (const q of gm.webSearchQueries) {
              if (typeof q === 'string' && q.trim()) searchQueriesSet.add(q.trim());
            }
          }
          if (Array.isArray(gm.groundingChunks)) {
            for (const gChunk of gm.groundingChunks) {
              const uri = gChunk.web?.uri?.trim();
              if (!uri) continue;
              const title = gChunk.web?.title?.trim() || uri;
              if (!groundingSourcesMap.has(uri)) {
                groundingSourcesMap.set(uri, { title, uri });
              }
            }
          }
        }

        const candidateContent = response.candidates?.[0]?.content;
        const calls = response.functionCalls ?? [];
        if (candidateContent) {
          contents.push(candidateContent);
        }
        if (calls.length === 0) {
          replyText = (response.text ?? '').trim();
          break;
        }

        const respParts: Part[] = [];
        for (const call of calls) {
          const result = await runQuickChatTool(
            call.name ?? '',
            (call.args as Record<string, unknown>) ?? {}
          );
          respParts.push({
            functionResponse: {
              id: call.id,
              name: call.name ?? '',
              response: result,
            },
          });
        }
        contents.push({ role: 'user', parts: respParts });
      }

      res.json({
        reply: replyText || 'Done.',
        createdProjects: Array.from(createdProjectsMap.values()),
        sources: Array.from(groundingSourcesMap.values()),
        searchQueries: Array.from(searchQueriesSet),
      });
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

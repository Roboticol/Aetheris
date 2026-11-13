import 'dotenv/config';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
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

async function addDirToZip(zip: JSZip, diskDir: string, zipPrefix: string): Promise<void> {
  const entries = await fs.readdir(diskDir, { withFileTypes: true });
  for (const entry of entries) {
    if (['node_modules', 'dist', 'target', '.git'].includes(entry.name)) continue;
    const full = path.join(diskDir, entry.name);
    const targetZipPath = zipPrefix ? `${zipPrefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await addDirToZip(zip, full, targetZipPath);
    } else {
      const buf = await fs.readFile(full);
      zip.file(targetZipPath, buf);
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

async function startServer() {
  await ensureStartersSeeded();

  const app = express();
  app.use(express.json({ limit: '8mb' }));

  app.get('/api/workspaces', (_req, res) => {
    res.json({
      workspaces: STARTER_TEMPLATES.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        language: t.language,
      })),
    });
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
    try {
      const { prompt, activeFile, files, thinkingMode } = req.body as {
        prompt: string;
        activeFile?: string | null;
        files: Array<{ path: string; content: string }>;
        thinkingMode?: 'fast' | 'deep';
      };

      if (!prompt || !prompt.trim()) {
        res.status(400).json({ error: 'Prompt is required.' });
        return;
      }

      const ai = getGeminiClient();
      const contextFiles = (files ?? [])
        .slice(0, 28)
        .map((f) => `--- FILE: ${f.path} ---\n${f.content.slice(0, 18000)}`)
        .join('\n\n');

      const thinkingLevel = thinkingMode === 'deep' ? ThinkingLevel.HIGH : ThinkingLevel.LOW;

      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: `Active editor file: ${activeFile ?? 'none'}\n\nUser request:\n${prompt}\n\nWorkspace context:\n${contextFiles}`,
        config: {
          systemInstruction:
            'You are Aetheris, a senior autonomous multi-file coding agent inside a lightweight Rust-native IDE. Inspect the provided workspace files carefully. Respond with a concise engineering summary, clear verification/inspection steps you took, and structured multi-file patches. Whenever creating or modifying a file, provide the COMPLETE updated file content (never truncate with ellipses or placeholders). If the user only asks a question without requesting code edits, return an empty patches array.',
          thinkingConfig: { thinkingLevel },
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              summary: {
                type: Type.STRING,
                description: 'Clear, concise technical explanation of findings and proposed edits.',
              },
              steps: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: 'Ordered trace of workspace inspection and editing steps.',
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

      const raw = (response.text ?? '{}').trim();
      const parsed = JSON.parse(raw) as {
        summary?: string;
        steps?: string[];
        patches?: Array<{ path: string; action: string; rationale: string; content: string }>;
      };

      res.json({
        summary: parsed.summary ?? 'Completed workspace analysis.',
        steps: Array.isArray(parsed.steps) ? parsed.steps : [],
        patches: Array.isArray(parsed.patches) ? parsed.patches : [],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Agent request failed';
      res.status(500).json({ error: message });
    }
  });

  app.get('/api/desktop-bundle', async (_req, res) => {
    try {
      const zip = new JSZip();
      const rootFolder = zip.folder('aetheris-desktop');
      if (!rootFolder) throw new Error('Failed to initialize zip archive');

      const dirsToInclude = ['src-tauri', 'src'];
      for (const d of dirsToInclude) {
        const diskPath = path.join(__dirname, d);
        await addDirToZip(rootFolder, diskPath, d);
      }

      const rootFiles = ['README.md', 'package.json', 'tsconfig.json', 'vite.config.ts', 'index.html', 'metadata.json'];
      for (const f of rootFiles) {
        try {
          const buf = await fs.readFile(path.join(__dirname, f));
          rootFolder.file(f, buf);
        } catch {
          // Optional file skipped if absent
        }
      }

      const archiveBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="aetheris-rust-desktop.zip"');
      res.send(archiveBuffer);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to build desktop bundle' });
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

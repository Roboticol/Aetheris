import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Pencil,
  Search,
  Trash2,
} from 'lucide-react';
import {
  ExplorerGitBadge,
  FileNode,
  GitFileEntry,
  GitStatusSnapshot,
  SearchHit,
  WorkspaceSource,
} from '../types/ide';
import { GitHubPanel } from './GitHubPanel';
import { Tooltip } from './Tooltip';

interface ExplorerSidebarProps {
  width: number;
  tree: FileNode[];
  activeFilePath: string | null;
  dirtyPaths: Set<string>;
  searchHits: SearchHit[];
  searchQuery: string;
  symbolsOnly: boolean;
  isSearching: boolean;
  onSelectFile: (path: string, line?: number) => void;
  onCreateEntry: (relPath: string, kind: 'file' | 'dir') => Promise<void>;
  onRenameEntry: (oldPath: string, newPath: string) => Promise<void>;
  onDeleteEntry: (relPath: string) => Promise<void>;
  onSearchChange: (query: string, symbolsOnly: boolean) => void;
  activeTab: 'files' | 'search' | 'github';
  onTabChange: (tab: 'files' | 'search' | 'github') => void;
  workspaceSource: WorkspaceSource;
  gitStatus: GitStatusSnapshot | null;
  isGitLoading: boolean;
  isGitBusy: boolean;
  onGitRefresh: () => Promise<void>;
  onGitInitRepo: () => Promise<void>;
  onGitStage: (paths: string[], all?: boolean) => Promise<void>;
  onGitUnstage: (paths: string[], all?: boolean) => Promise<void>;
  onGitDiscard: (path: string, untracked: boolean) => Promise<void>;
  onGitCommit: (params: {
    message: string;
    stageAllIfEmpty?: boolean;
    userName?: string;
    userEmail?: string;
  }) => Promise<boolean>;
  onGitGenerateCommitMessage: () => Promise<string>;
  onGitBranchAction: (action: 'checkout' | 'create', name: string) => Promise<void>;
  onGitSetRemote: (url: string) => Promise<void>;
  onGitSync: (action: 'fetch' | 'pull' | 'push' | 'sync') => Promise<void>;
  onOpenGitDiff: (entry: GitFileEntry) => void;
}

const GITHUB_SPLIT_KEY = 'aetheris.githubSplitPct';

function loadGithubSplit(): number {
  try {
    const raw = localStorage.getItem(GITHUB_SPLIT_KEY);
    if (!raw) return 56;
    const val = Number(raw);
    return Number.isFinite(val) ? Math.min(78, Math.max(24, val)) : 56;
  } catch {
    return 56;
  }
}

function getFileIconColor(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.rs')) return 'text-amber-400';
  if (lower.endsWith('.ts') || lower.endsWith('.tsx')) return 'text-sky-400';
  if (lower.endsWith('.js') || lower.endsWith('.jsx') || lower.endsWith('.mjs')) return 'text-yellow-300';
  if (lower.endsWith('.py')) return 'text-emerald-400';
  if (lower.endsWith('.json') || lower.endsWith('.toml')) return 'text-indigo-400';
  return 'text-[#8B92A5]';
}

function getBadgeMeta(badge: ExplorerGitBadge): {
  symbol: string;
  colorClass: string;
  nameColorClass: string;
  tooltip: string;
} {
  switch (badge) {
    case 'M':
      return {
        symbol: 'M',
        colorClass: 'text-amber-400',
        nameColorClass: 'text-amber-200',
        tooltip: 'Modified (uncommitted)',
      };
    case 'A':
      return {
        symbol: 'A',
        colorClass: 'text-emerald-400',
        nameColorClass: 'text-emerald-200',
        tooltip: 'Added / Staged',
      };
    case 'U':
      return {
        symbol: 'U',
        colorClass: 'text-emerald-400',
        nameColorClass: 'text-emerald-200',
        tooltip: 'Untracked (new file)',
      };
    case 'D':
      return {
        symbol: 'D',
        colorClass: 'text-red-400',
        nameColorClass: 'text-red-300',
        tooltip: 'Deleted',
      };
    case 'R':
      return {
        symbol: 'R',
        colorClass: 'text-sky-400',
        nameColorClass: 'text-sky-200',
        tooltip: 'Renamed',
      };
    case 'C':
      return {
        symbol: '!',
        colorClass: 'text-rose-400',
        nameColorClass: 'text-rose-300',
        tooltip: 'Merge conflict',
      };
    case 'unpushed':
      return {
        symbol: '↑',
        colorClass: 'text-[#818CF8]',
        nameColorClass: 'text-[#C7D2FE]',
        tooltip: 'Committed locally — waiting to push',
      };
    case 'pushed':
      return {
        symbol: '✓',
        colorClass: 'text-emerald-400/75',
        nameColorClass: '',
        tooltip: 'Pushed to GitHub remote',
      };
  }
}

export const ExplorerSidebar: React.FC<ExplorerSidebarProps> = ({
  width,
  tree,
  activeFilePath,
  dirtyPaths,
  searchHits,
  searchQuery,
  symbolsOnly,
  isSearching,
  onSelectFile,
  onCreateEntry,
  onRenameEntry,
  onDeleteEntry,
  onSearchChange,
  activeTab,
  onTabChange,
  workspaceSource,
  gitStatus,
  isGitLoading,
  isGitBusy,
  onGitRefresh,
  onGitInitRepo,
  onGitStage,
  onGitUnstage,
  onGitDiscard,
  onGitCommit,
  onGitGenerateCommitMessage,
  onGitBranchAction,
  onGitSetRemote,
  onGitSync,
  onOpenGitDiff,
}) => {
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set(['src']));
  const [creatingKind, setCreatingKind] = useState<'file' | 'dir' | null>(null);
  const [createValue, setCreateValue] = useState('');
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [githubSplitPct, setGithubSplitPct] = useState<number>(() => loadGithubSplit());
  const [isSplittingGithub, setIsSplittingGithub] = useState(false);

  const githubBodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      for (const node of tree) {
        if (node.kind === 'dir' && (node.name === 'src' || node.name === 'src-tauri')) {
          next.add(node.path);
        }
      }
      return next;
    });
  }, [tree]);

  useEffect(() => {
    try {
      localStorage.setItem(GITHUB_SPLIT_KEY, String(githubSplitPct));
    } catch {
      // Storage quota ignored
    }
  }, [githubSplitPct]);

  const { fileBadgeMap, dirDotMap, totalGitChanges } = useMemo(() => {
    const fileMap = new Map<string, ExplorerGitBadge>();
    const dirMap = new Map<string, 'dirty' | 'unpushed' | 'pushed'>();

    if (gitStatus?.isRepo) {
      for (const p of gitStatus.pushedFiles) {
        fileMap.set(p, 'pushed');
      }
      for (const p of gitStatus.unpushedFiles) {
        fileMap.set(p, 'unpushed');
      }
      for (const entry of gitStatus.staged) {
        fileMap.set(entry.path, entry.status);
      }
      for (const entry of gitStatus.changes) {
        fileMap.set(entry.path, entry.status);
      }

      const markParents = (relPath: string, state: 'dirty' | 'unpushed' | 'pushed') => {
        const parts = relPath.split('/');
        for (let i = 1; i < parts.length; i++) {
          const parent = parts.slice(0, i).join('/');
          const current = dirMap.get(parent);
          if (state === 'dirty') {
            dirMap.set(parent, 'dirty');
          } else if (state === 'unpushed' && current !== 'dirty') {
            dirMap.set(parent, 'unpushed');
          } else if (state === 'pushed' && !current) {
            dirMap.set(parent, 'pushed');
          }
        }
      };

      for (const [p, badge] of fileMap.entries()) {
        if (badge === 'pushed') markParents(p, 'pushed');
        else if (badge === 'unpushed') markParents(p, 'unpushed');
        else markParents(p, 'dirty');
      }
    }

    const changePaths = new Set<string>();
    if (gitStatus?.isRepo) {
      for (const e of gitStatus.staged) changePaths.add(e.path);
      for (const e of gitStatus.changes) changePaths.add(e.path);
    }

    return {
      fileBadgeMap: fileMap,
      dirDotMap: dirMap,
      totalGitChanges: changePaths.size,
    };
  }, [gitStatus]);

  const startGithubSplitResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const container = githubBodyRef.current;
    if (!container) return;
    setIsSplittingGithub(true);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'row-resize';

    const onMouseMove = (moveEvent: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      if (rect.height <= 0) return;
      const pct = ((moveEvent.clientY - rect.top) / rect.height) * 100;
      setGithubSplitPct(Math.min(78, Math.max(24, Math.round(pct * 10) / 10)));
    };

    const onMouseUp = () => {
      setIsSplittingGithub(false);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  const toggleDir = (path: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const submitCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = createValue.trim().replace(/^\/+/, '');
    if (!trimmed || !creatingKind) return;
    await onCreateEntry(trimmed, creatingKind);
    setCreatingKind(null);
    setCreateValue('');
  };

  const submitRename = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = renameValue.trim().replace(/^\/+/, '');
    if (!trimmed || !renamingPath || trimmed === renamingPath) {
      setRenamingPath(null);
      return;
    }
    await onRenameEntry(renamingPath, trimmed);
    setRenamingPath(null);
    setRenameValue('');
  };

  const renderNodes = (nodes: FileNode[], depth = 0) => {
    return nodes.map((node) => {
      const isExpanded = expandedDirs.has(node.path);
      const isActive = node.kind === 'file' && node.path === activeFilePath;
      const isDirty = dirtyPaths.has(node.path);
      const gitBadge = node.kind === 'file' ? fileBadgeMap.get(node.path) : undefined;
      const badgeMeta = gitBadge ? getBadgeMeta(gitBadge) : null;
      const dirState = node.kind === 'dir' ? dirDotMap.get(node.path) : undefined;

      if (renamingPath === node.path) {
        return (
          <form
            key={node.path}
            onSubmit={submitRename}
            style={{ paddingLeft: `${depth * 14 + 10}px` }}
            className="pr-2 py-0.5"
          >
            <input
              autoFocus
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onBlur={() => setRenamingPath(null)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setRenamingPath(null);
              }}
              className="w-full rounded border border-[#6366F1] bg-[#0F1117] px-2 py-0.5 font-mono text-[12px] text-[#E6E8EE] outline-none"
            />
          </form>
        );
      }

      return (
        <div key={node.path}>
          <div
            style={{ paddingLeft: `${depth * 14 + 8}px` }}
            onClick={() => {
              if (node.kind === 'dir') toggleDir(node.path);
              else onSelectFile(node.path);
            }}
            className={`group flex h-7 cursor-pointer items-center justify-between pr-2 text-[12.5px] transition-colors ${
              isActive
                ? 'bg-[#6366F1]/15 text-[#E6E8EE]'
                : 'text-[#B5BBC9] hover:bg-[#1E222E] hover:text-[#E6E8EE]'
            }`}
          >
            <div className="flex min-w-0 items-center gap-1.5">
              {node.kind === 'dir' ? (
                <>
                  {isExpanded ? (
                    <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[#8B92A5]" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[#8B92A5]" />
                  )}
                  {isExpanded ? (
                    <FolderOpen className="h-3.5 w-3.5 shrink-0 text-[#818CF8]" />
                  ) : (
                    <Folder className="h-3.5 w-3.5 shrink-0 text-[#8B92A5]" />
                  )}
                </>
              ) : (
                <>
                  <span className="w-3.5 shrink-0" />
                  {node.name.endsWith('.md') || node.name.endsWith('.txt') ? (
                    <FileText className={`h-3.5 w-3.5 shrink-0 ${getFileIconColor(node.name)}`} />
                  ) : (
                    <FileCode2 className={`h-3.5 w-3.5 shrink-0 ${getFileIconColor(node.name)}`} />
                  )}
                </>
              )}
              <span
                className={`truncate font-medium ${
                  badgeMeta?.nameColorClass ? badgeMeta.nameColorClass : ''
                }`}
              >
                {node.name}
              </span>
            </div>

            <div className="flex items-center gap-1 shrink-0">
              <div
                className="hidden group-hover:flex items-center gap-0.5"
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  type="button"
                  aria-label={`Rename ${node.name}`}
                  onClick={() => {
                    setRenamingPath(node.path);
                    setRenameValue(node.path);
                  }}
                  className="rounded p-1 text-[#8B92A5] hover:bg-[#272B38] hover:text-[#E6E8EE]"
                >
                  <Pencil className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  aria-label={`Delete ${node.name}`}
                  onClick={() => onDeleteEntry(node.path)}
                  className="rounded p-1 text-[#8B92A5] hover:bg-[#272B38] hover:text-red-400"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>

              {isDirty && (
                <Tooltip label="Unsaved buffer changes">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                </Tooltip>
              )}

              {badgeMeta && (
                <Tooltip label={badgeMeta.tooltip}>
                  <span
                    className={`w-3.5 text-center font-mono text-[10.5px] font-bold ${badgeMeta.colorClass}`}
                  >
                    {badgeMeta.symbol}
                  </span>
                </Tooltip>
              )}

              {dirState && (
                <Tooltip
                  label={
                    dirState === 'dirty'
                      ? 'Contains uncommitted changes'
                      : dirState === 'unpushed'
                        ? 'Contains unpushed commits'
                        : 'Synced with GitHub'
                  }
                >
                  <span
                    className={`mr-0.5 h-1.5 w-1.5 rounded-full ${
                      dirState === 'dirty'
                        ? 'bg-amber-400'
                        : dirState === 'unpushed'
                          ? 'bg-[#818CF8]'
                          : 'bg-emerald-400/60'
                    }`}
                  />
                </Tooltip>
              )}
            </div>
          </div>

          {node.kind === 'dir' && isExpanded && node.children && (
            <div>{renderNodes(node.children, depth + 1)}</div>
          )}
        </div>
      );
    });
  };

  const renderExplorerContent = (compactHeader = false) => (
    <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
      {compactHeader && (
        <div className="flex h-7 shrink-0 items-center justify-between border-b border-[#272B38] bg-[#161922] px-2.5">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-[#B5BBC9]">
            Explorer
          </span>
          <div className="flex items-center gap-0.5">
            <Tooltip label="New File">
              <button
                type="button"
                aria-label="New File"
                onClick={() => {
                  setCreatingKind('file');
                  setCreateValue('');
                }}
                className="rounded p-1 text-[#8B92A5] hover:bg-[#1E222E] hover:text-[#E6E8EE] transition-colors"
              >
                <FilePlus className="h-3.5 w-3.5" />
              </button>
            </Tooltip>
            <Tooltip label="New Folder">
              <button
                type="button"
                aria-label="New Folder"
                onClick={() => {
                  setCreatingKind('dir');
                  setCreateValue('');
                }}
                className="rounded p-1 text-[#8B92A5] hover:bg-[#1E222E] hover:text-[#E6E8EE] transition-colors"
              >
                <FolderPlus className="h-3.5 w-3.5" />
              </button>
            </Tooltip>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto py-1">
        {creatingKind && (
          <form onSubmit={submitCreate} className="px-2.5 py-1.5">
            <input
              autoFocus
              placeholder={creatingKind === 'file' ? 'src/new_file.rs' : 'src/module'}
              value={createValue}
              onChange={(e) => setCreateValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setCreatingKind(null);
                  setCreateValue('');
                }
              }}
              className="w-full rounded border border-[#6366F1] bg-[#0F1117] px-2 py-1 font-mono text-[12px] text-[#E6E8EE] placeholder-[#52596E] outline-none"
            />
          </form>
        )}

        {tree.length === 0 ? (
          <div className="px-4 py-8 text-center text-[12px] text-[#8B92A5]">
            Empty workspace. Create a file or open a local folder.
          </div>
        ) : (
          renderNodes(tree)
        )}
      </div>
    </div>
  );

  return (
    <aside
      style={{ width }}
      className="flex h-full shrink-0 flex-col border-r border-[#272B38] bg-[#161922] select-none min-w-0"
    >
      {/* Segmented Switcher: Explorer / Search / GitHub */}
      <div className="flex items-center justify-between gap-1 border-b border-[#272B38] px-2 py-1.5">
        <div className="flex items-center gap-0.5 rounded-md bg-[#0F1117] p-0.5 min-w-0">
          <button
            type="button"
            onClick={() => onTabChange('files')}
            className={`rounded px-2 py-1 text-[11.5px] font-medium transition-colors whitespace-nowrap shrink-0 ${
              activeTab === 'files'
                ? 'bg-[#1E222E] text-[#E6E8EE]'
                : 'text-[#8B92A5] hover:text-[#E6E8EE]'
            }`}
          >
            Explorer
          </button>
          <button
            type="button"
            onClick={() => onTabChange('search')}
            className={`rounded px-2 py-1 text-[11.5px] font-medium transition-colors whitespace-nowrap shrink-0 ${
              activeTab === 'search'
                ? 'bg-[#1E222E] text-[#E6E8EE]'
                : 'text-[#8B92A5] hover:text-[#E6E8EE]'
            }`}
          >
            Search
          </button>
          <button
            type="button"
            onClick={() => onTabChange('github')}
            className={`flex items-center gap-1 rounded px-2 py-1 text-[11.5px] font-medium transition-colors whitespace-nowrap shrink-0 ${
              activeTab === 'github'
                ? 'bg-[#1E222E] text-[#E6E8EE]'
                : 'text-[#8B92A5] hover:text-[#E6E8EE]'
            }`}
          >
            <span>GitHub</span>
            {totalGitChanges > 0 && (
              <span className="rounded bg-[#6366F1]/25 px-1 text-[10px] font-mono tabular-nums text-[#818CF8]">
                {totalGitChanges}
              </span>
            )}
          </button>
        </div>

        {activeTab === 'files' && (
          <div className="flex items-center gap-0.5 shrink-0">
            <Tooltip label="New File">
              <button
                type="button"
                aria-label="New File"
                onClick={() => {
                  setCreatingKind('file');
                  setCreateValue('');
                }}
                className="rounded p-1 text-[#8B92A5] hover:bg-[#1E222E] hover:text-[#E6E8EE] transition-colors"
              >
                <FilePlus className="h-3.5 w-3.5" />
              </button>
            </Tooltip>
            <Tooltip label="New Folder">
              <button
                type="button"
                aria-label="New Folder"
                onClick={() => {
                  setCreatingKind('dir');
                  setCreateValue('');
                }}
                className="rounded p-1 text-[#8B92A5] hover:bg-[#1E222E] hover:text-[#E6E8EE] transition-colors"
              >
                <FolderPlus className="h-3.5 w-3.5" />
              </button>
            </Tooltip>
          </div>
        )}
      </div>

      {activeTab === 'files' ? (
        renderExplorerContent(false)
      ) : activeTab === 'github' ? (
        <div ref={githubBodyRef} className="flex flex-1 min-h-0 flex-col overflow-hidden">
          {/* Top resizable pane: GitHub Source Control */}
          <div
            style={{ height: `${githubSplitPct}%` }}
            className="flex min-h-0 shrink-0 flex-col overflow-hidden"
          >
            <GitHubPanel
              workspaceSource={workspaceSource}
              status={gitStatus}
              isLoading={isGitLoading}
              isBusy={isGitBusy}
              onRefresh={onGitRefresh}
              onInitRepo={onGitInitRepo}
              onStage={onGitStage}
              onUnstage={onGitUnstage}
              onDiscard={onGitDiscard}
              onCommit={onGitCommit}
              onGenerateCommitMessage={onGitGenerateCommitMessage}
              onBranchAction={onGitBranchAction}
              onSetRemote={onGitSetRemote}
              onSync={onGitSync}
              onOpenDiff={onOpenGitDiff}
              onOpenFile={(p) => onSelectFile(p)}
            />
          </div>

          {/* Resizable Horizontal Split Bar between GitHub & File Explorer */}
          <div
            role="separator"
            aria-orientation="horizontal"
            onMouseDown={startGithubSplitResize}
            className={`h-1 shrink-0 cursor-row-resize transition-colors ${
              isSplittingGithub ? 'bg-[#6366F1]' : 'bg-[#272B38] hover:bg-[#6366F1]/80'
            }`}
          />

          {/* Bottom pane: File Explorer always visible under GitHub tab */}
          {renderExplorerContent(true)}
        </div>
      ) : (
        <div className="flex flex-1 flex-col overflow-hidden">
          <div className="border-b border-[#272B38] p-2.5 space-y-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-[#8B92A5]" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => onSearchChange(e.target.value, symbolsOnly)}
                placeholder="Search symbols or text..."
                className="w-full rounded-md border border-[#272B38] bg-[#0F1117] py-1.5 pl-8 pr-2.5 text-[12px] text-[#E6E8EE] placeholder-[#52596E] focus:border-[#6366F1] focus:outline-none"
              />
            </div>

            <div className="flex items-center justify-between text-[11.5px]">
              <label className="flex cursor-pointer items-center gap-1.5 text-[#8B92A5] hover:text-[#E6E8EE]">
                <input
                  type="checkbox"
                  checked={symbolsOnly}
                  onChange={(e) => onSearchChange(searchQuery, e.target.checked)}
                  className="accent-[#6366F1]"
                />
                <span>Symbols only</span>
              </label>
              <span className="font-mono tabular-nums text-[#8B92A5]">
                {isSearching ? 'Scanning...' : `${searchHits.length} hits`}
              </span>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto divide-y divide-[#272B38]/60">
            {searchHits.length === 0 ? (
              <div className="px-4 py-8 text-center text-[12px] text-[#8B92A5]">
                {searchQuery.trim()
                  ? 'No matching symbols or lines found.'
                  : 'Type to search across all files or browse extracted symbols.'}
              </div>
            ) : (
              searchHits.map((hit, idx) => (
                <button
                  key={`${hit.filePath}-${hit.line}-${idx}`}
                  type="button"
                  onClick={() => onSelectFile(hit.filePath, hit.line)}
                  className="flex w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-[#1E222E] transition-colors"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-mono text-[11.5px] font-medium text-[#E6E8EE]">
                      {hit.symbolName ? (
                        <>
                          <span className="text-[#818CF8]">{hit.symbolKind}</span>{' '}
                          {hit.symbolName}
                        </>
                      ) : (
                        hit.filePath.split('/').pop()
                      )}
                    </span>
                    <span className="font-mono text-[11px] tabular-nums text-[#8B92A5] shrink-0">
                      :{hit.line}
                    </span>
                  </div>
                  <div className="truncate font-mono text-[11px] text-[#8B92A5]">
                    {hit.filePath}
                  </div>
                  <div className="truncate font-mono text-[11px] text-[#B5BBC9]">
                    {hit.preview}
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </aside>
  );
};

import React, { useEffect, useState } from 'react';
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
import { FileNode, SearchHit } from '../types/ide';
import { Tooltip } from './Tooltip';

interface ExplorerSidebarProps {
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
  activeTab: 'files' | 'search';
  onTabChange: (tab: 'files' | 'search') => void;
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

export const ExplorerSidebar: React.FC<ExplorerSidebarProps> = ({
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
}) => {
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set(['src']));
  const [creatingKind, setCreatingKind] = useState<'file' | 'dir' | null>(null);
  const [createValue, setCreateValue] = useState('');
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

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
              <span className="truncate font-medium">{node.name}</span>
              {isDirty && (
                <span className="text-[11px] font-semibold text-amber-400" title="Unsaved changes">
                  M
                </span>
              )}
            </div>

            <div
              className="hidden group-hover:flex items-center gap-0.5 shrink-0"
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
          </div>

          {node.kind === 'dir' && isExpanded && node.children && (
            <div>{renderNodes(node.children, depth + 1)}</div>
          )}
        </div>
      );
    });
  };

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-[#272B38] bg-[#161922] select-none">
      {/* Segmented Switcher: Files / Search */}
      <div className="flex items-center justify-between border-b border-[#272B38] px-2 py-1.5">
        <div className="flex items-center gap-1 rounded-md bg-[#0F1117] p-0.5">
          <button
            type="button"
            onClick={() => onTabChange('files')}
            className={`rounded px-2.5 py-1 text-[11.5px] font-medium transition-colors whitespace-nowrap shrink-0 ${
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
            className={`rounded px-2.5 py-1 text-[11.5px] font-medium transition-colors whitespace-nowrap shrink-0 ${
              activeTab === 'search'
                ? 'bg-[#1E222E] text-[#E6E8EE]'
                : 'text-[#8B92A5] hover:text-[#E6E8EE]'
            }`}
          >
            Search
          </button>
        </div>

        {activeTab === 'files' && (
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
        )}
      </div>

      {activeTab === 'files' ? (
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

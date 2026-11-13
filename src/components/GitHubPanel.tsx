import React, { useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  CloudDownload,
  CloudUpload,
  FileCode2,
  GitBranch,
  Link2,
  Loader2,
  Minus,
  MoreHorizontal,
  Plus,
  RefreshCw,
  RotateCcw,
  Sparkles,
} from 'lucide-react';
import {
  GitFileChangeStatus,
  GitFileEntry,
  GitStatusSnapshot,
  WorkspaceSource,
} from '../types/ide';
import { Tooltip } from './Tooltip';

interface GitHubPanelProps {
  workspaceSource: WorkspaceSource;
  status: GitStatusSnapshot | null;
  isLoading: boolean;
  isBusy: boolean;
  isFetching: boolean;
  autoFetch: boolean;
  lastFetchedAt: number | null;
  onToggleAutoFetch: () => void;
  onRefresh: () => Promise<void>;
  onInitRepo: () => Promise<void>;
  onStage: (paths: string[], all?: boolean) => Promise<void>;
  onUnstage: (paths: string[], all?: boolean) => Promise<void>;
  onDiscard: (path: string, untracked: boolean) => Promise<void>;
  onCommit: (params: {
    message: string;
    stageAllIfEmpty?: boolean;
    userName?: string;
    userEmail?: string;
  }) => Promise<boolean>;
  onGenerateCommitMessage: () => Promise<string>;
  onBranchAction: (action: 'checkout' | 'create', name: string) => Promise<void>;
  onSetRemote: (url: string) => Promise<void>;
  onSync: (action: 'fetch' | 'pull' | 'push' | 'sync') => Promise<void>;
  onOpenDiff: (entry: GitFileEntry) => void;
  onOpenFile: (path: string) => void;
}

function getStatusColor(status: GitFileChangeStatus): string {
  switch (status) {
    case 'A':
    case 'U':
      return 'text-emerald-400';
    case 'D':
      return 'text-red-400';
    case 'R':
      return 'text-sky-400';
    case 'C':
      return 'text-rose-400';
    default:
      return 'text-amber-400';
  }
}

function formatRepoLabel(remoteUrl: string): string {
  const cleaned = remoteUrl.replace(/\.git$/, '');
  const sshMatch = cleaned.match(/[:/]([^/:]+\/[^/]+)$/);
  return sshMatch ? sshMatch[1] : remoteUrl;
}

export const GitHubPanel: React.FC<GitHubPanelProps> = ({
  workspaceSource,
  status,
  isLoading,
  isBusy,
  isFetching,
  autoFetch,
  lastFetchedAt,
  onToggleAutoFetch,
  onRefresh,
  onInitRepo,
  onStage,
  onUnstage,
  onDiscard,
  onCommit,
  onGenerateCommitMessage,
  onBranchAction,
  onSetRemote,
  onSync,
  onOpenDiff,
  onOpenFile,
}) => {
  const [commitMessage, setCommitMessage] = useState('');
  const [isGeneratingMsg, setIsGeneratingMsg] = useState(false);
  const [authorName, setAuthorName] = useState('');
  const [authorEmail, setAuthorEmail] = useState('');

  const [stagedOpen, setStagedOpen] = useState(true);
  const [changesOpen, setChangesOpen] = useState(true);
  const [commitsOpen, setCommitsOpen] = useState(true);

  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [creatingBranch, setCreatingBranch] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');

  const [editingRemote, setEditingRemote] = useState(false);
  const [remoteInput, setRemoteInput] = useState('');

  const totalChanges = (status?.staged.length ?? 0) + (status?.changes.length ?? 0);
  const needsIdentity = Boolean(status?.isRepo && (!status.userName || !status.userEmail));

  const handleCommitSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const trimmed = commitMessage.trim();
    if (!trimmed || isBusy) return;
    const ok = await onCommit({
      message: trimmed,
      stageAllIfEmpty: (status?.staged.length ?? 0) === 0,
      userName: authorName.trim() || undefined,
      userEmail: authorEmail.trim() || undefined,
    });
    if (ok) {
      setCommitMessage('');
    }
  };

  const handleGenerateMessage = async () => {
    if (isGeneratingMsg || isBusy || totalChanges === 0) return;
    setIsGeneratingMsg(true);
    try {
      const msg = await onGenerateCommitMessage();
      if (msg) setCommitMessage(msg);
    } finally {
      setIsGeneratingMsg(false);
    }
  };

  const handleSaveRemote = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = remoteInput.trim();
    if (!trimmed) return;
    await onSetRemote(trimmed);
    setEditingRemote(false);
  };

  const handleCreateBranch = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newBranchName.trim();
    if (!trimmed) return;
    await onBranchAction('create', trimmed);
    setNewBranchName('');
    setCreatingBranch(false);
    setBranchMenuOpen(false);
  };

  if (workspaceSource === 'local-fs') {
    return (
      <div className="flex h-full flex-col justify-center p-4 text-center space-y-2.5 overflow-y-auto">
        <GitBranch className="mx-auto h-6 w-6 text-[#818CF8]" />
        <div className="text-[12.5px] font-semibold text-[#E6E8EE]">
          GitHub Source Control
        </div>
        <p className="text-[11.5px] leading-relaxed text-[#8B92A5]">
          Browser folder handles isolate local OS shell &amp; Git commands. Open this folder in the
          native Linux/Windows Aetheris app (or a workspace here) for full Git &amp; GitHub push/pull.
        </p>
      </div>
    );
  }

  if (!status || (isLoading && !status.isRepo)) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-[12px] text-[#8B92A5] gap-2">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-[#818CF8]" />
        <span>Checking Git repository...</span>
      </div>
    );
  }

  if (!status.isRepo) {
    return (
      <div className="flex h-full flex-col justify-center p-4 space-y-3 overflow-y-auto">
        <div className="text-[12.5px] font-semibold text-[#E6E8EE]">
          Source Control
        </div>
        <p className="text-[11.5px] leading-relaxed text-[#8B92A5]">
          The folder currently open does not have a Git repository initialized.
        </p>
        <button
          type="button"
          disabled={isBusy}
          onClick={() => void onInitRepo()}
          className="flex w-full items-center justify-center gap-1.5 rounded-md bg-[#6366F1] px-3 py-1.5 text-[12px] font-medium text-white hover:bg-[#818CF8] disabled:opacity-50 transition-colors"
        >
          {isBusy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <GitBranch className="h-3.5 w-3.5" />
          )}
          <span>Initialize Repository</span>
        </button>
      </div>
    );
  }

  const renderEntryRow = (entry: GitFileEntry) => {
    const parts = entry.path.split('/');
    const fileName = parts.pop() ?? entry.path;
    const dirName = parts.join('/');

    return (
      <div
        key={`${entry.staged ? 's' : 'u'}-${entry.path}`}
        onClick={() => onOpenDiff(entry)}
        className="group flex h-7 cursor-pointer items-center justify-between gap-1.5 px-2.5 text-[12px] text-[#D1D5E0] hover:bg-[#1E222E] transition-colors"
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <FileCode2 className="h-3.5 w-3.5 shrink-0 text-[#8B92A5]" />
          <span className="truncate font-medium">{fileName}</span>
          {dirName && (
            <span className="truncate font-mono text-[10.5px] text-[#8B92A5]">
              {dirName}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <div
            className="hidden group-hover:flex items-center gap-0.5"
            onClick={(e) => e.stopPropagation()}
          >
            <Tooltip label="Open File">
              <button
                type="button"
                aria-label={`Open ${entry.path}`}
                onClick={() => onOpenFile(entry.path)}
                className="rounded p-0.5 text-[#8B92A5] hover:bg-[#272B38] hover:text-[#E6E8EE]"
              >
                <FileCode2 className="h-3 w-3" />
              </button>
            </Tooltip>
            {!entry.staged && (
              <Tooltip label="Discard Changes">
                <button
                  type="button"
                  aria-label={`Discard ${entry.path}`}
                  onClick={() => void onDiscard(entry.path, entry.status === 'U')}
                  className="rounded p-0.5 text-[#8B92A5] hover:bg-[#272B38] hover:text-red-400"
                >
                  <RotateCcw className="h-3 w-3" />
                </button>
              </Tooltip>
            )}
            <Tooltip label={entry.staged ? 'Unstage Changes' : 'Stage Changes'}>
              <button
                type="button"
                aria-label={entry.staged ? `Unstage ${entry.path}` : `Stage ${entry.path}`}
                onClick={() =>
                  entry.staged
                    ? void onUnstage([entry.path], false)
                    : void onStage([entry.path], false)
                }
                className="rounded p-0.5 text-[#8B92A5] hover:bg-[#272B38] hover:text-[#E6E8EE]"
              >
                {entry.staged ? <Minus className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
              </button>
            </Tooltip>
          </div>

          <span
            className={`w-3.5 text-center font-mono text-[11px] font-bold ${getStatusColor(entry.status)}`}
          >
            {entry.status}
          </span>
        </div>
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Source Control Toolbar */}
      <div className="flex h-8 shrink-0 items-center justify-between gap-2 border-b border-[#272B38] px-2.5">
        <div className="relative flex flex-1 items-center gap-1 min-w-0">
          <button
            type="button"
            onClick={() => setBranchMenuOpen((p) => !p)}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11.5px] font-medium text-[#E6E8EE] hover:bg-[#1E222E] transition-colors min-w-0"
          >
            <GitBranch className="h-3 w-3 shrink-0 text-[#818CF8]" />
            <span className="truncate font-mono">{status.branch || 'main'}</span>
            <ChevronDown className="h-3 w-3 shrink-0 text-[#8B92A5]" />
          </button>

          {branchMenuOpen && (
            <>
              <div
                className="fixed inset-0 z-40"
                onClick={() => setBranchMenuOpen(false)}
              />
              <div className="absolute left-0 top-full z-50 mt-1 w-56 rounded-lg border border-[#272B38] bg-[#161922] p-1.5 shadow-xl">
                <div className="px-2 py-1 text-[10.5px] font-semibold uppercase tracking-wider text-[#8B92A5]">
                  Switch Branch
                </div>
                <div className="max-h-36 overflow-y-auto space-y-0.5">
                  {status.branches.map((br) => (
                    <button
                      key={br}
                      type="button"
                      onClick={() => {
                        setBranchMenuOpen(false);
                        if (br !== status.branch) {
                          void onBranchAction('checkout', br);
                        }
                      }}
                      className="flex w-full items-center justify-between rounded px-2 py-1 text-left font-mono text-[11.5px] text-[#E6E8EE] hover:bg-[#1E222E]"
                    >
                      <span className="truncate">{br}</span>
                      {br === status.branch && (
                        <Check className="h-3 w-3 text-[#818CF8] shrink-0" />
                      )}
                    </button>
                  ))}
                </div>
                <div className="my-1 h-px bg-[#272B38]" />
                {creatingBranch ? (
                  <form onSubmit={handleCreateBranch} className="p-1 space-y-1.5">
                    <input
                      autoFocus
                      value={newBranchName}
                      onChange={(e) => setNewBranchName(e.target.value)}
                      placeholder="feature/my-branch"
                      className="w-full rounded border border-[#6366F1] bg-[#0F1117] px-2 py-1 font-mono text-[11.5px] text-[#E6E8EE] outline-none"
                    />
                    <div className="flex justify-end gap-1">
                      <button
                        type="button"
                        onClick={() => setCreatingBranch(false)}
                        className="rounded px-2 py-0.5 text-[11px] text-[#8B92A5] hover:text-[#E6E8EE]"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        className="rounded bg-[#6366F1] px-2 py-0.5 text-[11px] font-medium text-white hover:bg-[#818CF8]"
                      >
                        Create
                      </button>
                    </div>
                  </form>
                ) : (
                  <button
                    type="button"
                    onClick={() => setCreatingBranch(true)}
                    className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[11.5px] text-[#818CF8] hover:bg-[#1E222E]"
                  >
                    <Plus className="h-3 w-3" />
                    <span>Create New Branch...</span>
                  </button>
                )}
              </div>
            </>
          )}
        </div>

        <div className="flex items-center gap-0.5 shrink-0">
          <Tooltip
            label={
              status.remoteUrl
                ? isFetching
                  ? 'Fetching from remote...'
                  : lastFetchedAt
                    ? `Fetch from Remote (last: ${new Date(lastFetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`
                    : 'Fetch from Remote'
                : 'Connect a remote to fetch'
            }
          >
            <button
              type="button"
              disabled={isBusy || isFetching || !status.remoteUrl}
              onClick={() => void onSync('fetch')}
              aria-label="Fetch"
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-[#8B92A5] hover:bg-[#1E222E] hover:text-[#E6E8EE] disabled:opacity-35 transition-colors"
            >
              {isFetching ? (
                <Loader2 className="h-3 w-3 animate-spin text-[#818CF8]" />
              ) : (
                <CloudDownload className="h-3 w-3" />
              )}
              <span>Fetch</span>
            </button>
          </Tooltip>
          <Tooltip label={status.behind > 0 ? `Pull (${status.behind} incoming)` : 'Pull'}>
            <button
              type="button"
              disabled={isBusy || !status.remoteUrl}
              onClick={() => void onSync('pull')}
              aria-label="Pull"
              className="relative rounded p-1 text-[#8B92A5] hover:bg-[#1E222E] hover:text-[#E6E8EE] disabled:opacity-35 transition-colors"
            >
              <ArrowDown className="h-3 w-3" />
              {status.behind > 0 && (
                <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-[#818CF8]" />
              )}
            </button>
          </Tooltip>
          <Tooltip label={status.ahead > 0 ? `Push (${status.ahead} outgoing)` : 'Push'}>
            <button
              type="button"
              disabled={isBusy || !status.remoteUrl}
              onClick={() => void onSync('push')}
              aria-label="Push"
              className="relative rounded p-1 text-[#8B92A5] hover:bg-[#1E222E] hover:text-[#E6E8EE] disabled:opacity-35 transition-colors"
            >
              <ArrowUp className="h-3 w-3" />
              {status.ahead > 0 && (
                <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-emerald-400" />
              )}
            </button>
          </Tooltip>
          <Tooltip label="Refresh">
            <button
              type="button"
              disabled={isLoading}
              onClick={() => void onRefresh()}
              aria-label="Refresh Status"
              className="rounded p-1 text-[#8B92A5] hover:bg-[#1E222E] hover:text-[#E6E8EE] transition-colors"
            >
              <RefreshCw className={`h-3 w-3 ${isLoading ? 'animate-spin' : ''}`} />
            </button>
          </Tooltip>

          <div className="relative">
            <Tooltip label="Views and More Actions...">
              <button
                type="button"
                onClick={() => setMoreMenuOpen((p) => !p)}
                aria-label="More Source Control Actions"
                className="rounded p-1 text-[#8B92A5] hover:bg-[#1E222E] hover:text-[#E6E8EE] transition-colors"
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>
            </Tooltip>

            {moreMenuOpen && (
              <>
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => setMoreMenuOpen(false)}
                />
                <div className="absolute right-0 top-full z-50 mt-1 w-52 rounded-lg border border-[#272B38] bg-[#161922] p-1 shadow-xl text-[11.5px]">
                  <button
                    type="button"
                    disabled={isBusy || isFetching || !status.remoteUrl}
                    onClick={() => {
                      setMoreMenuOpen(false);
                      void onSync('fetch');
                    }}
                    className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-[#E6E8EE] hover:bg-[#1E222E] disabled:opacity-40"
                  >
                    <span>Fetch</span>
                    <CloudDownload className="h-3 w-3 text-[#8B92A5]" />
                  </button>
                  <button
                    type="button"
                    disabled={isBusy || !status.remoteUrl}
                    onClick={() => {
                      setMoreMenuOpen(false);
                      void onSync('pull');
                    }}
                    className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-[#E6E8EE] hover:bg-[#1E222E] disabled:opacity-40"
                  >
                    <span>Pull</span>
                    <ArrowDown className="h-3 w-3 text-[#8B92A5]" />
                  </button>
                  <button
                    type="button"
                    disabled={isBusy || !status.remoteUrl}
                    onClick={() => {
                      setMoreMenuOpen(false);
                      void onSync('push');
                    }}
                    className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-[#E6E8EE] hover:bg-[#1E222E] disabled:opacity-40"
                  >
                    <span>Push</span>
                    <ArrowUp className="h-3 w-3 text-[#8B92A5]" />
                  </button>
                  <button
                    type="button"
                    disabled={isBusy || !status.remoteUrl}
                    onClick={() => {
                      setMoreMenuOpen(false);
                      void onSync('sync');
                    }}
                    className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-[#E6E8EE] hover:bg-[#1E222E] disabled:opacity-40"
                  >
                    <span>Pull, Push (Sync)</span>
                    <RefreshCw className="h-3 w-3 text-[#8B92A5]" />
                  </button>

                  <div className="my-1 h-px bg-[#272B38]" />

                  <button
                    type="button"
                    disabled={isBusy || status.changes.length === 0}
                    onClick={() => {
                      setMoreMenuOpen(false);
                      void onStage([], true);
                    }}
                    className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-[#E6E8EE] hover:bg-[#1E222E] disabled:opacity-40"
                  >
                    <span>Stage All Changes</span>
                    <Plus className="h-3 w-3 text-[#8B92A5]" />
                  </button>
                  <button
                    type="button"
                    disabled={isBusy || status.staged.length === 0}
                    onClick={() => {
                      setMoreMenuOpen(false);
                      void onUnstage([], true);
                    }}
                    className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-[#E6E8EE] hover:bg-[#1E222E] disabled:opacity-40"
                  >
                    <span>Unstage All Changes</span>
                    <Minus className="h-3 w-3 text-[#8B92A5]" />
                  </button>

                  <div className="my-1 h-px bg-[#272B38]" />

                  <button
                    type="button"
                    onClick={() => {
                      onToggleAutoFetch();
                      setMoreMenuOpen(false);
                    }}
                    className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-[#E6E8EE] hover:bg-[#1E222E]"
                  >
                    <span>Auto-Fetch (3m)</span>
                    {autoFetch && <Check className="h-3 w-3 text-[#818CF8]" />}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Scrollable Body */}
      <div className="flex-1 overflow-y-auto">
        {/* GitHub Remote Origin Strip */}
        <div className="border-b border-[#272B38]/80 px-2.5 py-2 space-y-1.5">
          {editingRemote ? (
            <form onSubmit={handleSaveRemote} className="space-y-1.5">
              <input
                autoFocus
                value={remoteInput}
                onChange={(e) => setRemoteInput(e.target.value)}
                placeholder="https://github.com/user/repo.git"
                className="w-full rounded border border-[#6366F1] bg-[#0F1117] px-2 py-1 font-mono text-[11px] text-[#E6E8EE] placeholder-[#52596E] outline-none"
              />
              <div className="flex justify-end gap-1.5">
                <button
                  type="button"
                  onClick={() => setEditingRemote(false)}
                  className="rounded px-2 py-0.5 text-[11px] text-[#8B92A5] hover:text-[#E6E8EE]"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded bg-[#6366F1] px-2.5 py-0.5 text-[11px] font-medium text-white hover:bg-[#818CF8]"
                >
                  Save Remote
                </button>
              </div>
            </form>
          ) : (
            <div className="flex items-center justify-between gap-2 text-[11px]">
              <div className="flex min-w-0 items-center gap-1.5 text-[#8B92A5]">
                <Link2 className="h-3 w-3 shrink-0 text-[#818CF8]" />
                <span className="truncate font-mono">
                  {status.remoteUrl ? formatRepoLabel(status.remoteUrl) : 'No GitHub remote'}
                </span>
                {status.remoteUrl && (status.ahead > 0 || status.behind > 0) && (
                  <span className="shrink-0 font-mono text-[10.5px] text-[#818CF8] tabular-nums">
                    {status.behind > 0 ? `↓${status.behind}` : ''}
                    {status.behind > 0 && status.ahead > 0 ? ' ' : ''}
                    {status.ahead > 0 ? `↑${status.ahead}` : ''}
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => {
                  setRemoteInput(status.remoteUrl ?? '');
                  setEditingRemote(true);
                }}
                className="text-[11px] font-medium text-[#818CF8] hover:underline shrink-0"
              >
                {status.remoteUrl ? 'Edit' : 'Connect'}
              </button>
            </div>
          )}
        </div>

        {/* Commit Box */}
        <form onSubmit={handleCommitSubmit} className="border-b border-[#272B38] p-2.5 space-y-2">
          <div className="relative">
            <textarea
              rows={2}
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                  e.preventDefault();
                  void handleCommitSubmit();
                }
              }}
              placeholder="Message (Ctrl+Enter to commit)"
              className="block w-full resize-none rounded-md border border-[#272B38] bg-[#0F1117] px-2.5 py-1.5 pr-8 text-[12px] text-[#E6E8EE] placeholder-[#52596E] focus:border-[#6366F1] focus:outline-none"
            />
            {totalChanges > 0 && (
              <div className="absolute right-1.5 top-1.5 z-10">
                <Tooltip label="Generate Commit Message" side="left">
                  <button
                    type="button"
                    disabled={isGeneratingMsg}
                    onClick={() => void handleGenerateMessage()}
                    aria-label="Generate commit message"
                    className="rounded p-1 text-[#8B92A5] hover:bg-[#1E222E] hover:text-[#818CF8] disabled:opacity-40 transition-colors"
                  >
                    {isGeneratingMsg ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-[#818CF8]" />
                    ) : (
                      <Sparkles className="h-3.5 w-3.5" />
                    )}
                  </button>
                </Tooltip>
              </div>
            )}
          </div>

          {needsIdentity && (
            <div className="grid grid-cols-2 gap-1.5">
              <input
                type="text"
                value={authorName}
                onChange={(e) => setAuthorName(e.target.value)}
                placeholder="git user.name"
                className="rounded border border-[#272B38] bg-[#0F1117] px-2 py-1 text-[11px] text-[#E6E8EE] placeholder-[#52596E] focus:border-[#6366F1] focus:outline-none"
              />
              <input
                type="email"
                value={authorEmail}
                onChange={(e) => setAuthorEmail(e.target.value)}
                placeholder="git user.email"
                className="rounded border border-[#272B38] bg-[#0F1117] px-2 py-1 text-[11px] text-[#E6E8EE] placeholder-[#52596E] focus:border-[#6366F1] focus:outline-none"
              />
            </div>
          )}

          {/* VS Code Primary Action Button: Commit or Sync / Publish */}
          {totalChanges > 0 || commitMessage.trim().length > 0 ? (
            <button
              type="submit"
              disabled={isBusy || !commitMessage.trim() || totalChanges === 0}
              className="flex w-full items-center justify-center gap-1.5 rounded-md bg-[#6366F1] px-3 py-1.5 text-[12px] font-medium text-white hover:bg-[#818CF8] disabled:opacity-40 transition-colors"
            >
              <Check className="h-3.5 w-3.5" />
              <span>
                {status.staged.length > 0
                  ? `Commit (${status.staged.length} staged)`
                  : 'Commit All'}
              </span>
            </button>
          ) : !status.remoteUrl ? (
            <button
              type="button"
              onClick={() => {
                setRemoteInput('');
                setEditingRemote(true);
              }}
              className="flex w-full items-center justify-center gap-1.5 rounded-md bg-[#1E222E] border border-[#272B38] px-3 py-1.5 text-[12px] font-medium text-[#E6E8EE] hover:border-[#6366F1]/60 transition-colors"
            >
              <CloudUpload className="h-3.5 w-3.5 text-[#818CF8]" />
              <span>Publish to GitHub...</span>
            </button>
          ) : status.ahead > 0 || status.behind > 0 || !status.hasUpstream ? (
            <button
              type="button"
              disabled={isBusy}
              onClick={() => void onSync(status.hasUpstream ? 'sync' : 'push')}
              className="flex w-full items-center justify-center gap-1.5 rounded-md bg-[#6366F1] px-3 py-1.5 text-[12px] font-medium text-white hover:bg-[#818CF8] disabled:opacity-50 transition-colors"
            >
              {isBusy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <CloudUpload className="h-3.5 w-3.5" />
              )}
              <span>
                {!status.hasUpstream
                  ? 'Publish Branch'
                  : `Sync Changes${status.ahead ? ` ↑${status.ahead}` : ''}${status.behind ? ` ↓${status.behind}` : ''}`}
              </span>
            </button>
          ) : (
            <div className="flex items-center justify-center gap-1.5 rounded-md border border-[#272B38] bg-[#0F1117] py-1.5 text-[11.5px] text-emerald-400">
              <Check className="h-3.5 w-3.5" />
              <span>Synced with GitHub</span>
            </div>
          )}
        </form>

        {/* Staged Changes */}
        {status.staged.length > 0 && (
          <div className="border-b border-[#272B38]/80">
            <div className="flex h-7 items-center justify-between px-2 hover:bg-[#1E222E]/60">
              <button
                type="button"
                onClick={() => setStagedOpen((p) => !p)}
                className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-[#B5BBC9]"
              >
                {stagedOpen ? (
                  <ChevronDown className="h-3.5 w-3.5 text-[#8B92A5]" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 text-[#8B92A5]" />
                )}
                <span>Staged Changes</span>
                <span className="ml-1 font-mono text-[#818CF8] tabular-nums">
                  {status.staged.length}
                </span>
              </button>
              <Tooltip label="Unstage All Changes">
                <button
                  type="button"
                  onClick={() => void onUnstage([], true)}
                  aria-label="Unstage All"
                  className="rounded p-0.5 text-[#8B92A5] hover:bg-[#272B38] hover:text-[#E6E8EE]"
                >
                  <Minus className="h-3.5 w-3.5" />
                </button>
              </Tooltip>
            </div>
            {stagedOpen && <div>{status.staged.map(renderEntryRow)}</div>}
          </div>
        )}

        {/* Working Tree Changes */}
        <div className="border-b border-[#272B38]/80">
          <div className="flex h-7 items-center justify-between px-2 hover:bg-[#1E222E]/60">
            <button
              type="button"
              onClick={() => setChangesOpen((p) => !p)}
              className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-[#B5BBC9]"
            >
              {changesOpen ? (
                <ChevronDown className="h-3.5 w-3.5 text-[#8B92A5]" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 text-[#8B92A5]" />
              )}
              <span>Changes</span>
              <span className="ml-1 font-mono text-[#8B92A5] tabular-nums">
                {status.changes.length}
              </span>
            </button>
            {status.changes.length > 0 && (
              <Tooltip label="Stage All Changes">
                <button
                  type="button"
                  onClick={() => void onStage([], true)}
                  aria-label="Stage All"
                  className="rounded p-0.5 text-[#8B92A5] hover:bg-[#272B38] hover:text-[#E6E8EE]"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </Tooltip>
            )}
          </div>
          {changesOpen && (
            <div>
              {status.changes.length === 0 ? (
                <div className="px-3 py-2 text-[11.5px] text-[#8B92A5]">
                  Working tree clean.
                </div>
              ) : (
                status.changes.map(renderEntryRow)
              )}
            </div>
          )}
        </div>

        {/* Commit History & Push Status */}
        <div>
          <button
            type="button"
            onClick={() => setCommitsOpen((p) => !p)}
            className="flex h-7 w-full items-center gap-1 px-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[#B5BBC9] hover:bg-[#1E222E]/60"
          >
            {commitsOpen ? (
              <ChevronDown className="h-3.5 w-3.5 text-[#8B92A5]" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-[#8B92A5]" />
            )}
            <span>Commits</span>
            <span className="ml-1 font-mono text-[#8B92A5] tabular-nums">
              {status.commits.length}
            </span>
          </button>

          {commitsOpen && (
            <div className="divide-y divide-[#272B38]/50">
              {status.commits.length === 0 ? (
                <div className="px-3 py-2 text-[11.5px] text-[#8B92A5]">
                  No commits yet.
                </div>
              ) : (
                status.commits.map((c) => (
                  <div
                    key={c.hash}
                    className="flex items-start justify-between gap-2 px-2.5 py-1.5 text-[11.5px]"
                  >
                    <div className="min-w-0">
                      <div className="truncate font-medium text-[#E6E8EE]">
                        {c.message}
                      </div>
                      <div className="flex items-center gap-1.5 font-mono text-[10.5px] text-[#8B92A5]">
                        <span>{c.shortHash}</span>
                        <span>·</span>
                        <span className="truncate">{c.relativeTime}</span>
                      </div>
                    </div>
                    <Tooltip
                      label={
                        c.pushed
                          ? 'Pushed to GitHub remote'
                          : 'Local commit — unpushed'
                      }
                    >
                      <span
                        className={`mt-0.5 shrink-0 font-mono text-[10.5px] font-semibold ${
                          c.pushed ? 'text-emerald-400' : 'text-[#818CF8]'
                        }`}
                      >
                        {c.pushed ? '✓' : '↑'}
                      </span>
                    </Tooltip>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

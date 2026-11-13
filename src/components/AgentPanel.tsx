import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  Brain,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Eye,
  FileCode2,
  FileDiff,
  ListChecks,
  Loader2,
  Play,
  Sparkles,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import {
  AgentActivityItem,
  AgentMessage,
  AgentMode,
  AgentPatch,
  ModelEffort,
} from '../types/ide';
import { Tooltip } from './Tooltip';
import { MarkdownContent } from './MarkdownContent';

interface AgentPanelProps {
  width: number;
  messages: AgentMessage[];
  activeFilePath: string | null;
  workspaceFileCount: number;
  effort: ModelEffort;
  agentMode: AgentMode;
  followAi: boolean;
  isBusy: boolean;
  onEffortChange: (effort: ModelEffort) => void;
  onAgentModeChange: (mode: AgentMode) => void;
  onFollowAiChange: (follow: boolean) => void;
  onSendPrompt: (prompt: string, overrideMode?: AgentMode) => Promise<void>;
  onCancelPrompt: () => void;
  onOpenFile: (filePath: string) => void;
  onInspectPatch: (patch: AgentPatch) => void;
  onAcceptPatch: (patchId: string) => void;
  onRejectPatch: (patchId: string) => void;
  onAcceptAll: (messageId: string) => void;
  onClearHistory: () => void;
}

const STARTER_PROMPTS = [
  'Explain the architecture of this workspace',
  'Add unit tests and clean error handling',
  'Refactor duplicated logic into a helper module',
];

const EFFORT_OPTIONS: Array<{
  value: ModelEffort;
  label: string;
  short: string;
  hint: string;
}> = [
  { value: 'low', label: 'Low', short: 'Low', hint: 'Fastest responses, minimal reasoning' },
  { value: 'medium', label: 'Medium', short: 'Med', hint: 'Balanced speed and reasoning depth' },
  { value: 'high', label: 'High', short: 'High', hint: 'Thorough multi-file analysis' },
  { value: 'xhigh', label: 'Max', short: 'Max', hint: 'Maximum reasoning effort (XHigh)' },
];

function formatDuration(ms?: number): string {
  if (!ms || ms < 100) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

const ThoughtAccordion: React.FC<{
  thoughts: string;
  isStreaming?: boolean;
  durationMs?: number;
}> = ({ thoughts, isStreaming, durationMs }) => {
  const [expanded, setExpanded] = useState(Boolean(isStreaming));

  useEffect(() => {
    if (isStreaming) {
      setExpanded(true);
    }
  }, [isStreaming]);

  const dur = formatDuration(durationMs);

  return (
    <div className="rounded-md border border-[#272B38] bg-[#0B0D12] overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-[11.5px] text-[#B5BBC9] hover:bg-[#161922] transition-colors"
      >
        <span className="flex items-center gap-1.5 min-w-0">
          {isStreaming ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[#818CF8]" />
          ) : (
            <Brain className="h-3.5 w-3.5 shrink-0 text-[#818CF8]" />
          )}
          <span className="font-medium text-[#E6E8EE] truncate">
            {isStreaming
              ? 'Thinking...'
              : dur
                ? `Thought for ${dur}`
                : 'Thinking Process'}
          </span>
        </span>
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[#8B92A5]" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[#8B92A5]" />
        )}
      </button>

      {expanded && (
        <div className="max-h-48 overflow-y-auto border-t border-[#272B38]/80 px-2.5 py-2">
          <MarkdownContent
            content={thoughts}
            className="text-[11.5px] leading-relaxed text-[#9CA3B8]"
          />
        </div>
      )}
    </div>
  );
};

const ActivityFeed: React.FC<{
  items: AgentActivityItem[];
  onOpenFile: (path: string) => void;
}> = ({ items, onOpenFile }) => {
  if (items.length === 0) return null;

  return (
    <div className="space-y-1 rounded-md border border-[#272B38]/80 bg-[#0F1117]/70 px-2.5 py-2">
      {items.map((item) => (
        <div
          key={item.id}
          className="flex items-center justify-between gap-2 text-[11.5px]"
        >
          <div className="flex min-w-0 items-center gap-1.5">
            {item.status === 'running' ? (
              <Loader2 className="h-3 w-3 shrink-0 animate-spin text-[#818CF8]" />
            ) : item.kind === 'edit' ? (
              <FileDiff className="h-3 w-3 shrink-0 text-emerald-400" />
            ) : item.kind === 'read' ? (
              <FileCode2 className="h-3 w-3 shrink-0 text-[#818CF8]" />
            ) : (
              <Check className="h-3 w-3 shrink-0 text-emerald-400" />
            )}

            {item.filePath ? (
              <button
                type="button"
                onClick={() => onOpenFile(item.filePath!)}
                className="truncate font-mono text-left text-[#C7D2FE] hover:text-white hover:underline"
              >
                {item.label}
              </button>
            ) : (
              <span className="truncate text-[#9CA3B8]">{item.label}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
};

export const AgentPanel: React.FC<AgentPanelProps> = ({
  width,
  messages,
  activeFilePath,
  workspaceFileCount,
  effort,
  agentMode,
  followAi,
  isBusy,
  onEffortChange,
  onAgentModeChange,
  onFollowAiChange,
  onSendPrompt,
  onCancelPrompt,
  onOpenFile,
  onInspectPatch,
  onAcceptPatch,
  onRejectPatch,
  onAcceptAll,
  onClearHistory,
}) => {
  const [prompt, setPrompt] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isBusy]);

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const trimmed = prompt.trim();
    if (!trimmed || isBusy) return;
    setPrompt('');
    await onSendPrompt(trimmed);
  };

  return (
    <aside
      style={{ width }}
      className="flex h-full shrink-0 flex-col border-l border-[#272B38] bg-[#161922] min-w-0"
    >
      {/* Header */}
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-[#272B38] px-3 select-none">
        <div className="flex items-center gap-2 min-w-0">
          <Sparkles className="h-3.5 w-3.5 text-[#818CF8] shrink-0" />
          <span className="text-[12.5px] font-semibold text-[#E6E8EE]">Agent</span>
        </div>

        <div className="flex items-center gap-1.5">
          {/* Plan / Action toggle — identical active styling on both */}
          <div className="flex items-center rounded-md bg-[#0F1117] p-0.5">
            <Tooltip label="Read-only architecture & step-by-step plan">
              <button
                type="button"
                onClick={() => onAgentModeChange('plan')}
                className={`flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                  agentMode === 'plan'
                    ? 'bg-[#6366F1]/25 text-[#818CF8]'
                    : 'text-[#8B92A5] hover:text-[#E6E8EE]'
                }`}
              >
                <ListChecks className="h-3 w-3" />
                <span>Plan</span>
              </button>
            </Tooltip>
            <Tooltip label="Generate multi-file code diffs for review">
              <button
                type="button"
                onClick={() => onAgentModeChange('action')}
                className={`flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                  agentMode === 'action'
                    ? 'bg-[#6366F1]/25 text-[#818CF8]'
                    : 'text-[#8B92A5] hover:text-[#E6E8EE]'
                }`}
              >
                <Play className="h-3 w-3" />
                <span>Action</span>
              </button>
            </Tooltip>
          </div>

          <Tooltip label={followAi ? 'Following AI file activity (click to unfollow)' : 'Follow AI file activity in editor'}>
            <button
              type="button"
              onClick={() => onFollowAiChange(!followAi)}
              aria-pressed={followAi}
              className={`flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                followAi
                  ? 'bg-[#6366F1]/20 text-[#818CF8]'
                  : 'text-[#8B92A5] hover:bg-[#1E222E] hover:text-[#E6E8EE]'
              }`}
            >
              <Eye className="h-3 w-3" />
              <span className="hidden sm:inline">Follow</span>
            </button>
          </Tooltip>

          {messages.length > 0 && (
            <Tooltip label="Clear Workspace Conversation">
              <button
                type="button"
                onClick={onClearHistory}
                aria-label="Clear Conversation"
                className="rounded p-1 text-[#8B92A5] hover:bg-[#1E222E] hover:text-[#E6E8EE] transition-colors"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </Tooltip>
          )}
        </div>
      </div>

      {/* Context bar */}
      <div className="flex items-center justify-between gap-2 border-b border-[#272B38] bg-[#0F1117]/60 px-3 py-1.5 text-[11.5px] text-[#8B92A5]">
        <div className="flex min-w-0 items-center gap-2">
          <span className="tabular-nums shrink-0">{workspaceFileCount} files</span>
          {activeFilePath && (
            <>
              <span aria-hidden="true">·</span>
              <span className="truncate font-mono text-[#B5BBC9]">{activeFilePath}</span>
            </>
          )}
        </div>
        {isBusy && (
          <span className="flex items-center gap-1 text-[11px] font-medium text-[#818CF8] shrink-0">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span>Running</span>
          </span>
        )}
      </div>

      {/* Conversation Stream */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
        {messages.length === 0 ? (
          <div className="space-y-4 pt-4">
            <div>
              <h2 className="text-[13px] font-semibold text-[#E6E8EE]">
                Antigravity-Style Coding Agent
              </h2>
              <p className="mt-1 text-[12px] leading-relaxed text-[#8B92A5]">
                Watch live reasoning, follow files as Aetheris inspects or edits them, adjust model
                effort below, and review diffs before applying to disk.
              </p>
            </div>

            <div className="space-y-1.5">
              {STARTER_PROMPTS.map((sample) => (
                <button
                  key={sample}
                  type="button"
                  onClick={() => onSendPrompt(sample)}
                  className="block w-full rounded-md border border-[#272B38] bg-[#0F1117] px-3 py-2 text-left text-[12px] text-[#B5BBC9] hover:border-[#6366F1]/60 hover:text-[#E6E8EE] transition-colors"
                >
                  {sample}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((msg) => {
            const pendingPatches =
              msg.patches?.filter((p) => p.status === 'pending') ?? [];

            return (
              <div key={msg.id} className="space-y-2">
                <div className="flex items-center justify-between text-[11px] text-[#8B92A5]">
                  <div className="flex items-center gap-1.5">
                    <span className="font-semibold text-[#E6E8EE]">
                      {msg.role === 'user' ? 'You' : 'Aetheris'}
                    </span>
                    {msg.mode && (
                      <span className="rounded bg-[#0F1117] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[#818CF8]">
                        {msg.mode}
                      </span>
                    )}
                    {msg.effort && msg.role === 'user' && (
                      <span className="text-[10.5px] text-[#8B92A5]">
                        · {msg.effort === 'xhigh' ? 'max' : msg.effort}
                      </span>
                    )}
                  </div>
                  <span className="tabular-nums">{msg.timestamp}</span>
                </div>

                {/* Live Activity Feed (Zed-style) */}
                {msg.role === 'assistant' && msg.activity && msg.activity.length > 0 && (
                  <ActivityFeed items={msg.activity} onOpenFile={onOpenFile} />
                )}

                {/* Collapsible Thinking Trace (Antigravity-style) */}
                {msg.role === 'assistant' && msg.thoughts && msg.thoughts.trim().length > 0 && (
                  <ThoughtAccordion
                    thoughts={msg.thoughts}
                    isStreaming={msg.isStreaming && !msg.content}
                    durationMs={msg.thinkingDurationMs}
                  />
                )}

                {msg.error ? (
                  <div className="rounded-md border border-red-500/40 bg-red-500/10 p-2.5 text-[12px] text-red-200">
                    {msg.error}
                  </div>
                ) : msg.cancelled ? (
                  <div className="rounded-md border border-amber-500/35 bg-amber-500/10 px-2.5 py-2 text-[12px] text-amber-200">
                    {msg.content || 'Prompt cancelled by user.'}
                  </div>
                ) : msg.content ? (
                  msg.role === 'user' ? (
                    <div className="rounded-md bg-[#1E222E] px-3 py-2 text-[12.5px] leading-relaxed text-[#E6E8EE] whitespace-pre-wrap">
                      {msg.content}
                    </div>
                  ) : (
                    <div className="px-0.5 py-0.5">
                      <MarkdownContent content={msg.content} onOpenFile={onOpenFile} />
                    </div>
                  )
                ) : msg.isStreaming ? (
                  <div className="flex items-center gap-2 rounded-md border border-[#272B38] bg-[#0F1117] px-3 py-2 text-[12px] text-[#8B92A5]">
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-[#818CF8]" />
                    <span>
                      {msg.thoughts
                        ? 'Drafting structured response...'
                        : 'Inspecting workspace and thinking...'}
                    </span>
                  </div>
                ) : null}

                {msg.role === 'assistant' &&
                  msg.mode === 'plan' &&
                  !msg.error &&
                  !msg.cancelled &&
                  !msg.isStreaming &&
                  (!msg.patches || msg.patches.length === 0) && (
                    <div className="pt-1">
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => {
                          onAgentModeChange('action');
                          const stepsText = (msg.steps ?? [])
                            .map((s, idx) => `${idx + 1}. ${s}`)
                            .join('\n');
                          const planPrompt = stepsText
                            ? `Implement the following approved plan across the workspace:\n\n${msg.content}\n\nSteps:\n${stepsText}`
                            : `Implement the following approved plan across the workspace:\n\n${msg.content}`;
                          void onSendPrompt(planPrompt, 'action');
                        }}
                        className="flex items-center gap-1.5 rounded-md bg-[#6366F1] px-2.5 py-1.5 text-[11.5px] font-medium text-white hover:bg-[#818CF8] disabled:opacity-40 transition-colors"
                      >
                        <Play className="h-3 w-3" />
                        <span>Execute Plan in Action Mode</span>
                      </button>
                    </div>
                  )}

                {msg.patches && msg.patches.length > 0 && (
                  <div className="space-y-1.5 pt-1">
                    <div className="flex items-center justify-between">
                      <span className="text-[11.5px] font-medium text-[#8B92A5] tabular-nums">
                        Proposed Changes ({msg.patches.length})
                      </span>
                      {pendingPatches.length > 1 && (
                        <button
                          type="button"
                          onClick={() => onAcceptAll(msg.id)}
                          className="flex items-center gap-1 text-[11.5px] font-medium text-emerald-400 hover:text-emerald-300 transition-colors"
                        >
                          <CheckCheck className="h-3.5 w-3.5" />
                          <span>Accept All</span>
                        </button>
                      )}
                    </div>

                    {msg.patches.map((patch) => (
                      <div
                        key={patch.id}
                        className="rounded-md border border-[#272B38] bg-[#0F1117] p-2 transition-colors hover:border-[#3A4054]"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <button
                            type="button"
                            onClick={() => onInspectPatch(patch)}
                            className="flex min-w-0 items-center gap-1.5 text-left hover:text-[#818CF8]"
                          >
                            <FileDiff className="h-3.5 w-3.5 shrink-0 text-[#818CF8]" />
                            <span className="truncate font-mono text-[11.5px] text-[#E6E8EE]">
                              {patch.path}
                            </span>
                          </button>

                          <span
                            className={`text-[10.5px] font-semibold uppercase shrink-0 ${
                              patch.status === 'accepted'
                                ? 'text-emerald-400'
                                : patch.status === 'rejected'
                                  ? 'text-[#8B92A5]'
                                  : patch.action === 'create'
                                    ? 'text-emerald-400'
                                    : patch.action === 'delete'
                                      ? 'text-red-400'
                                      : 'text-[#818CF8]'
                            }`}
                          >
                            {patch.status === 'pending' ? patch.action : patch.status}
                          </span>
                        </div>

                        {patch.rationale && (
                          <p className="mt-1 text-[11px] text-[#8B92A5] line-clamp-2">
                            {patch.rationale}
                          </p>
                        )}

                        {patch.status === 'pending' && (
                          <div className="mt-2 flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => onInspectPatch(patch)}
                              className="rounded border border-[#272B38] bg-[#161922] px-2 py-0.5 text-[11px] text-[#E6E8EE] hover:bg-[#1E222E] transition-colors"
                            >
                              Diff
                            </button>
                            <button
                              type="button"
                              onClick={() => onAcceptPatch(patch.id)}
                              className="flex items-center gap-1 rounded bg-emerald-600/20 px-2 py-0.5 text-[11px] font-medium text-emerald-300 hover:bg-emerald-600/30 transition-colors"
                            >
                              <Check className="h-3 w-3" />
                              <span>Accept</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => onRejectPatch(patch.id)}
                              className="flex items-center gap-1 rounded bg-[#1E222E] px-2 py-0.5 text-[11px] text-[#8B92A5] hover:text-red-300 transition-colors"
                            >
                              <X className="h-3 w-3" />
                              <span>Reject</span>
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Antigravity-style Composer */}
      <form onSubmit={handleSubmit} className="border-t border-[#272B38] p-2.5">
        <div className="rounded-lg border border-[#272B38] bg-[#0F1117] p-2 focus-within:border-[#6366F1] transition-colors">
          <textarea
            rows={3}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void handleSubmit();
              } else if (e.key === 'Escape' && isBusy) {
                e.preventDefault();
                onCancelPrompt();
              }
            }}
            placeholder={
              agentMode === 'plan'
                ? 'Plan mode (read-only): describe a feature or refactor...'
                : 'Action mode: ask Aetheris to inspect, build, or edit files...'
            }
            className="w-full resize-none bg-transparent text-[12.5px] text-[#E6E8EE] placeholder-[#52596E] focus:outline-none"
          />

          <div className="mt-2 flex items-center justify-between gap-2">
            {/* Effort Selector */}
            <div className="flex items-center gap-1 rounded-md bg-[#161922] p-0.5">
              <span className="px-1.5 text-[10.5px] font-medium text-[#8B92A5] select-none">
                Effort
              </span>
              {EFFORT_OPTIONS.map((opt) => (
                <Tooltip key={opt.value} label={`${opt.label} effort: ${opt.hint}`}>
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => onEffortChange(opt.value)}
                    className={`rounded px-1.5 py-0.5 text-[10.5px] font-medium transition-colors whitespace-nowrap ${
                      effort === opt.value
                        ? 'bg-[#6366F1]/25 text-[#818CF8]'
                        : 'text-[#8B92A5] hover:text-[#E6E8EE]'
                    } disabled:opacity-60`}
                  >
                    {opt.short}
                  </button>
                </Tooltip>
              ))}
            </div>

            {/* Submit OR Cancel Prompt Button */}
            {isBusy ? (
              <Tooltip label="Cancel active prompt" shortcut="Esc">
                <button
                  type="button"
                  onClick={onCancelPrompt}
                  className="flex items-center gap-1.5 rounded-md border border-red-500/40 bg-red-500/15 px-2.5 py-1 text-[11.5px] font-medium text-red-300 hover:bg-red-500/25 transition-colors whitespace-nowrap shrink-0"
                >
                  <Square className="h-3 w-3 fill-current" />
                  <span>Cancel</span>
                </button>
              </Tooltip>
            ) : (
              <button
                type="submit"
                disabled={!prompt.trim()}
                className="flex items-center gap-1 rounded-md bg-[#6366F1] px-2.5 py-1 text-[11.5px] font-medium text-white hover:bg-[#818CF8] disabled:opacity-40 transition-colors whitespace-nowrap shrink-0"
              >
                <span>{agentMode === 'plan' ? 'Plan' : 'Run'}</span>
                <ArrowUp className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      </form>
    </aside>
  );
};

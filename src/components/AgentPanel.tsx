import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  Check,
  CheckCheck,
  FileDiff,
  ListChecks,
  Loader2,
  Play,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { AgentMessage, AgentMode, AgentPatch, ThinkingMode } from '../types/ide';
import { Tooltip } from './Tooltip';

interface AgentPanelProps {
  messages: AgentMessage[];
  activeFilePath: string | null;
  workspaceFileCount: number;
  thinkingMode: ThinkingMode;
  agentMode: AgentMode;
  isBusy: boolean;
  onThinkingModeChange: (mode: ThinkingMode) => void;
  onAgentModeChange: (mode: AgentMode) => void;
  onSendPrompt: (prompt: string, overrideMode?: AgentMode) => Promise<void>;
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

export const AgentPanel: React.FC<AgentPanelProps> = ({
  messages,
  activeFilePath,
  workspaceFileCount,
  thinkingMode,
  agentMode,
  isBusy,
  onThinkingModeChange,
  onAgentModeChange,
  onSendPrompt,
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
    <aside className="flex h-full w-80 lg:w-96 shrink-0 flex-col border-l border-[#272B38] bg-[#161922]">
      {/* Header */}
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-[#272B38] px-3 select-none">
        <div className="flex items-center gap-2">
          <Sparkles className="h-3.5 w-3.5 text-[#818CF8]" />
          <span className="text-[12.5px] font-semibold text-[#E6E8EE]">Agent</span>
        </div>

        <div className="flex items-center gap-1.5">
          <div className="flex items-center rounded-md bg-[#0F1117] p-0.5">
            <Tooltip label="Read-only architecture & step-by-step plan">
              <button
                type="button"
                onClick={() => onAgentModeChange('plan')}
                className={`flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                  agentMode === 'plan'
                    ? 'bg-[#1E222E] text-[#E6E8EE]'
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

          <div className="flex items-center rounded-md bg-[#0F1117] p-0.5">
            <button
              type="button"
              onClick={() => onThinkingModeChange('fast')}
              className={`rounded px-1.5 py-0.5 text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                thinkingMode === 'fast'
                  ? 'bg-[#1E222E] text-[#E6E8EE]'
                  : 'text-[#8B92A5] hover:text-[#E6E8EE]'
              }`}
            >
              Fast
            </button>
            <button
              type="button"
              onClick={() => onThinkingModeChange('deep')}
              className={`rounded px-1.5 py-0.5 text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                thinkingMode === 'deep'
                  ? 'bg-[#6366F1]/25 text-[#818CF8]'
                  : 'text-[#8B92A5] hover:text-[#E6E8EE]'
              }`}
            >
              Deep
            </button>
          </div>

          {messages.length > 0 && (
            <Tooltip label="Clear Conversation">
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
      <div className="flex items-center gap-2 border-b border-[#272B38] bg-[#0F1117]/60 px-3 py-1.5 text-[11.5px] text-[#8B92A5]">
        <span className="tabular-nums">{workspaceFileCount} files indexed</span>
        {activeFilePath && (
          <>
            <span aria-hidden="true">·</span>
            <span className="truncate font-mono text-[#B5BBC9]">{activeFilePath}</span>
          </>
        )}
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
        {messages.length === 0 ? (
          <div className="space-y-4 pt-4">
            <div>
              <h2 className="text-[13px] font-semibold text-[#E6E8EE]">
                Autonomous Multi-File Agent
              </h2>
              <p className="mt-1 text-[12px] leading-relaxed text-[#8B92A5]">
                Describe a feature, refactor, or bug fix. Aetheris inspects workspace files and
                proposes reviewable diffs before touching disk.
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
                  <span className="font-semibold text-[#E6E8EE]">
                    {msg.role === 'user' ? 'You' : 'Aetheris'}
                  </span>
                  <span className="tabular-nums">{msg.timestamp}</span>
                </div>

                {msg.error ? (
                  <div className="rounded-md border border-red-500/40 bg-red-500/10 p-2.5 text-[12px] text-red-200">
                    {msg.error}
                  </div>
                ) : (
                  <div
                    className={`rounded-md p-2.5 text-[12.5px] leading-relaxed whitespace-pre-wrap ${
                      msg.role === 'user'
                        ? 'bg-[#1E222E] text-[#E6E8EE]'
                        : 'border border-[#272B38] bg-[#0F1117] text-[#D1D5E0]'
                    }`}
                  >
                    {msg.content}
                  </div>
                )}

                {msg.steps && msg.steps.length > 0 && (
                  <ul className="space-y-1 pl-1 text-[11.5px] text-[#8B92A5]">
                    {msg.steps.map((step, i) => (
                      <li key={i} className="flex items-start gap-1.5">
                        <span className="font-mono text-[#6366F1] tabular-nums">
                          {i + 1}.
                        </span>
                        <span>{step}</span>
                      </li>
                    ))}
                  </ul>
                )}

                {msg.role === 'assistant' &&
                  msg.mode === 'plan' &&
                  !msg.error &&
                  (!msg.patches || msg.patches.length === 0) && (
                    <div className="pt-1">
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => {
                          onAgentModeChange('action');
                          const stepsText = (msg.steps ?? []).map((s, idx) => `${idx + 1}. ${s}`).join('\n');
                          void onSendPrompt(
                            `Implement the following approved plan across the workspace:\n\n${msg.content}\n\nSteps:\n${stepsText}`,
                            'action'
                          );
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

        {isBusy && (
          <div className="flex items-center gap-2 rounded-md border border-[#272B38] bg-[#0F1117] px-3 py-2.5 text-[12px] text-[#8B92A5]">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-[#818CF8]" />
            <span>Inspecting workspace files and planning edits...</span>
          </div>
        )}
      </div>

      {/* Prompt Composer */}
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
              }
            }}
            placeholder={
              agentMode === 'plan'
                ? 'Plan mode (read-only): describe a feature or refactor to design a step-by-step plan...'
                : 'Action mode: ask Aetheris to edit files, add features, or fix bugs...'
            }
            className="w-full resize-none bg-transparent text-[12.5px] text-[#E6E8EE] placeholder-[#52596E] focus:outline-none"
          />
          <div className="mt-1.5 flex items-center justify-between">
            <span className="text-[11px] text-[#8B92A5]">
              {agentMode === 'plan' ? 'Plan (read-only)' : 'Action (edits)'} · Enter to run
            </span>
            <button
              type="submit"
              disabled={isBusy || !prompt.trim()}
              className="flex items-center gap-1 rounded-md bg-[#6366F1] px-2.5 py-1 text-[11.5px] font-medium text-white hover:bg-[#818CF8] disabled:opacity-40 transition-colors whitespace-nowrap shrink-0"
            >
              <span>{agentMode === 'plan' ? 'Plan' : 'Run'}</span>
              <ArrowUp className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </form>
    </aside>
  );
};

import React, { useEffect, useRef, useState } from 'react';
import { CornerDownLeft, Terminal as TerminalIcon, Trash2, X } from 'lucide-react';
import { TerminalEntry } from '../types/ide';
import { Tooltip } from './Tooltip';

interface TerminalDrawerProps {
  workspaceName: string;
  entries: TerminalEntry[];
  isRunning: boolean;
  onExecute: (command: string) => Promise<void>;
  onClear: () => void;
  onClose: () => void;
}

export const TerminalDrawer: React.FC<TerminalDrawerProps> = ({
  workspaceName,
  entries,
  isRunning,
  onExecute,
  onClear,
  onClose,
}) => {
  const [input, setInput] = useState('');
  const [historyIdx, setHistoryIdx] = useState<number>(-1);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries, isRunning]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cmd = input.trim();
    if (!cmd || isRunning) return;
    if (cmd === 'clear') {
      onClear();
      setInput('');
      setHistoryIdx(-1);
      return;
    }
    setInput('');
    setHistoryIdx(-1);
    await onExecute(cmd);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (entries.length === 0) return;
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const nextIdx = historyIdx === -1 ? entries.length - 1 : Math.max(0, historyIdx - 1);
      setHistoryIdx(nextIdx);
      setInput(entries[nextIdx]?.command ?? '');
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIdx === -1) return;
      if (historyIdx >= entries.length - 1) {
        setHistoryIdx(-1);
        setInput('');
      } else {
        const nextIdx = historyIdx + 1;
        setHistoryIdx(nextIdx);
        setInput(entries[nextIdx]?.command ?? '');
      }
    }
  };

  return (
    <section className="flex h-56 shrink-0 flex-col border-t border-[#272B38] bg-[#161922]">
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-[#272B38] px-3 select-none">
        <div className="flex items-center gap-2 text-[12px] font-medium text-[#E6E8EE]">
          <TerminalIcon className="h-3.5 w-3.5 text-[#818CF8]" />
          <span>Terminal</span>
          <span className="text-[#52596E]" aria-hidden="true">
            ·
          </span>
          <span className="font-mono text-[11px] text-[#8B92A5]">{workspaceName}</span>
        </div>

        <div className="flex items-center gap-1">
          <Tooltip label="Clear Terminal">
            <button
              type="button"
              onClick={onClear}
              aria-label="Clear Terminal"
              className="rounded p-1 text-[#8B92A5] hover:bg-[#1E222E] hover:text-[#E6E8EE] transition-colors"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          <Tooltip label="Close Terminal" shortcut="Ctrl+`">
            <button
              type="button"
              onClick={onClose}
              aria-label="Close Terminal"
              className="rounded p-1 text-[#8B92A5] hover:bg-[#1E222E] hover:text-[#E6E8EE] transition-colors"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
        </div>
      </div>

      <div
        ref={scrollRef}
        onClick={() => inputRef.current?.focus()}
        className="flex-1 overflow-y-auto bg-[#0F1117] px-3 py-2 font-mono text-[12px] leading-relaxed"
      >
        {entries.length === 0 ? (
          <div className="text-[#8B92A5]">
            Run shell commands inside <span className="text-[#E6E8EE]">{workspaceName}</span>{' '}
            (for example: <code className="text-[#818CF8]">ls -la</code>,{' '}
            <code className="text-[#818CF8]">grep -rn "fn " src</code>, or{' '}
            <code className="text-[#818CF8]">node --version</code>).
          </div>
        ) : (
          <div className="space-y-3">
            {entries.map((entry) => (
              <div key={entry.id} className="space-y-1">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-[#E6E8EE]">
                    <span className="text-[#818CF8]">$</span>
                    <span>{entry.command}</span>
                  </div>
                  <span
                    className={`tabular-nums text-[11px] ${
                      entry.exitCode === 0 ? 'text-emerald-400' : 'text-red-400'
                    }`}
                  >
                    exit {entry.exitCode}
                  </span>
                </div>
                {entry.stdout && (
                  <pre className="whitespace-pre-wrap break-words text-[#B5BBC9]">
                    {entry.stdout}
                  </pre>
                )}
                {entry.stderr && (
                  <pre className="whitespace-pre-wrap break-words text-red-400">
                    {entry.stderr}
                  </pre>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <form
        onSubmit={handleSubmit}
        className="flex h-9 shrink-0 items-center gap-2 border-t border-[#272B38] bg-[#0F1117] px-3"
      >
        <span className="font-mono text-[12px] text-[#818CF8]">$</span>
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isRunning}
          placeholder={isRunning ? 'Running command...' : 'Enter command...'}
          className="flex-1 bg-transparent font-mono text-[12px] text-[#E6E8EE] placeholder-[#52596E] focus:outline-none"
        />
        <button
          type="submit"
          disabled={isRunning || !input.trim()}
          className="flex items-center gap-1 rounded bg-[#1E222E] px-2 py-1 text-[11px] font-medium text-[#E6E8EE] hover:bg-[#272B38] disabled:opacity-40 transition-colors whitespace-nowrap shrink-0"
        >
          <span>Run</span>
          <CornerDownLeft className="h-3 w-3" />
        </button>
      </form>
    </section>
  );
};

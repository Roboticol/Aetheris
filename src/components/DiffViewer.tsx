import React, { useMemo } from 'react';
import { diffLines } from 'diff';
import { Check, X } from 'lucide-react';
import { AgentPatch } from '../types/ide';

interface DiffViewerProps {
  patch: AgentPatch;
  onAccept: (patchId: string) => void;
  onReject: (patchId: string) => void;
  onClose: () => void;
}

export const DiffViewer: React.FC<DiffViewerProps> = ({
  patch,
  onAccept,
  onReject,
  onClose,
}) => {
  const hunks = useMemo(() => {
    const original = patch.action === 'create' ? '' : patch.originalContent;
    const next = patch.action === 'delete' ? '' : patch.content;
    return diffLines(original, next);
  }, [patch]);

  let oldLine = 1;
  let newLine = 1;

  return (
    <div className="flex h-full flex-col bg-[#0F1117]">
      <div className="flex items-center justify-between gap-4 border-b border-[#272B38] bg-[#161922] px-4 py-2.5">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[12.5px]">
            <span className="font-mono font-semibold text-[#E6E8EE] truncate">
              {patch.path}
            </span>
            <span className="text-[#8B92A5]" aria-hidden="true">
              ·
            </span>
            <span
              className={`text-[11.5px] font-medium uppercase ${
                patch.action === 'create'
                  ? 'text-emerald-400'
                  : patch.action === 'delete'
                    ? 'text-red-400'
                    : 'text-[#818CF8]'
              }`}
            >
              {patch.action}
            </span>
          </div>
          {patch.rationale && (
            <p className="mt-0.5 text-[12px] text-[#8B92A5] truncate">{patch.rationale}</p>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {patch.status === 'pending' ? (
            <>
              <button
                type="button"
                onClick={() => onReject(patch.id)}
                className="flex items-center gap-1.5 rounded-md border border-[#272B38] bg-[#1E222E] px-3 py-1.5 text-[12px] font-medium text-[#E6E8EE] hover:border-red-500/50 hover:text-red-300 transition-colors whitespace-nowrap shrink-0"
              >
                <X className="h-3.5 w-3.5" />
                <span>Reject</span>
              </button>
              <button
                type="button"
                onClick={() => onAccept(patch.id)}
                className="flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-emerald-500 transition-colors whitespace-nowrap shrink-0"
              >
                <Check className="h-3.5 w-3.5" />
                <span>Accept Change</span>
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-[#272B38] bg-[#1E222E] px-3 py-1.5 text-[12px] font-medium text-[#E6E8EE] hover:bg-[#272B38] transition-colors whitespace-nowrap shrink-0"
            >
              Return to Editor
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-auto font-mono text-[12.5px] leading-5">
        {hunks.map((part, idx) => {
          const lines = part.value.replace(/\n$/, '').split('\n');
          if (lines.length === 1 && lines[0] === '' && part.value === '') return null;

          return lines.map((line, lineIdx) => {
            const isAdd = Boolean(part.added);
            const isRem = Boolean(part.removed);

            const leftNum = isAdd ? '' : String(oldLine++);
            const rightNum = isRem ? '' : String(newLine++);

            return (
              <div
                key={`${idx}-${lineIdx}`}
                className={`flex items-start px-2 ${
                  isAdd
                    ? 'bg-emerald-500/12 text-emerald-200'
                    : isRem
                      ? 'bg-red-500/12 text-red-200'
                      : 'text-[#B5BBC9]'
                }`}
              >
                <span className="w-10 shrink-0 select-none pr-2 text-right tabular-nums text-[#52596E]">
                  {leftNum}
                </span>
                <span className="w-10 shrink-0 select-none pr-2 text-right tabular-nums text-[#52596E]">
                  {rightNum}
                </span>
                <span className="w-5 shrink-0 select-none text-center font-semibold">
                  {isAdd ? '+' : isRem ? '-' : ' '}
                </span>
                <pre className="whitespace-pre-wrap break-all">{line}</pre>
              </div>
            );
          });
        })}
      </div>
    </div>
  );
};

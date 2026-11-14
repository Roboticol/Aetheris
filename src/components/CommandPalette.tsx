import React, { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { FileCode2, Search, X } from 'lucide-react';
import { SearchHit } from '../types/ide';

interface CommandPaletteProps {
  open: boolean;
  filePaths: string[];
  symbols: SearchHit[];
  onClose: () => void;
  onSelectFile: (path: string, line?: number) => void;
}

interface PaletteItem {
  id: string;
  label: string;
  sublabel: string;
  path: string;
  line?: number;
  kind?: string | null;
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  open,
  filePaths,
  symbols,
  onClose,
  onSelectFile,
}) => {
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedIndex(0);
    }
  }, [open]);

  const items = useMemo<PaletteItem[]>(() => {
    const q = deferredQuery.trim().toLowerCase();

    const fileItems: PaletteItem[] = filePaths
      .filter((p) => !q || p.toLowerCase().includes(q))
      .slice(0, 12)
      .map((p) => ({
        id: `file:${p}`,
        label: p.split('/').pop() ?? p,
        sublabel: p,
        path: p,
      }));

    const symItems: PaletteItem[] = symbols
      .filter(
        (s) =>
          s.symbolName &&
          (!q ||
            s.symbolName.toLowerCase().includes(q) ||
            s.filePath.toLowerCase().includes(q))
      )
      .slice(0, 12)
      .map((s, idx) => ({
        id: `sym:${s.filePath}:${s.line}:${idx}`,
        label: s.symbolName ?? '',
        sublabel: `${s.filePath}:${s.line}`,
        path: s.filePath,
        line: s.line,
        kind: s.symbolKind,
      }));

    return [...fileItems, ...symItems];
  }, [filePaths, symbols, query]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (items.length ? (prev + 1) % items.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => (items.length ? (prev - 1 + items.length) % items.length : 0));
    } else if (e.key === 'Enter' && items[selectedIndex]) {
      e.preventDefault();
      const chosen = items[selectedIndex];
      onSelectFile(chosen.path, chosen.line);
      onClose();
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-20 px-4">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/60 backdrop-blur-[1px]"
          />

          <motion.div
            initial={{ opacity: 0, y: -8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
            className="relative z-10 w-full max-w-xl overflow-hidden rounded-lg border border-[#272B38] bg-[#161922] shadow-2xl"
          >
            <div className="flex items-center gap-2.5 border-b border-[#272B38] px-3.5 py-2.5">
              <Search className="h-4 w-4 text-[#8B92A5] shrink-0" />
              <input
                autoFocus
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Type a file name or symbol (fn, struct, class)..."
                className="flex-1 bg-transparent text-[13px] text-[#E6E8EE] placeholder-[#52596E] focus:outline-none"
              />
              <button
                type="button"
                onClick={onClose}
                aria-label="Close Search"
                className="rounded p-1 text-[#8B92A5] hover:bg-[#1E222E] hover:text-[#E6E8EE]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="max-h-80 overflow-y-auto py-1">
              {items.length === 0 ? (
                <div className="px-4 py-8 text-center text-[12px] text-[#8B92A5]">
                  No matching files or symbols.
                </div>
              ) : (
                items.map((item, idx) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      onSelectFile(item.path, item.line);
                      onClose();
                    }}
                    className={`flex w-full items-center justify-between gap-3 px-3.5 py-2 text-left text-[12.5px] transition-colors ${
                      idx === selectedIndex
                        ? 'bg-[#6366F1]/20 text-[#E6E8EE]'
                        : 'text-[#B5BBC9] hover:bg-[#1E222E]'
                    }`}
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <FileCode2 className="h-3.5 w-3.5 shrink-0 text-[#818CF8]" />
                      <span className="truncate font-mono font-medium text-[#E6E8EE]">
                        {item.kind ? (
                          <>
                            <span className="text-[#818CF8]">{item.kind}</span> {item.label}
                          </>
                        ) : (
                          item.label
                        )}
                      </span>
                    </div>
                    <span className="truncate font-mono text-[11px] text-[#8B92A5]">
                      {item.sublabel}
                    </span>
                  </button>
                ))
              )}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};

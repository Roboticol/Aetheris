import React, { useState } from 'react';
import {
  ChevronDown,
  FolderOpen,
  PanelBottom,
  PanelLeft,
  PanelRight,
  RotateCcw,
  Search,
} from 'lucide-react';
import { WorkspaceSource, WorkspaceSummary } from '../types/ide';
import { DigitalClock } from './DigitalClock';
import { Tooltip } from './Tooltip';

interface TopBarProps {
  workspaceName: string;
  workspaceSource: WorkspaceSource;
  activeWorkspaceId: string;
  starters: WorkspaceSummary[];
  showLeftSidebar: boolean;
  showRightAgent: boolean;
  showTerminal: boolean;
  onToggleLeftSidebar: () => void;
  onToggleRightAgent: () => void;
  onToggleTerminal: () => void;
  onOpenCommandPalette: () => void;
  onOpenLocalFolder: () => void;
  onSelectStarter: (id: string) => void;
  onResetStarter: () => void;
  onGoHome: () => void;
}

export const TopBar: React.FC<TopBarProps> = ({
  workspaceName,
  workspaceSource,
  activeWorkspaceId,
  starters,
  showLeftSidebar,
  showRightAgent,
  showTerminal,
  onToggleLeftSidebar,
  onToggleRightAgent,
  onToggleTerminal,
  onOpenCommandPalette,
  onOpenLocalFolder,
  onSelectStarter,
  onResetStarter,
  onGoHome,
}) => {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header className="relative z-30 flex h-10 shrink-0 items-center justify-between gap-6 border-b border-[#272B38] bg-[#161922] px-3 select-none">
      {/* Zone 1: Brand / Home + Workspace Switcher */}
      <div className="flex items-center gap-2.5 min-w-0">
        <Tooltip label="Home Screen">
          <button
            type="button"
            onClick={onGoHome}
            className="flex items-center gap-2 rounded-md px-1.5 py-1 text-[#E6E8EE] hover:bg-[#1E222E] transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#6366F1]"
          >
            <img
              src="/icon.png"
              alt=""
              className="block h-[20px] w-[20px] shrink-0 rounded-[4px] object-cover"
            />
            <span className="text-[15px] font-bold leading-[20px] tracking-tight">
              Aetheris
            </span>
          </button>
        </Tooltip>

        <span className="text-[#272B38]" aria-hidden="true">
          /
        </span>

        <div className="relative">
          <button
            type="button"
            onClick={() => setMenuOpen((prev) => !prev)}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium text-[#E6E8EE] hover:bg-[#1E222E] transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#6366F1]"
          >
            <span className="max-w-[180px] truncate">{workspaceName}</span>
            <ChevronDown className="h-3.5 w-3.5 text-[#8B92A5]" />
          </button>

          {menuOpen && (
            <>
              <div
                className="fixed inset-0 z-40"
                onClick={() => setMenuOpen(false)}
              />
              <div className="absolute left-0 top-full z-50 mt-1 w-72 rounded-lg border border-[#272B38] bg-[#161922] p-1.5 shadow-xl">
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    onOpenLocalFolder();
                  }}
                  className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[12px] font-medium text-[#E6E8EE] hover:bg-[#1E222E] transition-colors"
                >
                  <FolderOpen className="h-4 w-4 text-[#818CF8] shrink-0" />
                  <div className="min-w-0">
                    <div className="truncate">Open Local Folder...</div>
                    <div className="text-[11px] text-[#8B92A5] truncate">
                      Edit real files directly on disk
                    </div>
                  </div>
                </button>

                <div className="my-1.5 h-px bg-[#272B38]" />

                <div className="px-2.5 py-1 text-[11px] font-medium text-[#8B92A5]">
                  Starter Workspaces
                </div>

                {starters.map((ws) => {
                  const active = workspaceSource === 'starter' && ws.id === activeWorkspaceId;
                  return (
                    <button
                      key={ws.id}
                      type="button"
                      onClick={() => {
                        setMenuOpen(false);
                        onSelectStarter(ws.id);
                      }}
                      className={`flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-[12px] transition-colors ${
                        active
                          ? 'bg-[#6366F1]/15 text-[#E6E8EE]'
                          : 'text-[#8B92A5] hover:bg-[#1E222E] hover:text-[#E6E8EE]'
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="font-medium text-[#E6E8EE] truncate">{ws.name}</div>
                        <div className="text-[11px] text-[#8B92A5] truncate">{ws.description}</div>
                      </div>
                      <span className="font-mono text-[11px] text-[#8B92A5] shrink-0">
                        {ws.language}
                      </span>
                    </button>
                  );
                })}

                {workspaceSource === 'starter' && (
                  <>
                    <div className="my-1.5 h-px bg-[#272B38]" />
                    <button
                      type="button"
                      onClick={() => {
                        setMenuOpen(false);
                        onResetStarter();
                      }}
                      className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12px] text-[#8B92A5] hover:bg-[#1E222E] hover:text-[#E6E8EE] transition-colors"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      <span>Reset starter files</span>
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Zone 2: Quick Command Search */}
      <button
        type="button"
        onClick={onOpenCommandPalette}
        className="hidden sm:flex w-full max-w-md items-center justify-between gap-3 rounded-md border border-[#272B38] bg-[#0F1117] px-3 py-1 text-[12px] text-[#8B92A5] hover:border-[#3A4054] hover:text-[#E6E8EE] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#6366F1]"
      >
        <span className="flex items-center gap-2 truncate">
          <Search className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">Jump to file or symbol in {workspaceName}</span>
        </span>
        <kbd className="font-mono text-[11px] text-[#8B92A5] shrink-0">Ctrl+P</kbd>
      </button>

      {/* Zone 3: Digital Clock & Layout Toggles */}
      <div className="flex items-center gap-1.5 shrink-0">
        <DigitalClock variant="topbar" />

        <div className="mx-1 h-4 w-px bg-[#272B38]" />

        <Tooltip label="Toggle Explorer" shortcut="Ctrl+B">
          <button
            type="button"
            onClick={onToggleLeftSidebar}
            aria-label="Toggle Explorer"
            className={`rounded-md p-1.5 transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#6366F1] ${
              showLeftSidebar
                ? 'bg-[#1E222E] text-[#E6E8EE]'
                : 'text-[#8B92A5] hover:bg-[#1E222E] hover:text-[#E6E8EE]'
            }`}
          >
            <PanelLeft className="h-4 w-4" />
          </button>
        </Tooltip>

        <Tooltip label="Toggle Terminal" shortcut="Ctrl+`">
          <button
            type="button"
            onClick={onToggleTerminal}
            aria-label="Toggle Terminal"
            className={`rounded-md p-1.5 transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#6366F1] ${
              showTerminal
                ? 'bg-[#1E222E] text-[#E6E8EE]'
                : 'text-[#8B92A5] hover:bg-[#1E222E] hover:text-[#E6E8EE]'
            }`}
          >
            <PanelBottom className="h-4 w-4" />
          </button>
        </Tooltip>

        <Tooltip label="Toggle Agent Panel" shortcut="Ctrl+L">
          <button
            type="button"
            onClick={onToggleRightAgent}
            aria-label="Toggle Agent Panel"
            className={`rounded-md p-1.5 transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#6366F1] ${
              showRightAgent
                ? 'bg-[#1E222E] text-[#E6E8EE]'
                : 'text-[#8B92A5] hover:bg-[#1E222E] hover:text-[#E6E8EE]'
            }`}
          >
            <PanelRight className="h-4 w-4" />
          </button>
        </Tooltip>
      </div>
    </header>
  );
};

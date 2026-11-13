import React, { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import {
  ArrowUp,
  Clock,
  Folder,
  FolderOpen,
  FolderPlus,
  Loader2,
  MessageSquare,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import { HomeChatMessage, RecentWorkspace, WorkspaceSummary } from '../types/ide';
import { DigitalClock } from './DigitalClock';

interface HomeScreenProps {
  recentWorkspaces: RecentWorkspace[];
  availableWorkspaces: WorkspaceSummary[];
  chatMessages: HomeChatMessage[];
  isChatBusy: boolean;
  onOpenLocalFolder: () => void;
  onCreateNewFolder: (name: string, template: 'blank' | 'rust' | 'typescript') => Promise<void>;
  onOpenRecent: (item: RecentWorkspace) => void;
  onRemoveRecent: (item: RecentWorkspace) => void;
  onOpenWorkspaceSummary: (ws: WorkspaceSummary) => void;
  onSendChat: (text: string) => Promise<void>;
  onClearChat: () => void;
}

const SMALLTALK_PROMPTS = [
  'Hey! What should we build today?',
  'Suggest a compact Rust CLI tool idea',
  'Quick tips for optimizing Tauri memory on Linux',
];

export const HomeScreen: React.FC<HomeScreenProps> = ({
  recentWorkspaces,
  availableWorkspaces,
  chatMessages,
  isChatBusy,
  onOpenLocalFolder,
  onCreateNewFolder,
  onOpenRecent,
  onRemoveRecent,
  onOpenWorkspaceSummary,
  onSendChat,
  onClearChat,
}) => {
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [template, setTemplate] = useState<'blank' | 'rust' | 'typescript'>('rust');
  const [isCreating, setIsCreating] = useState(false);

  const [chatInput, setChatInput] = useState('');
  const chatScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [chatMessages, isChatBusy]);

  const submitCreateFolder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!folderName.trim() || isCreating) return;
    setIsCreating(true);
    try {
      await onCreateNewFolder(folderName.trim(), template);
      setCreatingFolder(false);
      setFolderName('');
    } finally {
      setIsCreating(false);
    }
  };

  const submitChat = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const trimmed = chatInput.trim();
    if (!trimmed || isChatBusy) return;
    setChatInput('');
    await onSendChat(trimmed);
  };

  return (
    <div className="relative flex h-full w-full flex-col overflow-y-auto bg-[#0F1117] px-6 py-8">
      {/* Centered Hero: Brand + Large Digital Clock */}
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
        className="mx-auto flex w-full max-w-5xl flex-col items-center pt-2 pb-8"
      >
        <div className="flex items-center gap-3 mb-4">
          <img
            src="/icon.svg"
            alt="Aetheris logo"
            className="h-9 w-9 rounded-lg object-contain"
          />
          <h1 className="text-2xl font-bold tracking-tight text-[#E6E8EE]">
            Aetheris
          </h1>
        </div>

        <DigitalClock variant="hero" />
      </motion.div>

      {/* Main 2-column Workspace + AI Smalltalk Grid */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2, delay: 0.04, ease: [0.16, 1, 0.3, 1] }}
        className="mx-auto grid w-full max-w-5xl grid-cols-1 gap-6 lg:grid-cols-12 pb-6"
      >
        {/* Left Column: Start Actions, Recent Folders & Workspaces */}
        <div className="lg:col-span-6 space-y-6">
          <section className="rounded-lg border border-[#272B38] bg-[#161922] p-4 space-y-3">
            <h2 className="text-[13px] font-semibold text-[#E6E8EE]">Start</h2>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <button
                type="button"
                onClick={onOpenLocalFolder}
                className="flex items-center gap-3 rounded-md border border-[#272B38] bg-[#0F1117] px-3.5 py-3 text-left hover:border-[#6366F1]/70 hover:bg-[#1E222E] transition-colors"
              >
                <FolderOpen className="h-4 w-4 shrink-0 text-[#818CF8]" />
                <div className="min-w-0">
                  <div className="text-[13px] font-medium text-[#E6E8EE]">Open Folder</div>
                  <div className="text-[11.5px] text-[#8B92A5] truncate">
                    Browse disk directory
                  </div>
                </div>
              </button>

              <button
                type="button"
                onClick={() => setCreatingFolder((prev) => !prev)}
                className={`flex items-center gap-3 rounded-md border px-3.5 py-3 text-left transition-colors ${
                  creatingFolder
                    ? 'border-[#6366F1] bg-[#6366F1]/10'
                    : 'border-[#272B38] bg-[#0F1117] hover:border-[#6366F1]/70 hover:bg-[#1E222E]'
                }`}
              >
                <FolderPlus className="h-4 w-4 shrink-0 text-[#818CF8]" />
                <div className="min-w-0">
                  <div className="text-[13px] font-medium text-[#E6E8EE]">New Folder</div>
                  <div className="text-[11.5px] text-[#8B92A5] truncate">
                    Create project directory
                  </div>
                </div>
              </button>
            </div>

            {creatingFolder && (
              <form
                onSubmit={submitCreateFolder}
                className="rounded-md border border-[#272B38] bg-[#0F1117] p-3 space-y-3"
              >
                <div className="flex items-center justify-between">
                  <span className="text-[12px] font-medium text-[#E6E8EE]">
                    Create New Folder
                  </span>
                  <button
                    type="button"
                    onClick={() => setCreatingFolder(false)}
                    aria-label="Cancel new folder"
                    className="rounded p-0.5 text-[#8B92A5] hover:text-[#E6E8EE]"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>

                <input
                  autoFocus
                  type="text"
                  value={folderName}
                  onChange={(e) => setFolderName(e.target.value)}
                  placeholder="my-rust-project"
                  className="w-full rounded-md border border-[#272B38] bg-[#161922] px-3 py-1.5 font-mono text-[12.5px] text-[#E6E8EE] placeholder-[#52596E] focus:border-[#6366F1] focus:outline-none"
                />

                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1 rounded-md bg-[#161922] p-0.5">
                    {(['blank', 'rust', 'typescript'] as const).map((tpl) => (
                      <button
                        key={tpl}
                        type="button"
                        onClick={() => setTemplate(tpl)}
                        className={`rounded px-2.5 py-1 text-[11.5px] font-medium capitalize transition-colors whitespace-nowrap ${
                          template === tpl
                            ? 'bg-[#1E222E] text-[#E6E8EE]'
                            : 'text-[#8B92A5] hover:text-[#E6E8EE]'
                        }`}
                      >
                        {tpl}
                      </button>
                    ))}
                  </div>

                  <button
                    type="submit"
                    disabled={isCreating || !folderName.trim()}
                    className="flex items-center gap-1.5 rounded-md bg-[#6366F1] px-3 py-1.5 text-[12px] font-medium text-white hover:bg-[#818CF8] disabled:opacity-40 transition-colors whitespace-nowrap shrink-0"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    <span>{isCreating ? 'Creating...' : 'Create'}</span>
                  </button>
                </div>
              </form>
            )}
          </section>

          {/* Recent Folders */}
          <section className="rounded-lg border border-[#272B38] bg-[#161922] p-4 space-y-2.5">
            <div className="flex items-center justify-between">
              <h2 className="text-[13px] font-semibold text-[#E6E8EE]">Recent</h2>
              <span className="text-[11.5px] tabular-nums text-[#8B92A5]">
                {recentWorkspaces.length} saved
              </span>
            </div>

            {recentWorkspaces.length === 0 ? (
              <div className="py-4 text-[12px] text-[#8B92A5]">
                No recent folders yet. Open a folder or pick one below to begin.
              </div>
            ) : (
              <div className="divide-y divide-[#272B38]/70">
                {recentWorkspaces.map((item) => (
                  <div
                    key={`${item.source}-${item.id}`}
                    className="group flex items-center justify-between gap-2 py-2"
                  >
                    <button
                      type="button"
                      onClick={() => onOpenRecent(item)}
                      className="flex min-w-0 flex-1 items-center gap-2.5 text-left hover:text-white"
                    >
                      <Clock className="h-3.5 w-3.5 shrink-0 text-[#818CF8]" />
                      <div className="min-w-0">
                        <div className="truncate text-[12.5px] font-medium text-[#E6E8EE] group-hover:text-[#818CF8] transition-colors">
                          {item.name}
                        </div>
                        <div className="truncate font-mono text-[11px] text-[#8B92A5]">
                          {item.nativeRoot ?? item.source} · {item.lastOpenedAt}
                        </div>
                      </div>
                    </button>

                    <button
                      type="button"
                      aria-label={`Remove ${item.name} from recents`}
                      onClick={() => onRemoveRecent(item)}
                      className="rounded p-1 text-[#8B92A5] opacity-0 group-hover:opacity-100 hover:bg-[#1E222E] hover:text-red-400 transition-all"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Built-in & Created Workspaces */}
          <section className="rounded-lg border border-[#272B38] bg-[#161922] p-4 space-y-2.5">
            <h2 className="text-[13px] font-semibold text-[#E6E8EE]">Workspaces</h2>
            <div className="divide-y divide-[#272B38]/70">
              {availableWorkspaces.map((ws) => (
                <button
                  key={ws.id}
                  type="button"
                  onClick={() => onOpenWorkspaceSummary(ws)}
                  className="flex w-full items-center justify-between gap-3 py-2 text-left hover:bg-[#1E222E]/60 px-1.5 -mx-1.5 rounded transition-colors"
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <Folder className="h-3.5 w-3.5 shrink-0 text-[#8B92A5]" />
                    <div className="min-w-0">
                      <div className="truncate text-[12.5px] font-medium text-[#E6E8EE]">
                        {ws.name}
                      </div>
                      <div className="truncate text-[11.5px] text-[#8B92A5]">
                        {ws.description}
                      </div>
                    </div>
                  </div>
                  <span className="font-mono text-[11px] text-[#8B92A5] shrink-0">
                    {ws.language}
                  </span>
                </button>
              ))}
            </div>
          </section>
        </div>

        {/* Right Column: Home Companion Chat */}
        <section className="lg:col-span-6 flex h-[480px] flex-col rounded-lg border border-[#272B38] bg-[#161922]">
          <div className="flex h-11 shrink-0 items-center justify-between border-b border-[#272B38] px-4">
            <div className="flex items-center gap-2">
              <MessageSquare className="h-4 w-4 text-[#818CF8]" />
              <h2 className="text-[13px] font-semibold text-[#E6E8EE]">
                Quick Chat
              </h2>
            </div>
            {chatMessages.length > 0 && (
              <button
                type="button"
                onClick={onClearChat}
                className="flex items-center gap-1 rounded px-2 py-1 text-[11.5px] text-[#8B92A5] hover:bg-[#1E222E] hover:text-[#E6E8EE] transition-colors"
              >
                <Trash2 className="h-3 w-3" />
                <span>Clear</span>
              </button>
            )}
          </div>

          <div ref={chatScrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
            {chatMessages.length === 0 ? (
              <div className="space-y-4 pt-2">
                <p className="text-[12.5px] leading-relaxed text-[#8B92A5]">
                  Make smalltalk, bounce an architecture idea around, or ask a quick question
                  before opening a project.
                </p>
                <div className="space-y-1.5">
                  {SMALLTALK_PROMPTS.map((sample) => (
                    <button
                      key={sample}
                      type="button"
                      onClick={() => onSendChat(sample)}
                      className="block w-full rounded-md border border-[#272B38] bg-[#0F1117] px-3 py-2 text-left text-[12px] text-[#B5BBC9] hover:border-[#6366F1]/60 hover:text-[#E6E8EE] transition-colors"
                    >
                      {sample}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              chatMessages.map((msg) => (
                <div key={msg.id} className="space-y-1">
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
                </div>
              ))
            )}

            {isChatBusy && (
              <div className="flex items-center gap-2 rounded-md border border-[#272B38] bg-[#0F1117] px-3 py-2 text-[12px] text-[#8B92A5]">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-[#818CF8]" />
                <span>Thinking...</span>
              </div>
            )}
          </div>

          <form onSubmit={submitChat} className="border-t border-[#272B38] p-3">
            <div className="flex items-center gap-2 rounded-md border border-[#272B38] bg-[#0F1117] px-3 py-1.5 focus-within:border-[#6366F1] transition-colors">
              <input
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder="Say hello or ask anything..."
                className="flex-1 bg-transparent text-[12.5px] text-[#E6E8EE] placeholder-[#52596E] focus:outline-none"
              />
              <button
                type="submit"
                disabled={isChatBusy || !chatInput.trim()}
                aria-label="Send message"
                className="flex items-center justify-center rounded bg-[#6366F1] p-1.5 text-white hover:bg-[#818CF8] disabled:opacity-40 transition-colors"
              >
                <ArrowUp className="h-3.5 w-3.5" />
              </button>
            </div>
          </form>
        </section>
      </motion.div>
    </div>
  );
};

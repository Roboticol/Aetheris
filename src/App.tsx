import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  FileCode2,
  FolderOpen,
  Save,
  X,
} from 'lucide-react';
import {
  AgentMessage,
  AgentMode,
  AgentPatch,
  CursorPosition,
  EditorTab,
  FileNode,
  HomeChatMessage,
  RecentWorkspace,
  SearchHit,
  TerminalEntry,
  ThinkingMode,
  WorkspaceSummary,
} from './types/ide';
import {
  ActiveWorkspaceContext,
  createServerWorkspaceFolder,
  createTauriWorkspaceFolder,
  createWorkspaceEntry,
  deleteWorkspaceEntry,
  execWorkspaceCommand,
  fetchWorkspaceTree,
  flattenFilePaths,
  isTauriRuntime,
  listStarterWorkspaces,
  loadLocalDirHandle,
  loadRecentWorkspaces,
  readWorkspaceFile,
  recordRecentWorkspace,
  removeRecentWorkspace,
  renameWorkspaceEntry,
  resetStarterWorkspace,
  runAgentPlan,
  saveLocalDirHandle,
  searchWorkspace,
  sendHomeChat,
  writeWorkspaceFile,
} from './services/transport';
import { TopBar } from './components/TopBar';
import { ExplorerSidebar } from './components/ExplorerSidebar';
import { CodeEditor } from './components/CodeEditor';
import { DiffViewer } from './components/DiffViewer';
import { TerminalDrawer } from './components/TerminalDrawer';
import { AgentPanel } from './components/AgentPanel';
import { CommandPalette } from './components/CommandPalette';
import { HomeScreen } from './components/HomeScreen';
import { Tooltip } from './components/Tooltip';

export default function App() {
  const [view, setView] = useState<'home' | 'editor'>('home');
  const [starters, setStarters] = useState<WorkspaceSummary[]>([]);
  const [recentWorkspaces, setRecentWorkspaces] = useState<RecentWorkspace[]>(() =>
    loadRecentWorkspaces()
  );
  const [workspaceCtx, setWorkspaceCtx] = useState<ActiveWorkspaceContext>({
    source: 'starter',
    id: 'rust-cli-indexer',
    name: 'rust-cli-indexer',
  });
  const [tree, setTree] = useState<FileNode[]>([]);
  const [tabs, setTabs] = useState<EditorTab[]>([]);
  const [activeTabPath, setActiveTabPath] = useState<string | null>(null);
  const [jumpTarget, setJumpTarget] = useState<{ path: string; line: number; seq: number } | null>(
    null
  );
  const [cursor, setCursor] = useState<CursorPosition>({ line: 1, col: 1 });

  // Layout panels
  const [showLeftSidebar, setShowLeftSidebar] = useState(true);
  const [sidebarTab, setSidebarTab] = useState<'files' | 'search'>('files');
  const [showRightAgent, setShowRightAgent] = useState(true);
  const [showTerminal, setShowTerminal] = useState(true);
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Search & symbol index
  const [searchQuery, setSearchQuery] = useState('');
  const [symbolsOnly, setSymbolsOnly] = useState(true);
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [allSymbols, setAllSymbols] = useState<SearchHit[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  // Agent & Diff state
  const [agentMessages, setAgentMessages] = useState<AgentMessage[]>([]);
  const [thinkingMode, setThinkingMode] = useState<ThinkingMode>('fast');
  const [agentMode, setAgentMode] = useState<AgentMode>('action');
  const [isAgentBusy, setIsAgentBusy] = useState(false);
  const [activeDiffPatchId, setActiveDiffPatchId] = useState<string | null>(null);

  // Home smalltalk chat state
  const [homeChatMessages, setHomeChatMessages] = useState<HomeChatMessage[]>([]);
  const [isHomeChatBusy, setIsHomeChatBusy] = useState(false);

  // Terminal state
  const [terminalEntries, setTerminalEntries] = useState<TerminalEntry[]>([]);
  const [isTerminalRunning, setIsTerminalRunning] = useState(false);

  // Inline banner feedback (no window.alert)
  const [banner, setBanner] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);

  const showNotice = useCallback((tone: 'info' | 'error', text: string) => {
    setBanner({ tone, text });
  }, []);

  useEffect(() => {
    if (!banner) return;
    const timer = setTimeout(() => setBanner(null), 5000);
    return () => clearTimeout(timer);
  }, [banner]);

  const refreshWorkspace = useCallback(
    async (ctx: ActiveWorkspaceContext, openFirstFile = false) => {
      try {
        const nextTree = await fetchWorkspaceTree(ctx);
        setTree(nextTree);

        const hits = await searchWorkspace(ctx, '', true, nextTree);
        setAllSymbols(hits);
        setSearchHits(hits);

        if (openFirstFile) {
          const paths = flattenFilePaths(nextTree);
          const preferred =
            paths.find((p) => p.endsWith('main.rs') || p.endsWith('index.ts')) ?? paths[0];
          if (preferred) {
            const content = await readWorkspaceFile(ctx, preferred);
            setTabs([
              {
                path: preferred,
                name: preferred.split('/').pop() ?? preferred,
                content,
                savedContent: content,
                isDirty: false,
              },
            ]);
            setActiveTabPath(preferred);
          } else {
            setTabs([]);
            setActiveTabPath(null);
          }
        }
      } catch (err) {
        showNotice('error', err instanceof Error ? err.message : 'Failed to load workspace');
      }
    },
    [showNotice]
  );

  // Boot: load available workspaces (stays on HomeScreen until user picks/opens one)
  useEffect(() => {
    let mounted = true;
    (async () => {
      if (isTauriRuntime()) return;
      const list = await listStarterWorkspaces();
      if (mounted) {
        setStarters(list);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const openFile = useCallback(
    async (filePath: string, line?: number) => {
      setActiveDiffPatchId(null);
      const existing = tabs.find((t) => t.path === filePath);
      if (existing) {
        setActiveTabPath(filePath);
        if (line) {
          setJumpTarget({ path: filePath, line, seq: Date.now() });
        }
        return;
      }

      try {
        const content = await readWorkspaceFile(workspaceCtx, filePath);
        const name = filePath.split('/').pop() ?? filePath;
        setTabs((prev) => [
          ...prev,
          { path: filePath, name, content, savedContent: content, isDirty: false },
        ]);
        setActiveTabPath(filePath);
        if (line) {
          setJumpTarget({ path: filePath, line, seq: Date.now() });
        }
      } catch (err) {
        showNotice('error', err instanceof Error ? err.message : `Unable to open ${filePath}`);
      }
    },
    [tabs, workspaceCtx, showNotice]
  );

  const handleSaveTab = useCallback(
    async (targetPath?: string) => {
      const pathToSave = targetPath ?? activeTabPath;
      if (!pathToSave) return;
      const tab = tabs.find((t) => t.path === pathToSave);
      if (!tab) return;

      try {
        await writeWorkspaceFile(workspaceCtx, tab.path, tab.content);
        setTabs((prev) =>
          prev.map((t) =>
            t.path === tab.path ? { ...t, savedContent: t.content, isDirty: false } : t
          )
        );
        const hits = await searchWorkspace(workspaceCtx, searchQuery, symbolsOnly, tree);
        setSearchHits(hits);
        if (!searchQuery.trim()) setAllSymbols(hits);
      } catch (err) {
        showNotice('error', err instanceof Error ? err.message : 'Failed to save file');
      }
    },
    [activeTabPath, tabs, workspaceCtx, searchQuery, symbolsOnly, tree, showNotice]
  );

  // Global keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        setPaletteOpen((prev) => !prev);
      } else if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((prev) => !prev);
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setShowLeftSidebar(true);
        setSidebarTab('search');
      } else if (mod && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        setShowLeftSidebar((prev) => !prev);
      } else if (mod && e.key === '`') {
        e.preventDefault();
        setShowTerminal((prev) => !prev);
      } else if (mod && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        setShowRightAgent((prev) => !prev);
      } else if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void handleSaveTab();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleSaveTab]);

  const handleOpenLocalFolder = async () => {
    try {
      if (isTauriRuntime()) {
        const selected = await window.__TAURI_INTERNALS__!.invoke<string | null>(
          'plugin:dialog|open',
          { options: { directory: true, multiple: false } }
        );
        if (!selected || typeof selected !== 'string') return;
        const folderName = selected.split(/[/\\]/).filter(Boolean).pop() ?? selected;
        const nextCtx: ActiveWorkspaceContext = {
          source: 'tauri-native',
          id: selected,
          name: folderName,
          nativeRoot: selected,
        };
        setWorkspaceCtx(nextCtx);
        setAgentMessages([]);
        setTerminalEntries([]);
        setActiveDiffPatchId(null);
        setView('editor');
        setRecentWorkspaces(
          recordRecentWorkspace({
            id: selected,
            name: folderName,
            source: 'tauri-native',
            nativeRoot: selected,
            lastOpenedAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          })
        );
        await refreshWorkspace(nextCtx, true);
        return;
      }

      if (!window.showDirectoryPicker) {
        showNotice(
          'error',
          'Your current browser or embedded frame does not support local directory picking. Use the native Linux/Windows app or a Chromium desktop browser.'
        );
        return;
      }

      const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
      const nextCtx: ActiveWorkspaceContext = {
        source: 'local-fs',
        id: dirHandle.name,
        name: dirHandle.name,
        localDirHandle: dirHandle,
      };
      await saveLocalDirHandle(dirHandle.name, dirHandle);
      setWorkspaceCtx(nextCtx);
      setAgentMessages([]);
      setTerminalEntries([]);
      setActiveDiffPatchId(null);
      setView('editor');
      setRecentWorkspaces(
        recordRecentWorkspace({
          id: dirHandle.name,
          name: dirHandle.name,
          source: 'local-fs',
          lastOpenedAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        })
      );
      await refreshWorkspace(nextCtx, true);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      showNotice(
        'error',
        err instanceof Error
          ? err.message
          : 'Unable to open local folder in this browser context.'
      );
    }
  };

  const handleSelectStarter = async (id: string) => {
    const starter = starters.find((s) => s.id === id);
    const nextCtx: ActiveWorkspaceContext = {
      source: 'starter',
      id,
      name: starter?.name ?? id,
    };
    setWorkspaceCtx(nextCtx);
    setAgentMessages([]);
    setTerminalEntries([]);
    setActiveDiffPatchId(null);
    setView('editor');
    setRecentWorkspaces(
      recordRecentWorkspace({
        id,
        name: nextCtx.name,
        source: 'starter',
        lastOpenedAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      })
    );
    await refreshWorkspace(nextCtx, true);
  };

  const handleCreateNewFolder = async (
    name: string,
    template: 'blank' | 'rust' | 'typescript'
  ) => {
    try {
      if (isTauriRuntime()) {
        const parent = await window.__TAURI_INTERNALS__!.invoke<string | null>(
          'plugin:dialog|open',
          { options: { directory: true, multiple: false, title: 'Choose parent directory' } }
        );
        if (!parent || typeof parent !== 'string') return;
        const createdPath = await createTauriWorkspaceFolder(parent, name, template);
        const folderName = createdPath.split(/[/\\]/).filter(Boolean).pop() ?? name;
        const nextCtx: ActiveWorkspaceContext = {
          source: 'tauri-native',
          id: createdPath,
          name: folderName,
          nativeRoot: createdPath,
        };
        setWorkspaceCtx(nextCtx);
        setAgentMessages([]);
        setTerminalEntries([]);
        setActiveDiffPatchId(null);
        setView('editor');
        setRecentWorkspaces(
          recordRecentWorkspace({
            id: createdPath,
            name: folderName,
            source: 'tauri-native',
            nativeRoot: createdPath,
            lastOpenedAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          })
        );
        await refreshWorkspace(nextCtx, true);
        return;
      }

      const created = await createServerWorkspaceFolder(name, template);
      const updatedList = await listStarterWorkspaces();
      setStarters(updatedList);
      const nextCtx: ActiveWorkspaceContext = {
        source: 'starter',
        id: created.id,
        name: created.name,
      };
      setWorkspaceCtx(nextCtx);
      setAgentMessages([]);
      setTerminalEntries([]);
      setActiveDiffPatchId(null);
      setView('editor');
      setRecentWorkspaces(
        recordRecentWorkspace({
          id: created.id,
          name: created.name,
          source: 'starter',
          lastOpenedAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        })
      );
      await refreshWorkspace(nextCtx, true);
    } catch (err) {
      showNotice('error', err instanceof Error ? err.message : 'Failed to create folder');
    }
  };

  const handleOpenRecent = async (item: RecentWorkspace) => {
    try {
      if (item.source === 'tauri-native' && item.nativeRoot) {
        const nextCtx: ActiveWorkspaceContext = {
          source: 'tauri-native',
          id: item.id,
          name: item.name,
          nativeRoot: item.nativeRoot,
        };
        setWorkspaceCtx(nextCtx);
        setAgentMessages([]);
        setTerminalEntries([]);
        setActiveDiffPatchId(null);
        setView('editor');
        setRecentWorkspaces(
          recordRecentWorkspace({
            ...item,
            lastOpenedAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          })
        );
        await refreshWorkspace(nextCtx, true);
        return;
      }

      if (item.source === 'local-fs') {
        const handle = await loadLocalDirHandle(item.id);
        if (!handle) {
          showNotice('info', 'Stored folder handle expired — select the folder to reopen.');
          await handleOpenLocalFolder();
          return;
        }
        const permHandle = handle as FileSystemDirectoryHandle & {
          requestPermission?: (opts: { mode: 'read' | 'readwrite' }) => Promise<string>;
        };
        if (permHandle.requestPermission) {
          const perm = await permHandle.requestPermission({ mode: 'readwrite' });
          if (perm !== 'granted') {
            showNotice('error', 'Folder permission was denied.');
            return;
          }
        }
        const nextCtx: ActiveWorkspaceContext = {
          source: 'local-fs',
          id: item.id,
          name: item.name,
          localDirHandle: handle,
        };
        setWorkspaceCtx(nextCtx);
        setAgentMessages([]);
        setTerminalEntries([]);
        setActiveDiffPatchId(null);
        setView('editor');
        setRecentWorkspaces(
          recordRecentWorkspace({
            ...item,
            lastOpenedAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          })
        );
        await refreshWorkspace(nextCtx, true);
        return;
      }

      await handleSelectStarter(item.id);
    } catch (err) {
      showNotice('error', err instanceof Error ? err.message : 'Failed to reopen recent folder');
    }
  };

  const handleSendHomeChat = async (text: string) => {
    const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const userTurn: HomeChatMessage = {
      id: `hc-u-${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: timeStr,
    };
    const nextHistory = [...homeChatMessages, userTurn];
    setHomeChatMessages(nextHistory);
    setIsHomeChatBusy(true);

    try {
      const reply = await sendHomeChat(
        nextHistory
          .filter((m) => !m.error)
          .map((m) => ({ role: m.role, content: m.content }))
      );
      setHomeChatMessages((prev) => [
        ...prev,
        {
          id: `hc-a-${Date.now()}`,
          role: 'assistant',
          content: reply,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        },
      ]);
    } catch (err) {
      setHomeChatMessages((prev) => [
        ...prev,
        {
          id: `hc-e-${Date.now()}`,
          role: 'assistant',
          content: '',
          error: err instanceof Error ? err.message : 'Chat failed',
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        },
      ]);
    } finally {
      setIsHomeChatBusy(false);
    }
  };

  const handleResetStarter = async () => {
    if (workspaceCtx.source !== 'starter') return;
    try {
      await resetStarterWorkspace(workspaceCtx.id);
      setAgentMessages([]);
      setActiveDiffPatchId(null);
      await refreshWorkspace(workspaceCtx, true);
      showNotice('info', `Reset ${workspaceCtx.name} to initial starter files.`);
    } catch (err) {
      showNotice('error', err instanceof Error ? err.message : 'Reset failed');
    }
  };

  const handleSearchChange = async (query: string, symOnly: boolean) => {
    setSearchQuery(query);
    setSymbolsOnly(symOnly);
    setIsSearching(true);
    try {
      const hits = await searchWorkspace(workspaceCtx, query, symOnly, tree);
      setSearchHits(hits);
    } catch (err) {
      showNotice('error', err instanceof Error ? err.message : 'Search failed');
    } finally {
      setIsSearching(false);
    }
  };

  const handleCreateEntry = async (relPath: string, kind: 'file' | 'dir') => {
    try {
      await createWorkspaceEntry(workspaceCtx, relPath, kind);
      await refreshWorkspace(workspaceCtx, false);
      if (kind === 'file') {
        await openFile(relPath);
      }
    } catch (err) {
      showNotice('error', err instanceof Error ? err.message : 'Failed to create item');
    }
  };

  const handleRenameEntry = async (oldPath: string, newPath: string) => {
    try {
      await renameWorkspaceEntry(workspaceCtx, oldPath, newPath);
      setTabs((prev) =>
        prev.map((t) =>
          t.path === oldPath
            ? { ...t, path: newPath, name: newPath.split('/').pop() ?? newPath }
            : t
        )
      );
      if (activeTabPath === oldPath) setActiveTabPath(newPath);
      await refreshWorkspace(workspaceCtx, false);
    } catch (err) {
      showNotice('error', err instanceof Error ? err.message : 'Rename failed');
    }
  };

  const handleDeleteEntry = async (relPath: string) => {
    try {
      await deleteWorkspaceEntry(workspaceCtx, relPath);
      setTabs((prev) => prev.filter((t) => t.path !== relPath && !t.path.startsWith(`${relPath}/`)));
      if (activeTabPath === relPath || activeTabPath?.startsWith(`${relPath}/`)) {
        setActiveTabPath(null);
      }
      await refreshWorkspace(workspaceCtx, false);
    } catch (err) {
      showNotice('error', err instanceof Error ? err.message : 'Delete failed');
    }
  };

  const handleExecuteCommand = async (command: string) => {
    setIsTerminalRunning(true);
    try {
      const result = await execWorkspaceCommand(workspaceCtx, command, tree);
      setTerminalEntries((prev) => [
        ...prev,
        {
          ...result,
          id: `${Date.now()}-${Math.random()}`,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        },
      ]);
      await refreshWorkspace(workspaceCtx, false);
    } catch (err) {
      showNotice('error', err instanceof Error ? err.message : 'Terminal execution failed');
    } finally {
      setIsTerminalRunning(false);
    }
  };

  const handleRunAgent = async (prompt: string, overrideMode?: AgentMode) => {
    const effectiveMode = overrideMode ?? agentMode;
    const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const userMsg: AgentMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      mode: effectiveMode,
      content: prompt,
      timestamp: timeStr,
    };
    setAgentMessages((prev) => [...prev, userMsg]);
    setIsAgentBusy(true);

    try {
      const openBuffers: Record<string, string> = {};
      for (const tab of tabs) {
        openBuffers[tab.path] = tab.content;
      }

      const result = await runAgentPlan({
        ctx: workspaceCtx,
        prompt,
        activeFile: activeTabPath,
        tree,
        openBuffers,
        thinkingMode,
        agentMode: effectiveMode,
      });

      const assistantMsg: AgentMessage = {
        id: `asst-${Date.now()}`,
        role: 'assistant',
        mode: effectiveMode,
        content: result.summary,
        steps: result.steps,
        patches: result.patches,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };

      setAgentMessages((prev) => [...prev, assistantMsg]);
      if (result.patches.length > 0) {
        setActiveDiffPatchId(result.patches[0].id);
      }
    } catch (err) {
      const errorText = err instanceof Error ? err.message : 'Agent request failed';
      setAgentMessages((prev) => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          role: 'assistant',
          content: '',
          error: errorText,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        },
      ]);
    } finally {
      setIsAgentBusy(false);
    }
  };

  const applySinglePatch = useCallback(
    async (patch: AgentPatch) => {
      if (patch.action === 'delete') {
        await deleteWorkspaceEntry(workspaceCtx, patch.path);
        setTabs((prev) => prev.filter((t) => t.path !== patch.path));
        if (activeTabPath === patch.path) setActiveTabPath(null);
      } else {
        await writeWorkspaceFile(workspaceCtx, patch.path, patch.content);
        const name = patch.path.split('/').pop() ?? patch.path;
        setTabs((prev) => {
          const exists = prev.some((t) => t.path === patch.path);
          if (exists) {
            return prev.map((t) =>
              t.path === patch.path
                ? { ...t, content: patch.content, savedContent: patch.content, isDirty: false }
                : t
            );
          }
          return [
            ...prev,
            {
              path: patch.path,
              name,
              content: patch.content,
              savedContent: patch.content,
              isDirty: false,
            },
          ];
        });
        setActiveTabPath(patch.path);
      }

      setAgentMessages((prev) =>
        prev.map((m) => ({
          ...m,
          patches: m.patches?.map((p) => (p.id === patch.id ? { ...p, status: 'accepted' } : p)),
        }))
      );
      if (activeDiffPatchId === patch.id) {
        setActiveDiffPatchId(null);
      }
    },
    [workspaceCtx, activeTabPath, activeDiffPatchId]
  );

  const handleAcceptPatch = async (patchId: string) => {
    const patch = agentMessages.flatMap((m) => m.patches ?? []).find((p) => p.id === patchId);
    if (!patch) return;
    try {
      await applySinglePatch(patch);
      await refreshWorkspace(workspaceCtx, false);
    } catch (err) {
      showNotice('error', err instanceof Error ? err.message : 'Failed to apply patch');
    }
  };

  const handleRejectPatch = (patchId: string) => {
    setAgentMessages((prev) =>
      prev.map((m) => ({
        ...m,
        patches: m.patches?.map((p) => (p.id === patchId ? { ...p, status: 'rejected' } : p)),
      }))
    );
    if (activeDiffPatchId === patchId) {
      setActiveDiffPatchId(null);
    }
  };

  const handleAcceptAllPatches = async (messageId: string) => {
    const targetMsg = agentMessages.find((m) => m.id === messageId);
    const pending = targetMsg?.patches?.filter((p) => p.status === 'pending') ?? [];
    if (pending.length === 0) return;

    try {
      for (const patch of pending) {
        await applySinglePatch(patch);
      }
      await refreshWorkspace(workspaceCtx, false);
    } catch (err) {
      showNotice('error', err instanceof Error ? err.message : 'Failed applying patches');
    }
  };

  const activeTab = useMemo(
    () => tabs.find((t) => t.path === activeTabPath) ?? null,
    [tabs, activeTabPath]
  );

  const activeDiffPatch = useMemo(
    () =>
      activeDiffPatchId
        ? agentMessages.flatMap((m) => m.patches ?? []).find((p) => p.id === activeDiffPatchId) ??
          null
        : null,
    [activeDiffPatchId, agentMessages]
  );

  const dirtyPaths = useMemo(
    () => new Set(tabs.filter((t) => t.isDirty).map((t) => t.path)),
    [tabs]
  );

  const allFilePaths = useMemo(() => flattenFilePaths(tree), [tree]);

  const closeTab = (pathToClose: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const nextTabs = tabs.filter((t) => t.path !== pathToClose);
    setTabs(nextTabs);
    if (activeTabPath === pathToClose) {
      setActiveTabPath(nextTabs[nextTabs.length - 1]?.path ?? null);
    }
  };

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[#0F1117] text-[#E6E8EE]">
      {view === 'editor' && (
        <TopBar
          workspaceName={workspaceCtx.name}
          workspaceSource={workspaceCtx.source}
          activeWorkspaceId={workspaceCtx.id}
          starters={starters}
          showLeftSidebar={showLeftSidebar}
          showRightAgent={showRightAgent}
          showTerminal={showTerminal}
          onToggleLeftSidebar={() => setShowLeftSidebar((p) => !p)}
          onToggleRightAgent={() => setShowRightAgent((p) => !p)}
          onToggleTerminal={() => setShowTerminal((p) => !p)}
          onOpenCommandPalette={() => setPaletteOpen(true)}
          onOpenLocalFolder={handleOpenLocalFolder}
          onSelectStarter={handleSelectStarter}
          onResetStarter={handleResetStarter}
          onGoHome={() => setView('home')}
        />
      )}

      {banner && (
        <div
          className={`flex items-center justify-between border-b px-4 py-1.5 text-[12px] ${
            banner.tone === 'error'
              ? 'border-red-500/40 bg-red-500/10 text-red-200'
              : 'border-[#6366F1]/40 bg-[#6366F1]/10 text-[#E6E8EE]'
          }`}
        >
          <span>{banner.text}</span>
          <button
            type="button"
            onClick={() => setBanner(null)}
            aria-label="Dismiss message"
            className="rounded p-0.5 hover:bg-white/10"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {view === 'home' ? (
        <main className="flex-1 min-h-0 overflow-hidden">
          <HomeScreen
            recentWorkspaces={recentWorkspaces}
            availableWorkspaces={starters}
            chatMessages={homeChatMessages}
            isChatBusy={isHomeChatBusy}
            onOpenLocalFolder={handleOpenLocalFolder}
            onCreateNewFolder={handleCreateNewFolder}
            onOpenRecent={handleOpenRecent}
            onRemoveRecent={(item) =>
              setRecentWorkspaces(removeRecentWorkspace(item.id, item.source))
            }
            onOpenWorkspaceSummary={(ws) => void handleSelectStarter(ws.id)}
            onSendChat={handleSendHomeChat}
            onClearChat={() => setHomeChatMessages([])}
          />
        </main>
      ) : (
      /* Main 3-column workbench */
      <main className="flex flex-1 min-h-0 overflow-hidden">
        {showLeftSidebar && (
          <ExplorerSidebar
            tree={tree}
            activeFilePath={activeTabPath}
            dirtyPaths={dirtyPaths}
            searchHits={searchHits}
            searchQuery={searchQuery}
            symbolsOnly={symbolsOnly}
            isSearching={isSearching}
            onSelectFile={openFile}
            onCreateEntry={handleCreateEntry}
            onRenameEntry={handleRenameEntry}
            onDeleteEntry={handleDeleteEntry}
            onSearchChange={handleSearchChange}
            activeTab={sidebarTab}
            onTabChange={setSidebarTab}
          />
        )}

        {/* Center Editor + Diff + Bottom Terminal */}
        <div className="flex flex-1 flex-col min-w-0 min-h-0 overflow-hidden">
          {/* Tab bar */}
          <div className="flex h-9 shrink-0 items-center justify-between border-b border-[#272B38] bg-[#161922] px-1 select-none">
            <div className="flex flex-1 items-center overflow-x-auto">
              {tabs.map((tab) => {
                const isActive = !activeDiffPatch && tab.path === activeTabPath;
                return (
                  <div
                    key={tab.path}
                    onClick={() => {
                      setActiveDiffPatchId(null);
                      setActiveTabPath(tab.path);
                    }}
                    className={`group flex h-9 cursor-pointer items-center gap-2 border-r border-[#272B38] px-3 text-[12px] transition-colors whitespace-nowrap shrink-0 ${
                      isActive
                        ? 'bg-[#0F1117] text-[#E6E8EE]'
                        : 'text-[#8B92A5] hover:bg-[#1E222E] hover:text-[#E6E8EE]'
                    }`}
                  >
                    <FileCode2 className="h-3.5 w-3.5 text-[#818CF8]" />
                    <span className="font-mono">{tab.name}</span>
                    {tab.isDirty && (
                      <span className="text-[11px] font-semibold text-amber-400">M</span>
                    )}
                    <button
                      type="button"
                      aria-label={`Close ${tab.name}`}
                      onClick={(e) => closeTab(tab.path, e)}
                      className="rounded p-0.5 text-[#8B92A5] opacity-60 hover:bg-[#272B38] hover:text-[#E6E8EE] group-hover:opacity-100"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                );
              })}

              {activeDiffPatch && (
                <div className="flex h-9 items-center gap-2 border-r border-[#272B38] bg-[#0F1117] px-3 text-[12px] text-[#818CF8] whitespace-nowrap shrink-0">
                  <span className="font-mono">Diff: {activeDiffPatch.path}</span>
                  <button
                    type="button"
                    aria-label="Close diff view"
                    onClick={() => setActiveDiffPatchId(null)}
                    className="rounded p-0.5 text-[#8B92A5] hover:bg-[#272B38] hover:text-[#E6E8EE]"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              )}
            </div>

            {activeTab && !activeDiffPatch && (
              <div className="flex items-center gap-3 px-3 text-[11.5px] text-[#8B92A5] shrink-0">
                <span className="hidden md:inline font-mono tabular-nums">
                  Ln {cursor.line}, Col {cursor.col}
                </span>
                {activeTab.isDirty && (
                  <Tooltip label="Save File" shortcut="Ctrl+S">
                    <button
                      type="button"
                      onClick={() => handleSaveTab(activeTab.path)}
                      className="flex items-center gap-1 rounded bg-[#6366F1] px-2 py-0.5 text-[11px] font-medium text-white hover:bg-[#818CF8] transition-colors"
                    >
                      <Save className="h-3 w-3" />
                      <span>Save</span>
                    </button>
                  </Tooltip>
                )}
              </div>
            )}
          </div>

          {/* Active Viewport: DiffViewer OR CodeEditor OR Empty State */}
          <div className="flex-1 min-h-0 overflow-hidden bg-[#0F1117]">
            {activeDiffPatch ? (
              <DiffViewer
                patch={activeDiffPatch}
                onAccept={handleAcceptPatch}
                onReject={handleRejectPatch}
                onClose={() => setActiveDiffPatchId(null)}
              />
            ) : activeTab ? (
              <CodeEditor
                filePath={activeTab.path}
                value={activeTab.content}
                targetLine={
                  jumpTarget && jumpTarget.path === activeTab.path ? jumpTarget.line : null
                }
                onChange={(nextValue) => {
                  setTabs((prev) =>
                    prev.map((t) =>
                      t.path === activeTab.path
                        ? {
                            ...t,
                            content: nextValue,
                            isDirty: nextValue !== t.savedContent,
                          }
                        : t
                    )
                  );
                }}
                onSave={() => void handleSaveTab(activeTab.path)}
                onCursorChange={setCursor}
              />
            ) : (
              <div className="flex h-full flex-col items-center justify-center p-6 text-center">
                <h1 className="text-[18px] font-semibold text-[#E6E8EE]">
                  No File Open
                </h1>
                <p className="mt-1.5 max-w-md text-[13px] text-[#8B92A5]">
                  Select a file from the Explorer, open a local folder from disk, or jump directly
                  to a symbol with <kbd className="font-mono text-[#E6E8EE]">Ctrl+P</kbd>.
                </p>
                <div className="mt-5 flex items-center gap-3">
                  <button
                    type="button"
                    onClick={handleOpenLocalFolder}
                    className="flex items-center gap-2 rounded-md border border-[#272B38] bg-[#161922] px-4 py-2 text-[12.5px] font-medium text-[#E6E8EE] hover:bg-[#1E222E] transition-colors"
                  >
                    <FolderOpen className="h-4 w-4 text-[#818CF8]" />
                    <span>Open Local Folder</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setPaletteOpen(true)}
                    className="rounded-md bg-[#6366F1] px-4 py-2 text-[12.5px] font-medium text-white hover:bg-[#818CF8] transition-colors"
                  >
                    Search Files & Symbols
                  </button>
                </div>
              </div>
            )}
          </div>

          {showTerminal && (
            <TerminalDrawer
              workspaceName={workspaceCtx.name}
              entries={terminalEntries}
              isRunning={isTerminalRunning}
              onExecute={handleExecuteCommand}
              onClear={() => setTerminalEntries([])}
              onClose={() => setShowTerminal(false)}
            />
          )}
        </div>

        {showRightAgent && (
          <AgentPanel
            messages={agentMessages}
            activeFilePath={activeTabPath}
            workspaceFileCount={allFilePaths.length}
            thinkingMode={thinkingMode}
            agentMode={agentMode}
            isBusy={isAgentBusy}
            onThinkingModeChange={setThinkingMode}
            onAgentModeChange={setAgentMode}
            onSendPrompt={handleRunAgent}
            onInspectPatch={(patch) => setActiveDiffPatchId(patch.id)}
            onAcceptPatch={handleAcceptPatch}
            onRejectPatch={handleRejectPatch}
            onAcceptAll={handleAcceptAllPatches}
            onClearHistory={() => {
              setAgentMessages([]);
              setActiveDiffPatchId(null);
            }}
          />
        )}
      </main>
      )}

      <CommandPalette
        open={paletteOpen}
        filePaths={allFilePaths}
        symbols={allSymbols}
        onClose={() => setPaletteOpen(false)}
        onSelectFile={openFile}
      />
    </div>
  );
}

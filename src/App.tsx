import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Eye,
  FileCode2,
  FolderOpen,
  Save,
  X,
} from 'lucide-react';
import {
  AgentActivityItem,
  AgentMessage,
  AgentMode,
  AgentPatch,
  CreatedProjectSummary,
  CursorPosition,
  EditorTab,
  FileNode,
  GitDiffPreview,
  GitFileEntry,
  GitStatusSnapshot,
  HomeChatMessage,
  ModelEffort,
  RecentWorkspace,
  SearchHit,
  TerminalEntry,
  WorkspaceSummary,
} from './types/ide';
import {
  ActiveWorkspaceContext,
  cancelTauriAgent,
  commitGitChanges,
  createServerWorkspaceFolder,
  createTauriWorkspaceFolder,
  createWorkspaceEntry,
  deleteWorkspaceEntry,
  discardGitChange,
  execWorkspaceCommand,
  fetchGitFileDiff,
  fetchGitStatus,
  fetchWorkspaceTree,
  flattenFilePaths,
  generateGitCommitMessage,
  initGitRepository,
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
  runGitBranchAction,
  saveLocalDirHandle,
  searchWorkspace,
  sendHomeChat,
  setGitRemoteOrigin,
  stageGitFiles,
  syncGitRemote,
  unstageGitFiles,
  writeWorkspaceFile,
} from './services/transport';
import {
  clearWorkspaceSessionMessages,
  getWorkspaceSessionKey,
  loadWorkspaceSession,
  saveWorkspaceSession,
} from './services/chatStorage';
import { TopBar } from './components/TopBar';
import { ExplorerSidebar } from './components/ExplorerSidebar';
import { CodeEditor } from './components/CodeEditor';
import { DiffViewer } from './components/DiffViewer';
import { TerminalDrawer } from './components/TerminalDrawer';
import { AgentPanel } from './components/AgentPanel';
import { CommandPalette } from './components/CommandPalette';
import { HomeScreen } from './components/HomeScreen';
import { Tooltip } from './components/Tooltip';

const PANEL_SIZES_KEY = 'aetheris.panelSizes';
const GIT_AUTOFETCH_KEY = 'aetheris.gitAutoFetch';

function loadGitAutoFetch(): boolean {
  try {
    const raw = localStorage.getItem(GIT_AUTOFETCH_KEY);
    if (raw === null) return true;
    return raw !== 'false';
  } catch {
    return true;
  }
}

interface PanelSizes {
  leftWidth: number;
  rightWidth: number;
  terminalHeight: number;
}

function loadPanelSizes(): PanelSizes {
  try {
    const raw = localStorage.getItem(PANEL_SIZES_KEY);
    if (!raw) return { leftWidth: 288, rightWidth: 380, terminalHeight: 224 };
    const parsed = JSON.parse(raw) as Partial<PanelSizes>;
    return {
      leftWidth:
        typeof parsed.leftWidth === 'number'
          ? Math.min(560, Math.max(220, parsed.leftWidth))
          : 288,
      rightWidth:
        typeof parsed.rightWidth === 'number'
          ? Math.min(640, Math.max(280, parsed.rightWidth))
          : 380,
      terminalHeight:
        typeof parsed.terminalHeight === 'number'
          ? Math.min(500, Math.max(110, parsed.terminalHeight))
          : 224,
    };
  } catch {
    return { leftWidth: 288, rightWidth: 380, terminalHeight: 224 };
  }
}

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

  // Layout panels & resizable dimensions
  const [showLeftSidebar, setShowLeftSidebar] = useState(true);
  const [sidebarTab, setSidebarTab] = useState<'files' | 'search' | 'github'>('files');
  const [showRightAgent, setShowRightAgent] = useState(true);
  const [showTerminal, setShowTerminal] = useState(true);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [panelSizes, setPanelSizes] = useState<PanelSizes>(() => loadPanelSizes());
  const [resizingPanel, setResizingPanel] = useState<'left' | 'right' | 'terminal' | null>(null);

  // Search & symbol index
  const [searchQuery, setSearchQuery] = useState('');
  const [symbolsOnly, setSymbolsOnly] = useState(true);
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [allSymbols, setAllSymbols] = useState<SearchHit[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  // Agent & Diff state
  const [agentMessages, setAgentMessages] = useState<AgentMessage[]>([]);
  const [effort, setEffort] = useState<ModelEffort>('medium');
  const [agentMode, setAgentMode] = useState<AgentMode>('action');
  const [followAi, setFollowAi] = useState<boolean>(true);
  const [autopilot, setAutopilot] = useState<boolean>(false);
  const [isAgentBusy, setIsAgentBusy] = useState(false);
  const [activeDiffPatchId, setActiveDiffPatchId] = useState<string | null>(null);
  const [hydratedWorkspaceKey, setHydratedWorkspaceKey] = useState<string | null>(null);

  // Git & GitHub Source Control state
  const [gitStatus, setGitStatus] = useState<GitStatusSnapshot | null>(null);
  const [isGitLoading, setIsGitLoading] = useState(false);
  const [isGitBusy, setIsGitBusy] = useState(false);
  const [isGitFetching, setIsGitFetching] = useState(false);
  const [gitAutoFetch, setGitAutoFetch] = useState<boolean>(() => loadGitAutoFetch());
  const [lastGitFetchedAt, setLastGitFetchedAt] = useState<number | null>(null);
  const [activeGitDiff, setActiveGitDiff] = useState<GitDiffPreview | null>(null);

  const agentAbortRef = useRef<AbortController | null>(null);
  const searchAbortRef = useRef<AbortController | null>(null);
  const searchSeqRef = useRef<number>(0);
  const autoFetchLockRef = useRef(false);
  const lastAutoFetchMapRef = useRef<Map<string, number>>(new Map());
  const activeWorkspaceKeyRef = useRef<string>(
    getWorkspaceSessionKey(workspaceCtx.source, workspaceCtx.id)
  );
  useEffect(() => {
    activeWorkspaceKeyRef.current = getWorkspaceSessionKey(workspaceCtx.source, workspaceCtx.id);
  }, [workspaceCtx]);

  const followAiRef = useRef(followAi);
  useEffect(() => {
    followAiRef.current = followAi;
  }, [followAi]);

  const autopilotRef = useRef(autopilot);
  useEffect(() => {
    autopilotRef.current = autopilot;
  }, [autopilot]);

  useEffect(() => {
    try {
      localStorage.setItem(GIT_AUTOFETCH_KEY, String(gitAutoFetch));
    } catch {
      // Storage quota ignored
    }
  }, [gitAutoFetch]);

  // Home Quick Chat state (fresh session each time Home is opened)
  const [homeChatMessages, setHomeChatMessages] = useState<HomeChatMessage[]>([]);
  const [isHomeChatBusy, setIsHomeChatBusy] = useState(false);

  // Terminal state
  const [terminalEntries, setTerminalEntries] = useState<TerminalEntry[]>([]);
  const [terminalCwd, setTerminalCwd] = useState<string>('.');
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

  useEffect(() => {
    try {
      localStorage.setItem(PANEL_SIZES_KEY, JSON.stringify(panelSizes));
    } catch {
      // Storage quota ignored
    }
  }, [panelSizes]);

  const startPanelResize = useCallback(
    (panel: 'left' | 'right' | 'terminal', e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      const initial = panelSizes;
      setResizingPanel(panel);
      document.body.style.userSelect = 'none';
      document.body.style.cursor = panel === 'terminal' ? 'row-resize' : 'col-resize';

      const onMouseMove = (moveEvent: MouseEvent) => {
        if (panel === 'left') {
          const maxLeft = Math.max(260, window.innerWidth - (showRightAgent ? initial.rightWidth : 0) - 260);
          const nextWidth = Math.min(
            Math.min(560, maxLeft),
            Math.max(220, initial.leftWidth + (moveEvent.clientX - startX))
          );
          setPanelSizes((prev) => ({ ...prev, leftWidth: Math.round(nextWidth) }));
        } else if (panel === 'right') {
          const maxRight = Math.max(300, window.innerWidth - (showLeftSidebar ? initial.leftWidth : 0) - 260);
          const nextWidth = Math.min(
            Math.min(640, maxRight),
            Math.max(280, initial.rightWidth - (moveEvent.clientX - startX))
          );
          setPanelSizes((prev) => ({ ...prev, rightWidth: Math.round(nextWidth) }));
        } else {
          const maxTerminal = Math.max(160, window.innerHeight - 220);
          const nextHeight = Math.min(
            Math.min(520, maxTerminal),
            Math.max(110, initial.terminalHeight - (moveEvent.clientY - startY))
          );
          setPanelSizes((prev) => ({ ...prev, terminalHeight: Math.round(nextHeight) }));
        }
      };

      const onMouseUp = () => {
        setResizingPanel(null);
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
      };

      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    },
    [panelSizes, showLeftSidebar, showRightAgent]
  );

  const refreshGitStatus = useCallback(async (ctx: ActiveWorkspaceContext) => {
    setIsGitLoading(true);
    try {
      const snap = await fetchGitStatus(ctx);
      setGitStatus(snap);
    } catch {
      setGitStatus(null);
    } finally {
      setIsGitLoading(false);
    }
  }, []);

  const runSilentGitFetch = useCallback(async (ctx: ActiveWorkspaceContext) => {
    if (ctx.source === 'local-fs' || autoFetchLockRef.current) return;
    const key = getWorkspaceSessionKey(ctx.source, ctx.id);
    autoFetchLockRef.current = true;
    setIsGitFetching(true);
    try {
      const snap = await syncGitRemote(ctx, 'fetch');
      const now = Date.now();
      lastAutoFetchMapRef.current.set(key, now);
      if (activeWorkspaceKeyRef.current === key) {
        setGitStatus(snap);
        setLastGitFetchedAt(now);
      }
    } catch {
      // Background auto-fetch fails silently if offline or unauthenticated
    } finally {
      autoFetchLockRef.current = false;
      setIsGitFetching(false);
    }
  }, []);

  // VS Code-style automatic background git fetch (on repo open, tab switch, and every 3 minutes)
  useEffect(() => {
    if (
      view !== 'editor' ||
      !gitAutoFetch ||
      workspaceCtx.source === 'local-fs' ||
      !gitStatus?.isRepo ||
      !gitStatus?.remoteUrl
    ) {
      return;
    }

    const key = getWorkspaceSessionKey(workspaceCtx.source, workspaceCtx.id);
    const lastAt = lastAutoFetchMapRef.current.get(key) ?? 0;
    const minAgeMs = sidebarTab === 'github' ? 30_000 : 180_000;
    if (Date.now() - lastAt >= minAgeMs) {
      void runSilentGitFetch(workspaceCtx);
    }

    const interval = setInterval(() => {
      void runSilentGitFetch(workspaceCtx);
    }, 180_000);

    return () => clearInterval(interval);
  }, [
    view,
    gitAutoFetch,
    workspaceCtx,
    gitStatus?.isRepo,
    gitStatus?.remoteUrl,
    sidebarTab,
    runSilentGitFetch,
  ]);

  const refreshWorkspace = useCallback(
    async (ctx: ActiveWorkspaceContext, openFirstFile = false) => {
      try {
        const nextTree = await fetchWorkspaceTree(ctx);
        setTree(nextTree);

        const hits = await searchWorkspace(ctx, '', true, nextTree);
        setAllSymbols(hits);
        setSearchHits(hits);

        void refreshGitStatus(ctx);

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
    [showNotice, refreshGitStatus]
  );

  // Boot: load available workspaces (Home Quick Chat always starts fresh)
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

  // Persist per-workspace conversation & agent settings automatically
  useEffect(() => {
    const currentKey = getWorkspaceSessionKey(workspaceCtx.source, workspaceCtx.id);
    if (hydratedWorkspaceKey !== currentKey) return;

    const timer = setTimeout(() => {
      void saveWorkspaceSession({
        workspaceKey: currentKey,
        messages: agentMessages,
        agentMode,
        effort,
        followAi,
        autopilot,
        updatedAt: Date.now(),
      });
    }, isAgentBusy ? 400 : 80);

    return () => clearTimeout(timer);
  }, [agentMessages, agentMode, effort, followAi, autopilot, isAgentBusy, workspaceCtx, hydratedWorkspaceKey]);

  const openFile = useCallback(
    async (filePath: string, line?: number) => {
      setActiveDiffPatchId(null);
      setActiveGitDiff(null);
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
        void refreshGitStatus(workspaceCtx);
      } catch (err) {
        showNotice('error', err instanceof Error ? err.message : 'Failed to save file');
      }
    },
    [activeTabPath, tabs, workspaceCtx, searchQuery, symbolsOnly, tree, showNotice, refreshGitStatus]
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
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 'g') {
        e.preventDefault();
        setShowLeftSidebar(true);
        setSidebarTab('github');
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

  const activateWorkspace = useCallback(
    async (nextCtx: ActiveWorkspaceContext, recentEntry: RecentWorkspace) => {
      if (agentAbortRef.current) {
        agentAbortRef.current.abort();
        agentAbortRef.current = null;
        void cancelTauriAgent();
      }
      if (searchAbortRef.current) {
        searchAbortRef.current.abort();
        searchAbortRef.current = null;
      }
      searchSeqRef.current += 1;
      setIsSearching(false);
      setSearchQuery('');
      setIsAgentBusy(false);

      const sessionKey = getWorkspaceSessionKey(nextCtx.source, nextCtx.id);
      setHydratedWorkspaceKey(null);
      setWorkspaceCtx(nextCtx);
      setTerminalEntries([]);
      setTerminalCwd('.');
      setActiveDiffPatchId(null);
      setActiveGitDiff(null);
      setGitStatus(null);
      setLastGitFetchedAt(lastAutoFetchMapRef.current.get(sessionKey) ?? null);
      setView('editor');
      setRecentWorkspaces(recordRecentWorkspace(recentEntry));

      const saved = await loadWorkspaceSession(sessionKey);
      if (saved) {
        setAgentMessages(saved.messages);
        setAgentMode(saved.agentMode);
        setEffort(saved.effort);
        setFollowAi(saved.followAi);
        setAutopilot(Boolean(saved.autopilot));
      } else {
        setAgentMessages([]);
        setAutopilot(false);
      }
      setHydratedWorkspaceKey(sessionKey);

      await refreshWorkspace(nextCtx, true);
    },
    [refreshWorkspace]
  );

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
        await activateWorkspace(nextCtx, {
          id: selected,
          name: folderName,
          source: 'tauri-native',
          nativeRoot: selected,
          lastOpenedAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        });
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
      await activateWorkspace(nextCtx, {
        id: dirHandle.name,
        name: dirHandle.name,
        source: 'local-fs',
        lastOpenedAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      });
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
    await activateWorkspace(nextCtx, {
      id,
      name: nextCtx.name,
      source: 'starter',
      lastOpenedAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    });
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
        await activateWorkspace(nextCtx, {
          id: createdPath,
          name: folderName,
          source: 'tauri-native',
          nativeRoot: createdPath,
          lastOpenedAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        });
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
      await activateWorkspace(nextCtx, {
        id: created.id,
        name: created.name,
        source: 'starter',
        lastOpenedAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      });
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
        await activateWorkspace(nextCtx, {
          ...item,
          lastOpenedAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        });
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
        await activateWorkspace(nextCtx, {
          ...item,
          lastOpenedAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        });
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
      const { reply, createdProjects, sources, searchQueries } = await sendHomeChat(
        nextHistory
          .filter((m) => !m.error)
          .map((m) => ({ role: m.role, content: m.content }))
      );

      if (createdProjects.length > 0) {
        if (!isTauriRuntime()) {
          const updatedList = await listStarterWorkspaces();
          setStarters(updatedList);
        }
        const nowLabel = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        let updatedRecents = recentWorkspaces;
        for (const proj of createdProjects) {
          updatedRecents = recordRecentWorkspace(
            proj.rootPath
              ? {
                  id: proj.rootPath,
                  name: proj.name,
                  source: 'tauri-native',
                  nativeRoot: proj.rootPath,
                  lastOpenedAt: nowLabel,
                }
              : {
                  id: proj.id,
                  name: proj.name,
                  source: 'starter',
                  lastOpenedAt: nowLabel,
                }
          );
        }
        setRecentWorkspaces(updatedRecents);
      }

      setHomeChatMessages((prev) => [
        ...prev,
        {
          id: `hc-a-${Date.now()}`,
          role: 'assistant',
          content: reply,
          createdProjects: createdProjects.length > 0 ? createdProjects : undefined,
          sources: sources.length > 0 ? sources : undefined,
          searchQueries: searchQueries.length > 0 ? searchQueries : undefined,
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

  const handleOpenCreatedProject = async (proj: CreatedProjectSummary) => {
    if (proj.rootPath) {
      const nextCtx: ActiveWorkspaceContext = {
        source: 'tauri-native',
        id: proj.rootPath,
        name: proj.name,
        nativeRoot: proj.rootPath,
      };
      await activateWorkspace(nextCtx, {
        id: proj.rootPath,
        name: proj.name,
        source: 'tauri-native',
        nativeRoot: proj.rootPath,
        lastOpenedAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      });
      return;
    }
    await handleSelectStarter(proj.id);
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

    if (searchAbortRef.current) {
      searchAbortRef.current.abort();
      searchAbortRef.current = null;
    }
    const seq = ++searchSeqRef.current;

    if (symOnly && !query.trim() && allSymbols.length > 0) {
      setSearchHits(allSymbols);
      setIsSearching(false);
      return;
    }

    const controller = new AbortController();
    searchAbortRef.current = controller;
    setIsSearching(true);
    try {
      const hits = await searchWorkspace(workspaceCtx, query, symOnly, tree, controller.signal);
      if (seq === searchSeqRef.current && !controller.signal.aborted) {
        setSearchHits(hits);
      }
    } catch (err) {
      const isAbort =
        controller.signal.aborted ||
        (err instanceof DOMException && err.name === 'AbortError') ||
        (err instanceof Error && err.name === 'AbortError');
      if (!isAbort && seq === searchSeqRef.current) {
        showNotice('error', err instanceof Error ? err.message : 'Search failed');
      }
    } finally {
      if (seq === searchSeqRef.current) {
        setIsSearching(false);
      }
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
    const startCwd = terminalCwd;
    try {
      const result = await execWorkspaceCommand(workspaceCtx, command, tree, startCwd);
      setTerminalCwd(result.cwd || '.');
      setTerminalEntries((prev) => [
        ...prev,
        {
          ...result,
          cwd: startCwd,
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

  const handleCancelAgent = useCallback(() => {
    if (agentAbortRef.current) {
      agentAbortRef.current.abort();
      agentAbortRef.current = null;
    }
    void cancelTauriAgent();
  }, []);

  const handleRunAgent = async (prompt: string, overrideMode?: AgentMode) => {
    const effectiveMode = overrideMode ?? agentMode;
    const isAutopilotRun = autopilotRef.current && effectiveMode === 'action';
    const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const userMsg: AgentMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      mode: effectiveMode,
      effort,
      autopilot: isAutopilotRun,
      content: prompt,
      timestamp: timeStr,
    };
    const streamId = `asst-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const placeholderMsg: AgentMessage = {
      id: streamId,
      role: 'assistant',
      mode: effectiveMode,
      effort,
      autopilot: isAutopilotRun,
      content: '',
      thoughts: '',
      activity: [],
      timestamp: timeStr,
      isStreaming: true,
    };

    const priorHistory = agentMessages
      .filter((m) => !m.error && !m.cancelled && m.content.trim().length > 0)
      .slice(-10)
      .map((m) => ({ role: m.role, content: m.content }));

    setAgentMessages((prev) => [...prev, userMsg, placeholderMsg]);
    setIsAgentBusy(true);

    const abortController = new AbortController();
    agentAbortRef.current = abortController;

    const knownPaths = new Set(flattenFilePaths(tree));

    const upsertActivity = (prev: AgentActivityItem[], incoming: AgentActivityItem): AgentActivityItem[] => {
      const idx = prev.findIndex((a) => a.id === incoming.id);
      if (idx === -1) return [...prev, incoming];
      return prev.map((a, i) => (i === idx ? incoming : a));
    };

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
        effort,
        agentMode: effectiveMode,
        autopilot: isAutopilotRun,
        history: priorHistory,
        signal: abortController.signal,
        onEvent: (evt) => {
          if (evt.type === 'thought') {
            setAgentMessages((prev) =>
              prev.map((m) =>
                m.id === streamId ? { ...m, thoughts: `${m.thoughts ?? ''}${evt.delta}` } : m
              )
            );
          } else if (evt.type === 'activity') {
            setAgentMessages((prev) =>
              prev.map((m) =>
                m.id === streamId
                  ? { ...m, activity: upsertActivity(m.activity ?? [], evt.activity) }
                  : m
              )
            );
            if (
              followAiRef.current &&
              evt.activity.filePath &&
              knownPaths.has(evt.activity.filePath)
            ) {
              void openFile(evt.activity.filePath);
            }
          }
        },
      });

      const autoApproveNow = isAutopilotRun && result.patches.length > 0;
      const finalPatches = result.patches;

      setAgentMessages((prev) =>
        prev.map((m) =>
          m.id === streamId
            ? {
                ...m,
                content: result.summary,
                steps: result.steps,
                patches: finalPatches,
                thoughts: result.thoughts || m.thoughts,
                thinkingDurationMs: result.thinkingDurationMs,
                sources: result.sources.length > 0 ? result.sources : undefined,
                searchQueries: result.searchQueries.length > 0 ? result.searchQueries : undefined,
                isStreaming: false,
                activity: (m.activity ?? []).map((a) => ({ ...a, status: 'done' })),
                timestamp: new Date().toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                }),
              }
            : m
        )
      );

      if (autoApproveNow) {
        let appliedCount = 0;
        for (const patch of finalPatches) {
          await applySinglePatch(patch);
          appliedCount += 1;
        }
        await refreshWorkspace(workspaceCtx, false);
        showNotice('info', `Autopilot applied ${appliedCount} file change(s).`);
      } else if (finalPatches.length > 0 && followAiRef.current) {
        setActiveDiffPatchId(finalPatches[0].id);
      }
    } catch (err) {
      const isAbort =
        abortController.signal.aborted ||
        (err instanceof DOMException && err.name === 'AbortError') ||
        (err instanceof Error && (err.name === 'AbortError' || err.message === 'CANCELLED'));

      if (isAbort) {
        setAgentMessages((prev) =>
          prev.map((m) =>
            m.id === streamId
              ? {
                  ...m,
                  isStreaming: false,
                  cancelled: true,
                  content: m.content || 'Cancelled by user.',
                  activity: (m.activity ?? []).map((a) => ({ ...a, status: 'done' })),
                }
              : m
          )
        );
      } else {
        const errorText = err instanceof Error ? err.message : 'Agent request failed';
        setAgentMessages((prev) =>
          prev.map((m) =>
            m.id === streamId
              ? {
                  ...m,
                  isStreaming: false,
                  error: errorText,
                  activity: (m.activity ?? []).map((a) => ({ ...a, status: 'done' })),
                }
              : m
          )
        );
      }
    } finally {
      if (agentAbortRef.current === abortController) {
        agentAbortRef.current = null;
      }
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
      showNotice('info', `Approved and applied ${pending.length} staged file(s).`);
    } catch (err) {
      showNotice('error', err instanceof Error ? err.message : 'Failed applying patches');
    }
  };

  const handleAcceptAllPendingPatches = async () => {
    const allPending = agentMessages.flatMap((m) =>
      (m.patches ?? []).filter((p) => p.status === 'pending')
    );
    if (allPending.length === 0) return;

    try {
      for (const patch of allPending) {
        await applySinglePatch(patch);
      }
      await refreshWorkspace(workspaceCtx, false);
      showNotice('info', `Approved and applied ${allPending.length} staged file(s).`);
    } catch (err) {
      showNotice('error', err instanceof Error ? err.message : 'Failed applying staged files');
    }
  };

  const handleRejectAllPendingPatches = () => {
    const pendingIds = new Set(
      agentMessages.flatMap((m) =>
        (m.patches ?? []).filter((p) => p.status === 'pending').map((p) => p.id)
      )
    );
    if (pendingIds.size === 0) return;

    setAgentMessages((prev) =>
      prev.map((m) => ({
        ...m,
        patches: m.patches?.map((p) =>
          p.status === 'pending' ? { ...p, status: 'rejected' } : p
        ),
      }))
    );
    if (activeDiffPatchId && pendingIds.has(activeDiffPatchId)) {
      setActiveDiffPatchId(null);
    }
  };

  // GitHub & Source Control handlers
  const handleGitInitRepo = async () => {
    setIsGitBusy(true);
    try {
      const snap = await initGitRepository(workspaceCtx);
      setGitStatus(snap);
      showNotice('info', 'Initialized Git repository.');
    } catch (err) {
      showNotice('error', err instanceof Error ? err.message : 'Git init failed');
    } finally {
      setIsGitBusy(false);
    }
  };

  const handleGitStage = async (paths: string[], all = false) => {
    setIsGitBusy(true);
    try {
      const snap = await stageGitFiles(workspaceCtx, paths, all);
      setGitStatus(snap);
      if (activeGitDiff && (all || paths.includes(activeGitDiff.path))) {
        const entry = snap.staged.find((e) => e.path === activeGitDiff.path);
        if (entry) {
          const updated = await fetchGitFileDiff(workspaceCtx, entry.path, true, entry.status);
          setActiveGitDiff(updated);
        } else {
          setActiveGitDiff(null);
        }
      }
    } catch (err) {
      showNotice('error', err instanceof Error ? err.message : 'Failed to stage changes');
    } finally {
      setIsGitBusy(false);
    }
  };

  const handleGitUnstage = async (paths: string[], all = false) => {
    setIsGitBusy(true);
    try {
      const snap = await unstageGitFiles(workspaceCtx, paths, all);
      setGitStatus(snap);
      if (activeGitDiff && (all || paths.includes(activeGitDiff.path))) {
        const entry = snap.changes.find((e) => e.path === activeGitDiff.path);
        if (entry) {
          const updated = await fetchGitFileDiff(workspaceCtx, entry.path, false, entry.status);
          setActiveGitDiff(updated);
        } else {
          setActiveGitDiff(null);
        }
      }
    } catch (err) {
      showNotice('error', err instanceof Error ? err.message : 'Failed to unstage changes');
    } finally {
      setIsGitBusy(false);
    }
  };

  const handleGitDiscard = async (relPath: string, untracked: boolean) => {
    setIsGitBusy(true);
    try {
      const snap = await discardGitChange(workspaceCtx, relPath, untracked);
      setGitStatus(snap);
      if (activeGitDiff?.path === relPath) {
        setActiveGitDiff(null);
      }
      await refreshWorkspace(workspaceCtx, false);
      // Reload open tab from disk if it was reverted
      const openTab = tabs.find((t) => t.path === relPath);
      if (openTab) {
        if (untracked) {
          setTabs((prev) => prev.filter((t) => t.path !== relPath));
          if (activeTabPath === relPath) setActiveTabPath(null);
        } else {
          try {
            const diskContent = await readWorkspaceFile(workspaceCtx, relPath);
            setTabs((prev) =>
              prev.map((t) =>
                t.path === relPath
                  ? { ...t, content: diskContent, savedContent: diskContent, isDirty: false }
                  : t
              )
            );
          } catch {
            // File may have been newly added and removed
          }
        }
      }
    } catch (err) {
      showNotice('error', err instanceof Error ? err.message : 'Failed to discard changes');
    } finally {
      setIsGitBusy(false);
    }
  };

  const handleGitCommit = async (params: {
    message: string;
    stageAllIfEmpty?: boolean;
    userName?: string;
    userEmail?: string;
  }): Promise<boolean> => {
    setIsGitBusy(true);
    try {
      const snap = await commitGitChanges(workspaceCtx, params);
      setGitStatus(snap);
      setActiveGitDiff(null);
      showNotice('info', 'Committed changes to local branch.');
      return true;
    } catch (err) {
      showNotice('error', err instanceof Error ? err.message : 'Commit failed');
      return false;
    } finally {
      setIsGitBusy(false);
    }
  };

  const handleGitGenerateCommitMessage = async (): Promise<string> => {
    try {
      return await generateGitCommitMessage(workspaceCtx);
    } catch (err) {
      showNotice('error', err instanceof Error ? err.message : 'Could not generate commit message');
      return '';
    }
  };

  const handleGitBranchAction = async (action: 'checkout' | 'create', name: string) => {
    setIsGitBusy(true);
    try {
      const snap = await runGitBranchAction(workspaceCtx, action, name);
      setGitStatus(snap);
      setActiveGitDiff(null);
      await refreshWorkspace(workspaceCtx, false);
      showNotice('info', `Switched to branch ${snap.branch}`);
    } catch (err) {
      showNotice('error', err instanceof Error ? err.message : 'Branch switch failed');
    } finally {
      setIsGitBusy(false);
    }
  };

  const handleGitSetRemote = async (url: string) => {
    setIsGitBusy(true);
    try {
      const snap = await setGitRemoteOrigin(workspaceCtx, url);
      setGitStatus(snap);
      showNotice('info', 'Updated origin remote URL.');
    } catch (err) {
      showNotice('error', err instanceof Error ? err.message : 'Failed to set remote');
    } finally {
      setIsGitBusy(false);
    }
  };

  const handleGitSync = async (action: 'fetch' | 'pull' | 'push' | 'sync') => {
    setIsGitBusy(true);
    if (action === 'fetch') setIsGitFetching(true);
    try {
      const snap = await syncGitRemote(workspaceCtx, action);
      setGitStatus(snap);
      if (action === 'fetch') {
        const now = Date.now();
        const key = getWorkspaceSessionKey(workspaceCtx.source, workspaceCtx.id);
        lastAutoFetchMapRef.current.set(key, now);
        setLastGitFetchedAt(now);
      }
      await refreshWorkspace(workspaceCtx, false);
      const actionLabel =
        action === 'fetch'
          ? snap.behind > 0
            ? `Fetched from GitHub (${snap.behind} incoming commit${snap.behind === 1 ? '' : 's'})`
            : 'Fetched from GitHub — up to date'
          : action === 'pull'
            ? 'Pulled from GitHub'
            : action === 'push'
              ? 'Pushed commits to GitHub'
              : 'Synced with GitHub';
      showNotice('info', actionLabel);
    } catch (err) {
      showNotice('error', err instanceof Error ? err.message : `Git ${action} failed`);
    } finally {
      setIsGitBusy(false);
      if (action === 'fetch') setIsGitFetching(false);
    }
  };

  const handleOpenGitDiff = async (entry: GitFileEntry) => {
    try {
      const preview = await fetchGitFileDiff(
        workspaceCtx,
        entry.path,
        entry.staged,
        entry.status
      );
      setActiveDiffPatchId(null);
      setActiveGitDiff(preview);
    } catch (err) {
      showNotice('error', err instanceof Error ? err.message : 'Failed to load diff');
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
          onGoHome={() => {
            setHomeChatMessages([]);
            setView('home');
          }}
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
            onOpenCreatedProject={(proj) => void handleOpenCreatedProject(proj)}
            onSendChat={handleSendHomeChat}
            onClearChat={() => setHomeChatMessages([])}
          />
        </main>
      ) : (
      <>
      {/* Main 3-column workbench with resizable panels */}
      <main className="flex flex-1 min-h-0 overflow-hidden">
        {showLeftSidebar && (
          <>
            <ExplorerSidebar
              width={panelSizes.leftWidth}
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
              workspaceSource={workspaceCtx.source}
              gitStatus={gitStatus}
              isGitLoading={isGitLoading}
              isGitBusy={isGitBusy}
              isGitFetching={isGitFetching}
              gitAutoFetch={gitAutoFetch}
              lastGitFetchedAt={lastGitFetchedAt}
              onToggleGitAutoFetch={() => setGitAutoFetch((prev) => !prev)}
              onGitRefresh={() => refreshGitStatus(workspaceCtx)}
              onGitInitRepo={handleGitInitRepo}
              onGitStage={handleGitStage}
              onGitUnstage={handleGitUnstage}
              onGitDiscard={handleGitDiscard}
              onGitCommit={handleGitCommit}
              onGitGenerateCommitMessage={handleGitGenerateCommitMessage}
              onGitBranchAction={handleGitBranchAction}
              onGitSetRemote={handleGitSetRemote}
              onGitSync={handleGitSync}
              onOpenGitDiff={(entry) => void handleOpenGitDiff(entry)}
            />
            <div
              role="separator"
              aria-orientation="vertical"
              onMouseDown={(e) => startPanelResize('left', e)}
              className={`w-1 shrink-0 cursor-col-resize transition-colors ${
                resizingPanel === 'left'
                  ? 'bg-[#6366F1]'
                  : 'bg-transparent hover:bg-[#6366F1]/70'
              }`}
            />
          </>
        )}

        {/* Center Editor + Diff + Bottom Terminal */}
        <div className="flex flex-1 flex-col min-w-0 min-h-0 overflow-hidden">
          {/* Tab bar */}
          <div className="flex h-9 shrink-0 items-center justify-between border-b border-[#272B38] bg-[#161922] px-1 select-none">
            <div className="tab-strip flex h-full min-w-0 flex-1 items-stretch overflow-x-auto overflow-y-hidden">
              {tabs.map((tab) => {
                const isActive = !activeDiffPatch && !activeGitDiff && tab.path === activeTabPath;
                return (
                  <div
                    key={tab.path}
                    onClick={() => {
                      setActiveDiffPatchId(null);
                      setActiveGitDiff(null);
                      setActiveTabPath(tab.path);
                    }}
                    className={`group flex h-full cursor-pointer items-center gap-2 border-r border-[#272B38] px-3 text-[12px] transition-colors whitespace-nowrap shrink-0 ${
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
                <div className="flex h-full items-center gap-2 border-r border-[#272B38] bg-[#0F1117] px-3 text-[12px] text-[#818CF8] whitespace-nowrap shrink-0">
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

              {activeGitDiff && !activeDiffPatch && (
                <div className="flex h-full items-center gap-2 border-r border-[#272B38] bg-[#0F1117] px-3 text-[12px] text-[#818CF8] whitespace-nowrap shrink-0">
                  <span className="font-mono">Git Diff: {activeGitDiff.path}</span>
                  <button
                    type="button"
                    aria-label="Close git diff view"
                    onClick={() => setActiveGitDiff(null)}
                    className="rounded p-0.5 text-[#8B92A5] hover:bg-[#272B38] hover:text-[#E6E8EE]"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              )}
            </div>

            <div className="flex items-center gap-3 px-3 text-[11.5px] text-[#8B92A5] shrink-0">
              {isAgentBusy && followAi && (
                <span className="flex items-center gap-1 text-[11px] font-medium text-[#818CF8]">
                  <Eye className="h-3 w-3" />
                  <span className="hidden sm:inline">Following AI</span>
                </span>
              )}
              {activeTab && !activeDiffPatch && !activeGitDiff && (
                <>
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
                </>
              )}
            </div>
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
            ) : activeGitDiff ? (
              <DiffViewer
                gitDiff={activeGitDiff}
                onOpenFile={(p) => void openFile(p)}
                onStageGit={(p) => void handleGitStage([p], false)}
                onUnstageGit={(p) => void handleGitUnstage([p], false)}
                onDiscardGit={(p, untracked) => void handleGitDiscard(p, untracked)}
                onClose={() => setActiveGitDiff(null)}
              />
            ) : activeTab ? (
              <CodeEditor
                filePath={activeTab.path}
                value={activeTab.content}
                targetLine={
                  jumpTarget && jumpTarget.path === activeTab.path ? jumpTarget.line : null
                }
                workspaceSymbols={allSymbols}
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
            <>
              <div
                role="separator"
                aria-orientation="horizontal"
                onMouseDown={(e) => startPanelResize('terminal', e)}
                className={`h-1 shrink-0 cursor-row-resize transition-colors ${
                  resizingPanel === 'terminal'
                    ? 'bg-[#6366F1]'
                    : 'bg-transparent hover:bg-[#6366F1]/70'
                }`}
              />
              <TerminalDrawer
                height={panelSizes.terminalHeight}
                workspaceName={workspaceCtx.name}
                cwd={terminalCwd}
                entries={terminalEntries}
                isRunning={isTerminalRunning}
                onExecute={handleExecuteCommand}
                onClear={() => setTerminalEntries([])}
                onClose={() => setShowTerminal(false)}
              />
            </>
          )}
        </div>

        {showRightAgent && (
          <>
            <div
              role="separator"
              aria-orientation="vertical"
              onMouseDown={(e) => startPanelResize('right', e)}
              className={`w-1 shrink-0 cursor-col-resize transition-colors ${
                resizingPanel === 'right'
                  ? 'bg-[#6366F1]'
                  : 'bg-transparent hover:bg-[#6366F1]/70'
              }`}
            />
            <AgentPanel
              width={panelSizes.rightWidth}
              messages={agentMessages}
              activeFilePath={activeTabPath}
              workspaceFileCount={allFilePaths.length}
              effort={effort}
              agentMode={agentMode}
              followAi={followAi}
              autopilot={autopilot}
              isBusy={isAgentBusy}
              onEffortChange={setEffort}
              onAgentModeChange={setAgentMode}
              onFollowAiChange={setFollowAi}
              onAutopilotChange={setAutopilot}
              onSendPrompt={handleRunAgent}
              onCancelPrompt={handleCancelAgent}
              onOpenFile={(p) => void openFile(p)}
              onInspectPatch={(patch) => {
                setActiveGitDiff(null);
                setActiveDiffPatchId(patch.id);
              }}
              onAcceptPatch={handleAcceptPatch}
              onRejectPatch={handleRejectPatch}
              onAcceptAll={handleAcceptAllPatches}
              onAcceptAllPending={handleAcceptAllPendingPatches}
              onRejectAllPending={handleRejectAllPendingPatches}
              onClearHistory={() => {
                setAgentMessages([]);
                setActiveDiffPatchId(null);
                void clearWorkspaceSessionMessages(
                  getWorkspaceSessionKey(workspaceCtx.source, workspaceCtx.id)
                );
              }}
            />
          </>
        )}
      </main>
      <footer className="flex h-6 shrink-0 items-center justify-between border-t border-[#272B38] bg-[#161922] px-3 text-[11px] leading-none text-[#8B92A5] select-none">
        <div className="flex items-center gap-2 truncate font-mono">
          <span className="truncate text-[#B5BBC9]">{workspaceCtx.name}</span>
          {gitStatus?.isRepo && gitStatus.branch && (
            <>
              <span className="text-[#52596E]" aria-hidden="true">
                ·
              </span>
              <span className="text-[#818CF8]">{gitStatus.branch}</span>
            </>
          )}
        </div>
        <div className="shrink-0 font-mono text-[11px] leading-none">
          Created with{' '}
          <span aria-label="love" className="inline-block text-[9.5px] leading-none">
            ❤️
          </span>{' '}
          by <span className="text-[#C7D2FE]">Oishik Guha</span>
        </div>
      </footer>
      </>
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

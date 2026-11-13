export type WorkspaceSource = 'starter' | 'local-fs' | 'tauri-native';

export interface FileNode {
  name: string;
  path: string;
  kind: 'file' | 'dir';
  children?: FileNode[];
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  description: string;
  language: string;
  rootPath?: string;
}

export interface SearchHit {
  filePath: string;
  line: number;
  preview: string;
  symbolKind?: string | null;
  symbolName?: string | null;
}

export interface EditorTab {
  path: string;
  name: string;
  content: string;
  savedContent: string;
  isDirty: boolean;
}

export interface CursorPosition {
  line: number;
  col: number;
}

export type PatchAction = 'create' | 'modify' | 'delete';
export type PatchStatus = 'pending' | 'accepted' | 'rejected';

export interface AgentPatch {
  id: string;
  path: string;
  action: PatchAction;
  rationale: string;
  content: string;
  originalContent: string;
  status: PatchStatus;
}

export type ModelEffort = 'low' | 'medium' | 'high' | 'xhigh';
export type AgentMode = 'plan' | 'action';

export interface AgentActivityItem {
  id: string;
  kind: 'read' | 'think' | 'edit' | 'plan' | 'done';
  label: string;
  filePath?: string;
  status: 'running' | 'done';
}

export interface AgentMessage {
  id: string;
  role: 'user' | 'assistant';
  mode?: AgentMode;
  effort?: ModelEffort;
  content: string;
  thoughts?: string;
  thinkingDurationMs?: number;
  activity?: AgentActivityItem[];
  steps?: string[];
  patches?: AgentPatch[];
  timestamp: string;
  error?: string;
  isStreaming?: boolean;
  cancelled?: boolean;
}

export interface TerminalEntry {
  id: string;
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  cwd: string;
  timestamp: string;
}

export interface RecentWorkspace {
  id: string;
  name: string;
  source: WorkspaceSource;
  nativeRoot?: string;
  lastOpenedAt: string;
}

export interface HomeChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  error?: string;
}

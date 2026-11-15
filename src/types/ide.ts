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

export interface GroundingSource {
  title: string;
  uri: string;
}

export interface AgentActivityItem {
  id: string;
  kind: 'read' | 'think' | 'edit' | 'plan' | 'done' | 'search';
  label: string;
  filePath?: string;
  status: 'running' | 'done';
}

export interface AgentMessage {
  id: string;
  role: 'user' | 'assistant';
  mode?: AgentMode;
  effort?: ModelEffort;
  autopilot?: boolean;
  content: string;
  thoughts?: string;
  thinkingDurationMs?: number;
  activity?: AgentActivityItem[];
  steps?: string[];
  patches?: AgentPatch[];
  sources?: GroundingSource[];
  searchQueries?: string[];
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

export interface CreatedProjectSummary {
  id: string;
  name: string;
  description: string;
  language: string;
  rootPath?: string;
}

export interface HomeChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  createdProjects?: CreatedProjectSummary[];
  sources?: GroundingSource[];
  searchQueries?: string[];
  error?: string;
}

export type GitFileChangeStatus = 'M' | 'A' | 'D' | 'R' | 'U' | 'C';

export type ExplorerGitBadge =
  | GitFileChangeStatus
  | 'unpushed'
  | 'pushed';

export interface GitFileEntry {
  path: string;
  status: GitFileChangeStatus;
  staged: boolean;
}

export interface GitCommitInfo {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  relativeTime: string;
  pushed: boolean;
}

export interface GitStatusSnapshot {
  isRepo: boolean;
  branch: string;
  branches: string[];
  remoteUrl: string | null;
  ahead: number;
  behind: number;
  hasUpstream: boolean;
  staged: GitFileEntry[];
  changes: GitFileEntry[];
  unpushedFiles: string[];
  pushedFiles: string[];
  commits: GitCommitInfo[];
  userName: string | null;
  userEmail: string | null;
  ghAvailable: boolean;
}

export interface GitDiffPreview {
  path: string;
  status: GitFileChangeStatus;
  staged: boolean;
  originalContent: string;
  modifiedContent: string;
}

export type AiProviderType = 'gemini' | 'openai-compatible';

export interface AiProviderSettings {
  provider: AiProviderType;
  geminiModel: string;
  openaiBaseUrl: string;
  openaiModel: string;
  enableWebSearch: boolean;
}

export interface ServerAiStatus {
  geminiConfigured: boolean;
  openaiCompatConfigured: boolean;
  defaultOpenaiBaseUrl: string;
  defaultOpenaiModel: string;
  mcpEndpointPath: string;
}

export type McpTransportType = 'builtin' | 'stdio' | 'http';

export interface McpServerConfig {
  id: string;
  name: string;
  transport: McpTransportType;
  enabled: boolean;
  description?: string;
  command?: string;
  args?: string[];
  url?: string;
}

export interface McpToolInfo {
  serverId: string;
  serverName: string;
  name: string;
  qualifiedName: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpResourceInfo {
  serverId: string;
  serverName: string;
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface McpPromptInfo {
  serverId: string;
  serverName: string;
  name: string;
  description?: string;
  arguments?: McpPromptArgument[];
}

export interface McpServerSnapshot extends McpServerConfig {
  status: 'connected' | 'disabled' | 'error';
  error?: string;
  protocolVersion?: string;
  tools: McpToolInfo[];
  resources: McpResourceInfo[];
  prompts: McpPromptInfo[];
}

export interface PinnedContextItem {
  id: string;
  kind: 'file' | 'mcp-resource';
  label: string;
  path?: string;
  serverId?: string;
  uri?: string;
  description?: string;
}



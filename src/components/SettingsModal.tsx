import React, { useEffect, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Cpu,
  Database,
  Eye,
  Globe,
  Loader2,
  Plus,
  RefreshCw,
  Server,
  Terminal,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import {
  AiProviderSettings,
  McpServerSnapshot,
  McpTransportType,
  ServerAiStatus,
} from '../types/ide';
import {
  deleteMcpServer,
  fetchMcpServers,
  fetchOpenAiModels,
  fetchServerAiStatus,
  readMcpResourcePreview,
  saveMcpServer,
  testAiProviderConnection,
  toggleMcpServer,
} from '../services/transport';

interface SettingsModalProps {
  open: boolean;
  initialTab?: 'providers' | 'mcp';
  settings: AiProviderSettings;
  mcpServers: McpServerSnapshot[];
  activeWorkspaceId?: string;
  onChangeSettings: (next: AiProviderSettings) => void;
  onMcpServersChange: (servers: McpServerSnapshot[]) => void;
  onClose: () => void;
}

const GEMINI_MODELS = [
  {
    id: 'gemini-4-hydrogen',
    label: 'gemini-4-hydrogen',
    note: 'Flagship multi-file reasoning, coding, and tool execution',
  },
  {
    id: 'gemini-3.1-flash-lite',
    label: 'gemini-3.1-flash-lite',
    note: 'High-speed, low-latency responses for quick iterations',
  },
];

const OPENAI_PRESETS = [
  { label: 'OpenAI', url: 'https://api.openai.com/v1', model: 'gpt-4o' },
  { label: 'OpenRouter', url: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-3.7-sonnet' },
  { label: 'DeepSeek', url: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { label: 'Groq', url: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
  { label: 'Ollama (Local)', url: 'http://localhost:11434/v1', model: 'qwen2.5-coder:14b' },
  { label: 'LM Studio (Local)', url: 'http://localhost:1234/v1', model: 'local-model' },
];

export const SettingsModal: React.FC<SettingsModalProps> = ({
  open,
  initialTab = 'providers',
  settings,
  mcpServers,
  activeWorkspaceId,
  onChangeSettings,
  onMcpServersChange,
  onClose,
}) => {
  const [tab, setTab] = useState<'providers' | 'mcp'>(initialTab);
  const [serverStatus, setServerStatus] = useState<ServerAiStatus | null>(null);

  // Provider test & model discovery state
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    tone: 'ok' | 'error';
    message: string;
  } | null>(null);
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [discoveredModels, setDiscoveredModels] = useState<string[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);

  // MCP management state
  const [isRefreshingMcp, setIsRefreshingMcp] = useState(false);
  const [expandedServerId, setExpandedServerId] = useState<string | null>('builtin-workspace');
  const [addingServer, setAddingServer] = useState(false);
  const [newServerName, setNewServerName] = useState('');
  const [newTransport, setNewTransport] = useState<McpTransportType>('http');
  const [newUrl, setNewUrl] = useState('');
  const [newCommand, setNewCommand] = useState('');
  const [newArgs, setNewArgs] = useState('');
  const [mcpError, setMcpError] = useState<string | null>(null);
  const [isSavingMcp, setIsSavingMcp] = useState(false);
  const [copiedEndpoint, setCopiedEndpoint] = useState(false);
  const [resourcePreview, setResourcePreview] = useState<{
    uri: string;
    text: string;
    loading: boolean;
  } | null>(null);

  useEffect(() => {
    if (open) {
      setTab(initialTab);
      setTestResult(null);
      setModelsError(null);
      setMcpError(null);
      void fetchServerAiStatus()
        .then((st) => setServerStatus(st))
        .catch(() => {});
      void fetchMcpServers().then((list) => {
        if (list.length > 0) onMcpServersChange(list);
      });
    }
  }, [open, initialTab, onMcpServersChange]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const handleTestConnection = async () => {
    setIsTesting(true);
    setTestResult(null);
    try {
      const res = await testAiProviderConnection(settings);
      setTestResult({
        tone: 'ok',
        message: `Connected (${res.latencyMs}ms) — "${res.replyPreview}"`,
      });
    } catch (err) {
      setTestResult({
        tone: 'error',
        message: err instanceof Error ? err.message : 'Connection test failed',
      });
    } finally {
      setIsTesting(false);
    }
  };

  const handleFetchModels = async () => {
    setIsFetchingModels(true);
    setModelsError(null);
    try {
      const list = await fetchOpenAiModels(settings.openaiBaseUrl);
      setDiscoveredModels(list);
      if (list.length === 0) {
        setModelsError('Endpoint returned an empty models list.');
      }
    } catch (err) {
      setModelsError(err instanceof Error ? err.message : 'Could not list models');
    } finally {
      setIsFetchingModels(false);
    }
  };

  const handleRefreshMcp = async () => {
    setIsRefreshingMcp(true);
    setMcpError(null);
    try {
      const next = await fetchMcpServers();
      onMcpServersChange(next);
    } catch (err) {
      setMcpError(err instanceof Error ? err.message : 'Failed to refresh MCP servers');
    } finally {
      setIsRefreshingMcp(false);
    }
  };

  const handleToggleMcp = async (id: string, enabled: boolean) => {
    setMcpError(null);
    try {
      const next = await toggleMcpServer(id, enabled);
      onMcpServersChange(next);
    } catch (err) {
      setMcpError(err instanceof Error ? err.message : 'Failed to update server');
    }
  };

  const handleDeleteMcp = async (id: string) => {
    setMcpError(null);
    try {
      const next = await deleteMcpServer(id);
      onMcpServersChange(next);
    } catch (err) {
      setMcpError(err instanceof Error ? err.message : 'Failed to remove server');
    }
  };

  const handleAddMcpServer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newServerName.trim() || isSavingMcp) return;
    setIsSavingMcp(true);
    setMcpError(null);
    try {
      const parsedArgs = newArgs
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      const next = await saveMcpServer({
        name: newServerName.trim(),
        transport: newTransport,
        enabled: true,
        url: newTransport === 'http' ? newUrl.trim() : undefined,
        command: newTransport === 'stdio' ? newCommand.trim() : undefined,
        args: newTransport === 'stdio' ? parsedArgs : undefined,
      });
      onMcpServersChange(next);
      setAddingServer(false);
      setNewServerName('');
      setNewUrl('');
      setNewCommand('');
      setNewArgs('');
    } catch (err) {
      setMcpError(err instanceof Error ? err.message : 'Failed to add MCP server');
    } finally {
      setIsSavingMcp(false);
    }
  };

  const handlePreviewResource = async (serverId: string, uri: string) => {
    setResourcePreview({ uri, text: '', loading: true });
    try {
      const res = await readMcpResourcePreview({
        serverId,
        uri,
        workspaceId: activeWorkspaceId,
      });
      setResourcePreview({ uri, text: res.text, loading: false });
    } catch (err) {
      setResourcePreview({
        uri,
        text: err instanceof Error ? err.message : 'Unable to read resource',
        loading: false,
      });
    }
  };

  const fullMcpEndpointUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}${serverStatus?.mcpEndpointPath ?? '/api/mcp'}`
      : '/api/mcp';

  const copyMcpUrl = async () => {
    try {
      await navigator.clipboard.writeText(fullMcpEndpointUrl);
      setCopiedEndpoint(true);
      setTimeout(() => setCopiedEndpoint(false), 2000);
    } catch {
      // Clipboard unavailable
    }
  };

  const connectedToolsCount = mcpServers
    .filter((s) => s.status === 'connected')
    .reduce((acc, s) => acc + s.tools.length, 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 backdrop-blur-[2px]">
      <div
        className="fixed inset-0"
        onClick={onClose}
        aria-hidden="true"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="Aetheris Settings"
        className="relative z-10 flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-[#272B38] bg-[#161922] text-[#E6E8EE] shadow-2xl"
      >
        {/* Modal Header */}
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-[#272B38] px-4">
          <div className="flex items-center gap-4">
            <h2 className="text-[14px] font-semibold text-[#E6E8EE]">Settings</h2>

            <div className="flex items-center rounded-md bg-[#0F1117] p-0.5">
              <button
                type="button"
                onClick={() => setTab('providers')}
                className={`flex items-center gap-1.5 rounded px-3 py-1 text-[12px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                  tab === 'providers'
                    ? 'bg-[#6366F1]/25 text-[#818CF8]'
                    : 'text-[#8B92A5] hover:text-[#E6E8EE]'
                }`}
              >
                <Cpu className="h-3.5 w-3.5" />
                <span>AI Providers</span>
              </button>
              <button
                type="button"
                onClick={() => setTab('mcp')}
                className={`flex items-center gap-1.5 rounded px-3 py-1 text-[12px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                  tab === 'mcp'
                    ? 'bg-[#6366F1]/25 text-[#818CF8]'
                    : 'text-[#8B92A5] hover:text-[#E6E8EE]'
                }`}
              >
                <Server className="h-3.5 w-3.5" />
                <span>Model Context Protocol</span>
                <span className="font-mono text-[11px] tabular-nums text-[#8B92A5]">
                  ({connectedToolsCount})
                </span>
              </button>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close Settings"
            className="rounded-md p-1.5 text-[#8B92A5] hover:bg-[#1E222E] hover:text-[#E6E8EE] transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {tab === 'providers' ? (
            <>
              {/* Active Provider Switcher */}
              <div className="space-y-2">
                <label className="block text-[12px] font-semibold text-[#E6E8EE]">
                  Active AI Provider
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <button
                    type="button"
                    onClick={() => {
                      setTestResult(null);
                      onChangeSettings({ ...settings, provider: 'gemini' });
                    }}
                    className={`flex flex-col items-start gap-1 rounded-md border p-3.5 text-left transition-colors ${
                      settings.provider === 'gemini'
                        ? 'border-[#6366F1] bg-[#6366F1]/12'
                        : 'border-[#272B38] bg-[#0F1117] hover:border-[#3A4054]'
                    }`}
                  >
                    <div className="flex w-full items-center justify-between">
                      <span className="text-[13px] font-semibold text-[#E6E8EE]">
                        Google Gemini
                      </span>
                      <span
                        className={`font-mono text-[11px] ${
                          serverStatus?.geminiConfigured ? 'text-emerald-400' : 'text-amber-400'
                        }`}
                      >
                        {serverStatus?.geminiConfigured ? 'Ready' : 'Env Required'}
                      </span>
                    </div>
                    <p className="text-[11.5px] text-[#8B92A5]">
                      Native reasoning stream, Google Search grounding, and MCP tool calling.
                    </p>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setTestResult(null);
                      onChangeSettings({ ...settings, provider: 'openai-compatible' });
                    }}
                    className={`flex flex-col items-start gap-1 rounded-md border p-3.5 text-left transition-colors ${
                      settings.provider === 'openai-compatible'
                        ? 'border-[#6366F1] bg-[#6366F1]/12'
                        : 'border-[#272B38] bg-[#0F1117] hover:border-[#3A4054]'
                    }`}
                  >
                    <div className="flex w-full items-center justify-between">
                      <span className="text-[13px] font-semibold text-[#E6E8EE]">
                        OpenAI-Compatible API
                      </span>
                      <span
                        className={`font-mono text-[11px] ${
                          serverStatus?.openaiCompatConfigured ||
                          /^https?:\/\/(localhost|127\.0\.0\.1)/i.test(settings.openaiBaseUrl)
                            ? 'text-emerald-400'
                            : 'text-amber-400'
                        }`}
                      >
                        {serverStatus?.openaiCompatConfigured
                          ? 'Key Loaded'
                          : /^https?:\/\/(localhost|127\.0\.0\.1)/i.test(settings.openaiBaseUrl)
                            ? 'Local URL'
                            : 'Secret Env'}
                      </span>
                    </div>
                    <p className="text-[11.5px] text-[#8B92A5]">
                      Connect OpenAI, OpenRouter, DeepSeek, Groq, Ollama, or vLLM with web search.
                    </p>
                  </button>
                </div>
              </div>

              {/* Provider-Specific Configuration */}
              {settings.provider === 'gemini' ? (
                <div className="space-y-3 rounded-md border border-[#272B38] bg-[#0F1117] p-4">
                  <div className="flex items-center justify-between">
                    <span className="text-[12.5px] font-semibold text-[#E6E8EE]">
                      Gemini Model Configuration
                    </span>
                    <span className="font-mono text-[11px] text-[#8B92A5]">
                      GEMINI_API_KEY ({serverStatus?.geminiConfigured ? 'configured on server' : 'not detected'})
                    </span>
                  </div>

                  <div className="space-y-1.5">
                    {GEMINI_MODELS.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => onChangeSettings({ ...settings, geminiModel: m.id })}
                        className={`flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2.5 text-left transition-colors ${
                          settings.geminiModel === m.id
                            ? 'border-[#6366F1] bg-[#161922]'
                            : 'border-[#272B38] bg-[#161922]/50 hover:border-[#3A4054]'
                        }`}
                      >
                        <div className="min-w-0">
                          <div className="font-mono text-[12.5px] font-medium text-[#E6E8EE]">
                            {m.label}
                          </div>
                          <div className="text-[11.5px] text-[#8B92A5]">{m.note}</div>
                        </div>
                        {settings.geminiModel === m.id && (
                          <Check className="h-4 w-4 shrink-0 text-[#818CF8]" />
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="space-y-4 rounded-md border border-[#272B38] bg-[#0F1117] p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[12.5px] font-semibold text-[#E6E8EE]">
                      OpenAI-Compatible Endpoint
                    </span>
                    <span className="font-mono text-[11px] text-[#8B92A5]">
                      Auth: server env OPENAI_COMPAT_API_KEY ({serverStatus?.openaiCompatConfigured ? 'loaded' : 'unset'})
                    </span>
                  </div>

                  {/* Quick Endpoint Presets */}
                  <div className="space-y-1.5">
                    <span className="block text-[11.5px] text-[#8B92A5]">Quick Presets</span>
                    <div className="flex flex-wrap gap-1.5">
                      {OPENAI_PRESETS.map((preset) => (
                        <button
                          key={preset.label}
                          type="button"
                          onClick={() => {
                            setDiscoveredModels([]);
                            onChangeSettings({
                              ...settings,
                              openaiBaseUrl: preset.url,
                              openaiModel: preset.model,
                            });
                          }}
                          className={`rounded border px-2.5 py-1 text-[11.5px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                            settings.openaiBaseUrl === preset.url
                              ? 'border-[#6366F1] bg-[#6366F1]/15 text-[#C7D2FE]'
                              : 'border-[#272B38] bg-[#161922] text-[#8B92A5] hover:text-[#E6E8EE]'
                          }`}
                        >
                          {preset.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Base URL */}
                  <div className="space-y-1.5">
                    <label
                      htmlFor="openai-base-url"
                      className="block text-[12px] font-medium text-[#E6E8EE]"
                    >
                      API Base URL
                    </label>
                    <input
                      id="openai-base-url"
                      type="url"
                      value={settings.openaiBaseUrl}
                      onChange={(e) =>
                        onChangeSettings({ ...settings, openaiBaseUrl: e.target.value })
                      }
                      placeholder="https://api.openai.com/v1"
                      className="w-full rounded-md border border-[#272B38] bg-[#161922] px-3 py-2 font-mono text-[12.5px] text-[#E6E8EE] placeholder-[#52596E] focus:border-[#6366F1] focus:outline-none"
                    />
                    <p className="text-[11px] text-[#8B92A5]">
                      Accepts any OpenAI v1 base URL (requests are sent to{' '}
                      <code className="font-mono text-[#B5BBC9]">/chat/completions</code> via server
                      proxy). Configure <code className="font-mono text-[#B5BBC9]">OPENAI_COMPAT_API_KEY</code> in
                      Secrets or server environment for hosted providers.
                    </p>
                  </div>

                  {/* Model ID + Fetch Models */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <label
                        htmlFor="openai-model-id"
                        className="block text-[12px] font-medium text-[#E6E8EE]"
                      >
                        Model Identifier
                      </label>
                      <button
                        type="button"
                        disabled={isFetchingModels || !settings.openaiBaseUrl.trim()}
                        onClick={() => void handleFetchModels()}
                        className="flex items-center gap-1 rounded border border-[#272B38] bg-[#161922] px-2 py-0.5 text-[11px] text-[#B5BBC9] hover:border-[#6366F1]/60 hover:text-white disabled:opacity-40 transition-colors whitespace-nowrap shrink-0"
                      >
                        {isFetchingModels ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <RefreshCw className="h-3 w-3" />
                        )}
                        <span>Fetch Models</span>
                      </button>
                    </div>

                    <input
                      id="openai-model-id"
                      type="text"
                      value={settings.openaiModel}
                      onChange={(e) =>
                        onChangeSettings({ ...settings, openaiModel: e.target.value })
                      }
                      placeholder="gpt-4o"
                      className="w-full rounded-md border border-[#272B38] bg-[#161922] px-3 py-2 font-mono text-[12.5px] text-[#E6E8EE] placeholder-[#52596E] focus:border-[#6366F1] focus:outline-none"
                    />

                    {modelsError && (
                      <p className="text-[11.5px] text-amber-300">{modelsError}</p>
                    )}

                    {discoveredModels.length > 0 && (
                      <div className="max-h-28 overflow-y-auto rounded border border-[#272B38] bg-[#161922] p-1.5">
                        <div className="mb-1 px-1 text-[10.5px] text-[#8B92A5] tabular-nums">
                          Available models ({discoveredModels.length}) — click to select:
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {discoveredModels.map((mId) => (
                            <button
                              key={mId}
                              type="button"
                              onClick={() =>
                                onChangeSettings({ ...settings, openaiModel: mId })
                              }
                              className={`rounded px-2 py-0.5 font-mono text-[11px] transition-colors ${
                                settings.openaiModel === mId
                                  ? 'bg-[#6366F1] text-white'
                                  : 'bg-[#0F1117] text-[#B5BBC9] hover:text-white'
                              }`}
                            >
                              {mId}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Web Search Grounding Toggle */}
              <div className="flex items-center justify-between gap-4 rounded-md border border-[#272B38] bg-[#0F1117] px-4 py-3">
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2 text-[12.5px] font-semibold text-[#E6E8EE]">
                    <Globe className="h-3.5 w-3.5 text-sky-400" />
                    <span>Live Web Search Grounding</span>
                  </div>
                  <p className="text-[11.5px] text-[#8B92A5]">
                    {settings.provider === 'gemini'
                      ? 'Uses Google Search grounding for real-time documentation, package versions, and web citations.'
                      : 'Equips OpenAI-compatible models with live web_search and fetch_web_page tools plus clickable source citations.'}
                  </p>
                </div>

                <button
                  type="button"
                  role="switch"
                  aria-checked={settings.enableWebSearch}
                  onClick={() =>
                    onChangeSettings({
                      ...settings,
                      enableWebSearch: !settings.enableWebSearch,
                    })
                  }
                  className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
                    settings.enableWebSearch ? 'bg-[#6366F1]' : 'bg-[#272B38]'
                  }`}
                >
                  <span
                    className={`block h-4 w-4 rounded-full bg-white transition-transform ${
                      settings.enableWebSearch ? 'translate-x-4.5' : 'translate-x-0.5'
                    }`}
                  />
                </button>
              </div>

              {/* Connection Check */}
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#272B38] pt-3">
                <div className="min-w-0 flex-1">
                  {testResult && (
                    <div
                      className={`font-mono text-[11.5px] tabular-nums ${
                        testResult.tone === 'ok' ? 'text-emerald-400' : 'text-red-300'
                      }`}
                    >
                      {testResult.message}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  disabled={isTesting}
                  onClick={() => void handleTestConnection()}
                  className="flex items-center gap-1.5 rounded-md border border-[#272B38] bg-[#0F1117] px-3 py-1.5 text-[12px] font-medium text-[#E6E8EE] hover:border-[#6366F1] hover:bg-[#1E222E] disabled:opacity-40 transition-colors whitespace-nowrap shrink-0"
                >
                  {isTesting ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-[#818CF8]" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5 text-[#818CF8]" />
                  )}
                  <span>Test Active Provider</span>
                </button>
              </div>
            </>
          ) : (
            /* Model Context Protocol (MCP) Tab */
            <div className="space-y-4">
              {/* Built-in Streamable HTTP MCP Endpoint Bar */}
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[#272B38] bg-[#0F1117] px-3.5 py-2.5">
                <div className="min-w-0">
                  <div className="text-[12px] font-semibold text-[#E6E8EE]">
                    Aetheris Streamable HTTP MCP Endpoint (JSON-RPC 2.0)
                  </div>
                  <div className="truncate font-mono text-[11.5px] text-[#8B92A5]">
                    POST {fullMcpEndpointUrl}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void copyMcpUrl()}
                  className="flex items-center gap-1.5 rounded border border-[#272B38] bg-[#161922] px-2.5 py-1 text-[11.5px] text-[#E6E8EE] hover:border-[#6366F1]/60 transition-colors whitespace-nowrap shrink-0"
                >
                  {copiedEndpoint ? (
                    <>
                      <Check className="h-3.5 w-3.5 text-emerald-400" />
                      <span>Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="h-3.5 w-3.5 text-[#818CF8]" />
                      <span>Copy URL</span>
                    </>
                  )}
                </button>
              </div>

              {/* Actions Header */}
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h3 className="text-[13px] font-semibold text-[#E6E8EE]">
                    Configured MCP Servers
                  </h3>
                  <p className="text-[11.5px] text-[#8B92A5]">
                    Enabled MCP tools and resources bridge automatically to both Gemini and OpenAI-compatible agents.
                  </p>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    disabled={isRefreshingMcp}
                    onClick={() => void handleRefreshMcp()}
                    className="flex items-center gap-1 rounded-md border border-[#272B38] bg-[#0F1117] px-2.5 py-1.5 text-[11.5px] text-[#B5BBC9] hover:text-white transition-colors whitespace-nowrap shrink-0"
                  >
                    <RefreshCw
                      className={`h-3.5 w-3.5 ${isRefreshingMcp ? 'animate-spin text-[#818CF8]' : ''}`}
                    />
                    <span>Refresh</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setAddingServer((prev) => !prev)}
                    className="flex items-center gap-1 rounded-md bg-[#6366F1] px-2.5 py-1.5 text-[11.5px] font-medium text-white hover:bg-[#818CF8] transition-colors whitespace-nowrap shrink-0"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    <span>Add Server</span>
                  </button>
                </div>
              </div>

              {mcpError && (
                <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-[12px] text-red-200">
                  {mcpError}
                </div>
              )}

              {/* Add External MCP Server Form */}
              {addingServer && (
                <form
                  onSubmit={handleAddMcpServer}
                  className="space-y-3 rounded-md border border-[#6366F1]/50 bg-[#0F1117] p-3.5"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-[12.5px] font-semibold text-[#E6E8EE]">
                      Register External MCP Server
                    </span>
                    <div className="flex items-center rounded bg-[#161922] p-0.5">
                      {(['http', 'stdio'] as const).map((tr) => (
                        <button
                          key={tr}
                          type="button"
                          onClick={() => setNewTransport(tr)}
                          className={`rounded px-2.5 py-0.5 font-mono text-[11px] uppercase transition-colors whitespace-nowrap ${
                            newTransport === tr
                              ? 'bg-[#6366F1]/25 text-[#818CF8]'
                              : 'text-[#8B92A5] hover:text-[#E6E8EE]'
                          }`}
                        >
                          {tr}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    <div>
                      <label className="mb-1 block text-[11.5px] text-[#8B92A5]">
                        Display Name
                      </label>
                      <input
                        type="text"
                        required
                        value={newServerName}
                        onChange={(e) => setNewServerName(e.target.value)}
                        placeholder="Docs MCP Server"
                        className="w-full rounded border border-[#272B38] bg-[#161922] px-2.5 py-1.5 text-[12px] text-[#E6E8EE] placeholder-[#52596E] focus:border-[#6366F1] focus:outline-none"
                      />
                    </div>

                    {newTransport === 'http' ? (
                      <div>
                        <label className="mb-1 block text-[11.5px] text-[#8B92A5]">
                          Streamable HTTP Endpoint URL
                        </label>
                        <input
                          type="url"
                          required
                          value={newUrl}
                          onChange={(e) => setNewUrl(e.target.value)}
                          placeholder="http://localhost:3000/api/mcp"
                          className="w-full rounded border border-[#272B38] bg-[#161922] px-2.5 py-1.5 font-mono text-[12px] text-[#E6E8EE] placeholder-[#52596E] focus:border-[#6366F1] focus:outline-none"
                        />
                      </div>
                    ) : (
                      <div>
                        <label className="mb-1 block text-[11.5px] text-[#8B92A5]">
                          Command Executable
                        </label>
                        <input
                          type="text"
                          required
                          value={newCommand}
                          onChange={(e) => setNewCommand(e.target.value)}
                          placeholder="npx"
                          className="w-full rounded border border-[#272B38] bg-[#161922] px-2.5 py-1.5 font-mono text-[12px] text-[#E6E8EE] placeholder-[#52596E] focus:border-[#6366F1] focus:outline-none"
                        />
                      </div>
                    )}
                  </div>

                  {newTransport === 'stdio' && (
                    <div>
                      <label className="mb-1 block text-[11.5px] text-[#8B92A5]">
                        Arguments (space-separated)
                      </label>
                      <input
                        type="text"
                        value={newArgs}
                        onChange={(e) => setNewArgs(e.target.value)}
                        placeholder="-y @modelcontextprotocol/server-everything"
                        className="w-full rounded border border-[#272B38] bg-[#161922] px-2.5 py-1.5 font-mono text-[12px] text-[#E6E8EE] placeholder-[#52596E] focus:border-[#6366F1] focus:outline-none"
                      />
                    </div>
                  )}

                  <div className="flex items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setAddingServer(false)}
                      className="rounded border border-[#272B38] px-3 py-1 text-[11.5px] text-[#8B92A5] hover:text-[#E6E8EE]"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={isSavingMcp}
                      className="flex items-center gap-1.5 rounded bg-[#6366F1] px-3 py-1 text-[11.5px] font-medium text-white hover:bg-[#818CF8] disabled:opacity-40"
                    >
                      {isSavingMcp && <Loader2 className="h-3 w-3 animate-spin" />}
                      <span>Connect & Save</span>
                    </button>
                  </div>
                </form>
              )}

              {/* Server List */}
              <div className="space-y-2.5">
                {mcpServers.map((srv) => {
                  const isExpanded = expandedServerId === srv.id;
                  return (
                    <div
                      key={srv.id}
                      className="rounded-md border border-[#272B38] bg-[#0F1117]"
                    >
                      <div className="flex items-center justify-between gap-3 px-3.5 py-2.5">
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedServerId(isExpanded ? null : srv.id)
                          }
                          className="flex min-w-0 flex-1 items-center gap-2 text-left"
                        >
                          {isExpanded ? (
                            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[#8B92A5]" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[#8B92A5]" />
                          )}
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="truncate text-[12.5px] font-semibold text-[#E6E8EE]">
                                {srv.name}
                              </span>
                              <span className="font-mono text-[10.5px] uppercase text-[#8B92A5]">
                                {srv.transport}
                              </span>
                              <span
                                className={`font-mono text-[11px] ${
                                  srv.status === 'connected'
                                    ? 'text-emerald-400'
                                    : srv.status === 'error'
                                      ? 'text-red-400'
                                      : 'text-[#8B92A5]'
                                }`}
                              >
                                {srv.status}
                              </span>
                            </div>
                            <div className="truncate font-mono text-[11px] text-[#8B92A5] tabular-nums">
                              {srv.tools.length} tools · {srv.resources.length} resources ·{' '}
                              {srv.prompts.length} prompts
                              {srv.url ? ` · ${srv.url}` : ''}
                              {srv.command ? ` · ${srv.command} ${(srv.args ?? []).join(' ')}` : ''}
                            </div>
                          </div>
                        </button>

                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            type="button"
                            role="switch"
                            aria-checked={srv.enabled}
                            onClick={() => void handleToggleMcp(srv.id, !srv.enabled)}
                            className={`relative h-5 w-9 rounded-full transition-colors ${
                              srv.enabled ? 'bg-[#6366F1]' : 'bg-[#272B38]'
                            }`}
                          >
                            <span
                              className={`block h-4 w-4 rounded-full bg-white transition-transform ${
                                srv.enabled ? 'translate-x-4.5' : 'translate-x-0.5'
                              }`}
                            />
                          </button>

                          {srv.transport !== 'builtin' && (
                            <button
                              type="button"
                              aria-label={`Remove ${srv.name}`}
                              onClick={() => void handleDeleteMcp(srv.id)}
                              className="rounded p-1 text-[#8B92A5] hover:bg-[#1E222E] hover:text-red-400 transition-colors"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      </div>

                      {srv.error && (
                        <div className="border-t border-[#272B38] bg-red-500/5 px-3.5 py-2 font-mono text-[11px] text-red-300">
                          {srv.error}
                        </div>
                      )}

                      {isExpanded && srv.enabled && (
                        <div className="border-t border-[#272B38] px-3.5 py-3 space-y-3">
                          {srv.description && (
                            <p className="text-[11.5px] text-[#8B92A5]">{srv.description}</p>
                          )}

                          {/* Tools */}
                          {srv.tools.length > 0 && (
                            <div className="space-y-1.5">
                              <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[#8B92A5]">
                                <Wrench className="h-3 w-3 text-[#818CF8]" />
                                <span>Tools ({srv.tools.length})</span>
                              </div>
                              <div className="divide-y divide-[#272B38]/60 rounded border border-[#272B38] bg-[#161922]">
                                {srv.tools.map((tool) => (
                                  <div key={tool.qualifiedName} className="px-2.5 py-1.5">
                                    <div className="font-mono text-[11.5px] font-medium text-[#C7D2FE]">
                                      {tool.name}
                                    </div>
                                    <div className="text-[11px] text-[#8B92A5]">
                                      {tool.description}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* Resources */}
                          {srv.resources.length > 0 && (
                            <div className="space-y-1.5">
                              <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[#8B92A5]">
                                <Database className="h-3 w-3 text-emerald-400" />
                                <span>Context Resources ({srv.resources.length})</span>
                              </div>
                              <div className="divide-y divide-[#272B38]/60 rounded border border-[#272B38] bg-[#161922]">
                                {srv.resources.map((resItem) => (
                                  <div
                                    key={resItem.uri}
                                    className="flex items-center justify-between gap-2 px-2.5 py-1.5"
                                  >
                                    <div className="min-w-0">
                                      <div className="flex items-center gap-2">
                                        <span className="text-[11.5px] font-medium text-[#E6E8EE]">
                                          {resItem.name}
                                        </span>
                                        <span className="truncate font-mono text-[10.5px] text-[#8B92A5]">
                                          {resItem.uri}
                                        </span>
                                      </div>
                                      {resItem.description && (
                                        <div className="text-[11px] text-[#8B92A5]">
                                          {resItem.description}
                                        </div>
                                      )}
                                    </div>
                                    <button
                                      type="button"
                                      onClick={() => void handlePreviewResource(srv.id, resItem.uri)}
                                      className="flex items-center gap-1 rounded border border-[#272B38] bg-[#0F1117] px-2 py-0.5 text-[11px] text-[#B5BBC9] hover:text-white shrink-0"
                                    >
                                      <Eye className="h-3 w-3" />
                                      <span>Inspect</span>
                                    </button>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* Prompts */}
                          {srv.prompts.length > 0 && (
                            <div className="space-y-1.5">
                              <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[#8B92A5]">
                                <Terminal className="h-3 w-3 text-amber-400" />
                                <span>Prompt Templates ({srv.prompts.length})</span>
                              </div>
                              <div className="divide-y divide-[#272B38]/60 rounded border border-[#272B38] bg-[#161922]">
                                {srv.prompts.map((pr) => (
                                  <div key={pr.name} className="px-2.5 py-1.5">
                                    <div className="font-mono text-[11.5px] font-medium text-[#E6E8EE]">
                                      /{pr.name}
                                    </div>
                                    {pr.description && (
                                      <div className="text-[11px] text-[#8B92A5]">
                                        {pr.description}
                                      </div>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Live Resource Inspector Drawer */}
              {resourcePreview && (
                <div className="rounded-md border border-[#6366F1]/50 bg-[#0F1117] p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[11.5px] text-[#C7D2FE]">
                      {resourcePreview.uri}
                    </span>
                    <button
                      type="button"
                      onClick={() => setResourcePreview(null)}
                      className="rounded p-0.5 text-[#8B92A5] hover:text-white"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  {resourcePreview.loading ? (
                    <div className="flex items-center gap-2 py-3 text-[12px] text-[#8B92A5]">
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-[#818CF8]" />
                      <span>Reading MCP resource...</span>
                    </div>
                  ) : (
                    <pre className="max-h-44 overflow-auto rounded bg-[#161922] p-2.5 font-mono text-[11px] leading-relaxed text-[#B5BBC9] whitespace-pre-wrap">
                      {resourcePreview.text}
                    </pre>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex h-11 shrink-0 items-center justify-between border-t border-[#272B38] bg-[#0F1117]/60 px-4 text-[11.5px] text-[#8B92A5]">
          <span className="font-mono truncate">
            Active: {settings.provider === 'gemini' ? `Gemini (${settings.geminiModel})` : `OpenAI-Compatible (${settings.openaiModel})`}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md bg-[#6366F1] px-3.5 py-1 text-[12px] font-medium text-white hover:bg-[#818CF8] transition-colors whitespace-nowrap shrink-0"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};

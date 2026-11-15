import { fetchWebPageContent, performWebSearch } from './webSearch.ts';

export interface OpenAiToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export type OpenAiChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: OpenAiToolCall[];
    }
  | {
      role: 'tool';
      tool_call_id: string;
      content: string;
    };

export function resolveOpenAiCompatConfig(overrides?: {
  baseUrl?: string;
  model?: string;
}): {
  baseUrl: string;
  chatCompletionsUrl: string;
  modelsUrl: string;
  model: string;
  apiKey: string;
} {
  const rawUrl = (
    overrides?.baseUrl?.trim() ||
    process.env.OPENAI_COMPAT_BASE_URL?.trim() ||
    'https://api.openai.com/v1'
  ).replace(/\/+$/, '');

  const baseRoot = rawUrl.endsWith('/chat/completions')
    ? rawUrl.slice(0, -'/chat/completions'.length)
    : rawUrl;

  const model =
    overrides?.model?.trim() ||
    process.env.OPENAI_COMPAT_MODEL?.trim() ||
    'gpt-4o';

  const apiKey = (
    process.env.OPENAI_COMPAT_API_KEY ||
    process.env.OPENAI_API_KEY ||
    ''
  ).trim();

  const isLocalHost = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(\/|$)/i.test(
    baseRoot
  );

  if (!apiKey && !isLocalHost) {
    throw new Error(
      'OPENAI_COMPAT_API_KEY is not configured in the server environment. Add OPENAI_COMPAT_API_KEY in Settings > Secrets (or .env), or connect to a keyless local OpenAI-compatible server.'
    );
  }

  return {
    baseUrl: baseRoot,
    chatCompletionsUrl: `${baseRoot}/chat/completions`,
    modelsUrl: `${baseRoot}/models`,
    model,
    apiKey,
  };
}

function buildAuthHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

export async function fetchOpenAiCompatModels(baseUrl?: string): Promise<string[]> {
  const rawUrl = (
    baseUrl?.trim() ||
    process.env.OPENAI_COMPAT_BASE_URL?.trim() ||
    'https://api.openai.com/v1'
  ).replace(/\/+$/, '');
  const baseRoot = rawUrl.endsWith('/chat/completions')
    ? rawUrl.slice(0, -'/chat/completions'.length)
    : rawUrl;
  const apiKey = (
    process.env.OPENAI_COMPAT_API_KEY ||
    process.env.OPENAI_API_KEY ||
    ''
  ).trim();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${baseRoot}/models`, {
      headers: buildAuthHeaders(apiKey),
      signal: controller.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} fetching models${errText ? `: ${errText.slice(0, 180)}` : ''}`);
    }
    const json = (await res.json()) as {
      data?: Array<{ id?: string }>;
      models?: Array<{ id?: string; name?: string }>;
    };
    const ids = (json.data ?? json.models ?? [])
      .map((m) => (m.id || (m as { name?: string }).name || '').trim())
      .filter(Boolean);
    return Array.from(new Set(ids)).slice(0, 200);
  } finally {
    clearTimeout(timer);
  }
}

export const WEB_SEARCH_OPENAI_TOOLS: OpenAiToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Search the live web for up-to-date technical documentation, API references, package releases, error messages, or current facts. Returns ranked titles, URLs, and snippets.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Focused search query string.',
          },
          max_results: {
            type: 'integer',
            description: 'Maximum results to return (1-8, default 6).',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_web_page',
      description:
        'Fetch and extract clean readable text from a public HTTP/HTTPS web page or documentation URL returned by web_search.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'Full https:// URL to read.',
          },
        },
        required: ['url'],
      },
    },
  },
];

function extractInlineThinkBlocks(text: string): { cleanText: string; extractedThoughts: string } {
  let extractedThoughts = '';
  const cleanText = text.replace(/<think>([\s\S]*?)<\/think>/gi, (_m, inner: string) => {
    extractedThoughts += `${inner.trim()}\n`;
    return '';
  });
  return { cleanText: cleanText.trim(), extractedThoughts: extractedThoughts.trim() };
}

async function callSingleOpenAiTurn(params: {
  chatCompletionsUrl: string;
  apiKey: string;
  model: string;
  messages: OpenAiChatMessage[];
  tools: OpenAiToolDefinition[];
  signal?: AbortSignal;
  onThoughtDelta?: (delta: string) => void;
}): Promise<{
  content: string;
  reasoning: string;
  toolCalls: OpenAiToolCall[];
}> {
  const { chatCompletionsUrl, apiKey, model, messages, tools, signal, onThoughtDelta } = params;

  const basePayload: Record<string, unknown> = {
    model,
    messages,
    ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
  };

  // Try SSE streaming first for real-time reasoning & fast first-byte response
  const res = await fetch(chatCompletionsUrl, {
    method: 'POST',
    headers: buildAuthHeaders(apiKey),
    body: JSON.stringify({ ...basePayload, stream: true }),
    signal,
  });

  if (!res.ok) {
    const rawErr = await res.text().catch(() => '');
    let msg = `OpenAI-compatible API error (HTTP ${res.status})`;
    try {
      const parsedErr = JSON.parse(rawErr) as { error?: { message?: string } | string };
      if (typeof parsedErr.error === 'string') msg = parsedErr.error;
      else if (parsedErr.error?.message) msg = parsedErr.error.message;
      else if (rawErr) msg = `${msg}: ${rawErr.slice(0, 240)}`;
    } catch {
      if (rawErr) msg = `${msg}: ${rawErr.slice(0, 240)}`;
    }
    throw new Error(msg);
  }

  const contentType = (res.headers.get('content-type') ?? '').toLowerCase();

  // Handle standard JSON response if server ignored stream: true
  if (!contentType.includes('text/event-stream') || !res.body) {
    const json = (await res.json()) as {
      choices?: Array<{
        message?: {
          content?: string | null;
          reasoning_content?: string | null;
          reasoning?: string | null;
          tool_calls?: Array<{
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
      }>;
    };
    const msg = json.choices?.[0]?.message;
    const rawContent = msg?.content ?? '';
    const { cleanText, extractedThoughts } = extractInlineThinkBlocks(rawContent);
    const reasoning = [msg?.reasoning_content ?? msg?.reasoning ?? '', extractedThoughts]
      .filter(Boolean)
      .join('\n')
      .trim();
    if (reasoning && onThoughtDelta) {
      onThoughtDelta(reasoning);
    }
    const toolCalls: OpenAiToolCall[] = (msg?.tool_calls ?? []).map((tc, i) => ({
      id: tc.id || `call_${Date.now()}_${i}`,
      type: 'function',
      function: {
        name: tc.function?.name ?? '',
        arguments: tc.function?.arguments ?? '{}',
      },
    }));
    return { content: cleanText, reasoning, toolCalls };
  }

  // Parse SSE stream chunks
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = '';
  let contentAccum = '';
  let reasoningAccum = '';
  const toolCallAccum = new Map<
    number,
    { id: string; name: string; args: string }
  >();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    sseBuffer += decoder.decode(value, { stream: true });

    let lineEnd = sseBuffer.indexOf('\n');
    while (lineEnd !== -1) {
      const rawLine = sseBuffer.slice(0, lineEnd).trim();
      sseBuffer = sseBuffer.slice(lineEnd + 1);

      if (rawLine.startsWith('data:')) {
        const dataStr = rawLine.slice(5).trim();
        if (dataStr && dataStr !== '[DONE]') {
          try {
            const chunk = JSON.parse(dataStr) as {
              choices?: Array<{
                delta?: {
                  content?: string | null;
                  reasoning_content?: string | null;
                  reasoning?: string | null;
                  tool_calls?: Array<{
                    index?: number;
                    id?: string;
                    function?: { name?: string; arguments?: string };
                  }>;
                };
              }>;
            };
            const delta = chunk.choices?.[0]?.delta;
            if (delta) {
              const rPiece = delta.reasoning_content ?? delta.reasoning ?? '';
              if (rPiece) {
                reasoningAccum += rPiece;
                onThoughtDelta?.(rPiece);
              }
              if (typeof delta.content === 'string' && delta.content) {
                contentAccum += delta.content;
              }
              if (Array.isArray(delta.tool_calls)) {
                for (let i = 0; i < delta.tool_calls.length; i++) {
                  const tc = delta.tool_calls[i];
                  const idx = typeof tc.index === 'number' ? tc.index : i;
                  const existing = toolCallAccum.get(idx) ?? {
                    id: tc.id || `call_${Date.now()}_${idx}`,
                    name: '',
                    args: '',
                  };
                  if (tc.id) existing.id = tc.id;
                  if (tc.function?.name) existing.name += tc.function.name;
                  if (tc.function?.arguments) existing.args += tc.function.arguments;
                  toolCallAccum.set(idx, existing);
                }
              }
            }
          } catch {
            // Skip malformed SSE keepalive line
          }
        }
      }

      lineEnd = sseBuffer.indexOf('\n');
    }
  }

  const { cleanText, extractedThoughts } = extractInlineThinkBlocks(contentAccum);
  if (extractedThoughts && !reasoningAccum) {
    reasoningAccum = extractedThoughts;
    onThoughtDelta?.(extractedThoughts);
  }

  const toolCalls: OpenAiToolCall[] = Array.from(toolCallAccum.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, v]): OpenAiToolCall => ({
      id: v.id,
      type: 'function',
      function: {
        name: v.name,
        arguments: v.args || '{}',
      },
    }))
    .filter((tc) => Boolean(tc.function.name));

  return {
    content: cleanText,
    reasoning: reasoningAccum.trim(),
    toolCalls,
  };
}

export async function runOpenAiCompatAgentLoop(params: {
  baseUrl?: string;
  model?: string;
  systemInstruction: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  initialUserPrompt: string;
  tools: OpenAiToolDefinition[];
  enableWebSearch: boolean;
  maxTurns: number;
  signal?: AbortSignal;
  executeCustomTool: (
    name: string,
    args: Record<string, unknown>,
    callIndex: number
  ) => Promise<Record<string, unknown>>;
  onActivity?: (activity: {
    id: string;
    kind: 'read' | 'think' | 'edit' | 'plan' | 'done' | 'search';
    label: string;
    filePath?: string;
    status: 'running' | 'done';
  }) => void;
  onThoughtDelta?: (delta: string) => void;
}): Promise<{
  finalText: string;
  thoughts: string;
  thinkingDurationMs: number;
  sources: Array<{ title: string; uri: string }>;
  searchQueries: string[];
}> {
  const { chatCompletionsUrl, apiKey, model } = resolveOpenAiCompatConfig({
    baseUrl: params.baseUrl,
    model: params.model,
  });

  const combinedTools = params.enableWebSearch
    ? [...params.tools, ...WEB_SEARCH_OPENAI_TOOLS]
    : [...params.tools];

  const messages: OpenAiChatMessage[] = [
    { role: 'system', content: params.systemInstruction },
    ...params.history.map(
      (h): OpenAiChatMessage => ({
        role: h.role,
        content: h.content.slice(0, 4000),
      })
    ),
    { role: 'user', content: params.initialUserPrompt },
  ];

  let finalText = '';
  let thoughtsAccum = '';
  let thoughtStartMs: number | null = null;
  let thoughtEndMs: number | null = null;
  const startedAt = Date.now();
  const sourcesMap = new Map<string, { title: string; uri: string }>();
  const searchQueriesSet = new Set<string>();

  for (let turn = 0; turn < params.maxTurns; turn++) {
    if (params.signal?.aborted) break;

    const turnResult = await callSingleOpenAiTurn({
      chatCompletionsUrl,
      apiKey,
      model,
      messages,
      tools: combinedTools,
      signal: params.signal,
      onThoughtDelta: (delta) => {
        if (thoughtStartMs === null) thoughtStartMs = Date.now();
        thoughtEndMs = Date.now();
        thoughtsAccum += delta;
        params.onThoughtDelta?.(delta);
      },
    });

    if (params.signal?.aborted) break;

    if (turnResult.toolCalls.length === 0) {
      finalText = turnResult.content.trim();
      break;
    }

    messages.push({
      role: 'assistant',
      content: turnResult.content || null,
      tool_calls: turnResult.toolCalls,
    });

    for (let i = 0; i < turnResult.toolCalls.length; i++) {
      if (params.signal?.aborted) break;
      const tc = turnResult.toolCalls[i];
      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>;
      } catch {
        parsedArgs = {};
      }

      let toolOutput: Record<string, unknown>;

      if (tc.function.name === 'web_search' && params.enableWebSearch) {
        const query = String(parsedArgs.query ?? '').trim();
        const maxResults = Number(parsedArgs.max_results ?? 6) || 6;
        const actId = `wsearch-${turn}-${i}`;
        if (query) {
          searchQueriesSet.add(query);
          params.onActivity?.({
            id: actId,
            kind: 'search',
            label: `Web Search: "${query.slice(0, 48)}"`,
            status: 'running',
          });
        }
        const results = await performWebSearch(query, maxResults);
        for (const r of results) {
          if (r.url && !sourcesMap.has(r.url)) {
            sourcesMap.set(r.url, { title: r.title || r.url, uri: r.url });
          }
        }
        if (query) {
          params.onActivity?.({
            id: actId,
            kind: 'search',
            label: `Web Search: "${query.slice(0, 40)}" (${results.length} results)`,
            status: 'done',
          });
        }
        toolOutput = { query, count: results.length, results };
      } else if (tc.function.name === 'fetch_web_page' && params.enableWebSearch) {
        const url = String(parsedArgs.url ?? '').trim();
        const actId = `wfetch-${turn}-${i}`;
        params.onActivity?.({
          id: actId,
          kind: 'search',
          label: `Reading web page: ${url.slice(0, 48)}`,
          status: 'running',
        });
        try {
          const page = await fetchWebPageContent(url);
          if (page.url && !sourcesMap.has(page.url)) {
            sourcesMap.set(page.url, { title: page.title || page.url, uri: page.url });
          }
          params.onActivity?.({
            id: actId,
            kind: 'search',
            label: `Read web page: ${page.title.slice(0, 44)}`,
            status: 'done',
          });
          toolOutput = page;
        } catch (err) {
          params.onActivity?.({
            id: actId,
            kind: 'search',
            label: `Failed to fetch URL`,
            status: 'done',
          });
          toolOutput = { error: err instanceof Error ? err.message : 'Failed to fetch web page' };
        }
      } else {
        toolOutput = await params.executeCustomTool(tc.function.name, parsedArgs, i + turn * 20);
      }

      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(toolOutput),
      });
    }
  }

  const thinkingDurationMs =
    thoughtStartMs !== null
      ? Math.max(200, (thoughtEndMs ?? Date.now()) - thoughtStartMs)
      : Date.now() - startedAt;

  return {
    finalText,
    thoughts: thoughtsAccum.trim(),
    thinkingDurationMs,
    sources: Array.from(sourcesMap.values()),
    searchQueries: Array.from(searchQueriesSet),
  };
}

export async function generateSimpleOpenAiCompletion(params: {
  baseUrl?: string;
  model?: string;
  prompt: string;
}): Promise<string> {
  const { chatCompletionsUrl, apiKey, model } = resolveOpenAiCompatConfig({
    baseUrl: params.baseUrl,
    model: params.model,
  });

  const turn = await callSingleOpenAiTurn({
    chatCompletionsUrl,
    apiKey,
    model,
    messages: [{ role: 'user', content: params.prompt }],
    tools: [],
  });
  return turn.content.trim();
}

import { AgentMessage, AgentMode, HomeChatMessage, ModelEffort } from '../types/ide';

export interface PersistedWorkspaceSession {
  workspaceKey: string;
  messages: AgentMessage[];
  agentMode: AgentMode;
  effort: ModelEffort;
  followAi: boolean;
  updatedAt: number;
}

const DB_NAME = 'aetheris-conversations';
const DB_VERSION = 1;
const STORE_NAME = 'sessions';
const HOME_CHAT_KEY = '__aetheris_home_chat__';
const LS_PREFIX = 'aetheris.session.';
const MAX_MESSAGES_PER_WORKSPACE = 40;

function openSessionDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) {
        req.result.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Failed to open conversation DB'));
  });
}

/**
 * Compacts older settled patch payloads while keeping full recent diffs,
 * thoughts, and conversation turns intact so storage stays fast and lean.
 */
function compactMessages(messages: AgentMessage[]): AgentMessage[] {
  const sliced = messages.slice(-MAX_MESSAGES_PER_WORKSPACE);
  const cutoff = Math.max(0, sliced.length - 10);

  return sliced.map((msg, idx) => {
    const cleaned: AgentMessage = {
      ...msg,
      isStreaming: false,
      activity: msg.activity?.map((act) => ({
        ...act,
        status: 'done',
      })),
    };

    if (idx < cutoff && cleaned.patches?.length) {
      cleaned.patches = cleaned.patches.map((p) =>
        p.status === 'pending'
          ? p
          : {
              ...p,
              originalContent: '',
            }
      );
    }

    return cleaned;
  });
}

function sanitizeLoadedMessages(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((msg) => ({
    ...msg,
    isStreaming: false,
    activity: msg.activity?.map((act) => ({
      ...act,
      status: 'done',
    })),
  }));
}

export function getWorkspaceSessionKey(source: string, id: string): string {
  return `${source}:${id}`;
}

export async function loadWorkspaceSession(
  workspaceKey: string
): Promise<PersistedWorkspaceSession | null> {
  try {
    const db = await openSessionDb();
    const record = await new Promise<PersistedWorkspaceSession | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(workspaceKey);
      req.onsuccess = () =>
        resolve((req.result as PersistedWorkspaceSession | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
    if (record) {
      return {
        ...record,
        messages: sanitizeLoadedMessages(record.messages ?? []),
      };
    }
  } catch {
    // Fallback to localStorage below
  }

  try {
    const raw = localStorage.getItem(`${LS_PREFIX}${workspaceKey}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedWorkspaceSession;
    return {
      ...parsed,
      messages: sanitizeLoadedMessages(parsed.messages ?? []),
    };
  } catch {
    return null;
  }
}

export async function saveWorkspaceSession(
  session: PersistedWorkspaceSession
): Promise<void> {
  const compacted: PersistedWorkspaceSession = {
    ...session,
    messages: compactMessages(session.messages),
    updatedAt: Date.now(),
  };

  try {
    const db = await openSessionDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(compacted, compacted.workspaceKey);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return;
  } catch {
    // Fallback to localStorage
  }

  try {
    localStorage.setItem(`${LS_PREFIX}${compacted.workspaceKey}`, JSON.stringify(compacted));
  } catch {
    // Ignore storage quota errors
  }
}

export async function clearWorkspaceSessionMessages(workspaceKey: string): Promise<void> {
  const existing = await loadWorkspaceSession(workspaceKey);
  await saveWorkspaceSession({
    workspaceKey,
    messages: [],
    agentMode: existing?.agentMode ?? 'action',
    effort: existing?.effort ?? 'medium',
    followAi: existing?.followAi ?? true,
    updatedAt: Date.now(),
  });
}

export async function loadHomeChatHistory(): Promise<HomeChatMessage[]> {
  try {
    const db = await openSessionDb();
    const stored = await new Promise<HomeChatMessage[] | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(HOME_CHAT_KEY);
      req.onsuccess = () => resolve((req.result as HomeChatMessage[] | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
    if (Array.isArray(stored)) return stored;
  } catch {
    // Fallback to localStorage
  }

  try {
    const raw = localStorage.getItem(`${LS_PREFIX}${HOME_CHAT_KEY}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as HomeChatMessage[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function saveHomeChatHistory(messages: HomeChatMessage[]): Promise<void> {
  const trimmed = messages.slice(-40);
  try {
    const db = await openSessionDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(trimmed, HOME_CHAT_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return;
  } catch {
    // Fallback to localStorage
  }

  try {
    localStorage.setItem(`${LS_PREFIX}${HOME_CHAT_KEY}`, JSON.stringify(trimmed));
  } catch {
    // Ignore storage quota errors
  }
}

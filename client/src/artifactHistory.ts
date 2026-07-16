/**
 * Local, per-workspace history of saved shared-result snapshots.
 *
 * Lets a user capture the current shared result (e.g. an agent's contribution)
 * into a history list, then clear the panel so a fresh result can be produced.
 * Saved snapshots persist in localStorage per workspace so they survive
 * reloads. This is a client-side convenience; it does not sync to other
 * participants.
 */

export interface SavedResult {
  id: string;
  savedAt: number;
  content: string;
}

const KEY_PREFIX = "maw:history:";
const MAX_ENTRIES = 50;

function storage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

function keyFor(workspaceId: string): string {
  return `${KEY_PREFIX}${workspaceId}`;
}

function newId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through */
  }
  return `h-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Load saved snapshots for a workspace, newest first. */
export function loadHistory(workspaceId: string): SavedResult[] {
  const store = storage();
  if (!store || !workspaceId) return [];
  try {
    const raw = store.getItem(keyFor(workspaceId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as SavedResult[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persist(workspaceId: string, entries: SavedResult[]): void {
  const store = storage();
  if (!store || !workspaceId) return;
  try {
    store.setItem(keyFor(workspaceId), JSON.stringify(entries.slice(0, MAX_ENTRIES)));
  } catch {
    /* ignore quota errors */
  }
}

/** Prepend a new snapshot and return the updated list (newest first). */
export function addToHistory(workspaceId: string, content: string): SavedResult[] {
  const entry: SavedResult = { id: newId(), savedAt: Date.now(), content };
  const next = [entry, ...loadHistory(workspaceId)].slice(0, MAX_ENTRIES);
  persist(workspaceId, next);
  return next;
}

/** Remove one snapshot by id and return the updated list. */
export function removeFromHistory(workspaceId: string, id: string): SavedResult[] {
  const next = loadHistory(workspaceId).filter((e) => e.id !== id);
  persist(workspaceId, next);
  return next;
}

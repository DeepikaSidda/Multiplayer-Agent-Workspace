/**
 * Persistent per-workspace session identity for the browser.
 *
 * When a human joins a workspace we remember their chosen display name and a
 * stable participant id, keyed by the workspace join reference. On a later
 * reload the app can rejoin automatically (no re-prompt) and — because the
 * participant id is reused — the join is idempotent on the server, so a refresh
 * does not create a duplicate participant in the roster.
 *
 * Storage is best-effort: any access is guarded so a browser with storage
 * disabled (or a non-browser build/test environment) simply behaves as if no
 * session was remembered.
 */

export interface StoredSession {
  displayName: string;
  participantId: string;
}

const KEY_PREFIX = "maw:session:";

function storage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

function keyFor(joinReference: string): string {
  return `${KEY_PREFIX}${joinReference}`;
}

/** Generate a stable participant id, falling back if `crypto` is unavailable. */
export function newParticipantId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // fall through to the manual generator
  }
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Read a remembered session for a workspace reference, or null. */
export function loadSession(joinReference: string): StoredSession | null {
  const store = storage();
  if (!store || !joinReference) return null;
  try {
    const raw = store.getItem(keyFor(joinReference));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (
      typeof parsed?.displayName === "string" &&
      parsed.displayName.trim().length > 0 &&
      typeof parsed?.participantId === "string" &&
      parsed.participantId.length > 0
    ) {
      return { displayName: parsed.displayName, participantId: parsed.participantId };
    }
    return null;
  } catch {
    return null;
  }
}

/** Remember a session for a workspace reference (best effort). */
export function saveSession(joinReference: string, session: StoredSession): void {
  const store = storage();
  if (!store || !joinReference) return;
  try {
    store.setItem(keyFor(joinReference), JSON.stringify(session));
  } catch {
    // Ignore quota/permission errors; auto-rejoin is a convenience only.
  }
}

/** Forget a remembered session (e.g. after an invalid/expired reference). */
export function clearSession(joinReference: string): void {
  const store = storage();
  if (!store || !joinReference) return;
  try {
    store.removeItem(keyFor(joinReference));
  } catch {
    // Ignore.
  }
}

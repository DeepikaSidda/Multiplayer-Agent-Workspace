/**
 * The `WorkspaceStore` durable persistence interface.
 *
 * Backs the Persistence Store component from the design document. It is the
 * single abstraction the server services depend on for durable state, and it
 * has multiple implementations:
 *  - {@link SqliteWorkspaceStore} — the MVP default backed by `better-sqlite3`.
 *  - {@link InMemoryWorkspaceStore} — a fast in-memory store for tests.
 *  - {@link FailureInjectingWorkspaceStore} — a decorator that can force
 *    persistence failures to exercise transactional/rollback behavior.
 *
 * All methods are async so the interface can equally back a synchronous
 * embedded database (SQLite) or a remote one (e.g. DynamoDB) in the future.
 */

import type {
  ArtifactSnapshot,
  Message,
  Participant,
  SavedResultEntry,
  Workspace,
} from "@maw/shared";

/**
 * The full set of entities that make up a freshly created workspace.
 *
 * Workspace creation must be atomic across all three (Requirement 1.2: on
 * failure the System SHALL NOT create the Workspace and SHALL NOT assign an
 * Owner). The design's minimal `createWorkspace(w)` signature is therefore
 * widened to carry the Owner participant and the initial artifact so the store
 * can insert them in a single transaction with no partial rows on failure.
 */
export interface WorkspaceCreation {
  /** The workspace row (unique `id` and `joinReference`). */
  workspace: Workspace;
  /** The Owner participant (a human) recorded in the same transaction. */
  owner: Participant;
  /** The initial artifact snapshot (empty content) for the workspace. */
  artifact: ArtifactSnapshot;
}

/** Durable persistence for workspaces, participants, messages, and artifacts. */
export interface WorkspaceStore {
  /**
   * Atomically create a workspace together with its Owner participant and its
   * initial artifact snapshot. Either all three are persisted or none are; a
   * failure (including a duplicate id/joinReference) leaves the store
   * unchanged. Requirements 1.1, 1.2.
   */
  createWorkspace(creation: WorkspaceCreation): Promise<void>;

  /** Resolve a shareable join reference to its workspace, or null. Requirement 1.3. */
  getWorkspaceByJoinRef(ref: string): Promise<Workspace | null>;

  /** Whether a workspace with the given id exists. */
  workspaceExists(id: string): Promise<boolean>;

  /** Durably append a message to a workspace's log. Requirement 8.1. */
  appendMessage(m: Message): Promise<void>;

  /**
   * Load a workspace's complete message log ordered by ascending
   * `(timestamp, sequence)`. Requirements 3.4, 8.5.
   */
  loadMessages(workspaceId: string): Promise<Message[]>;

  /**
   * Persist the current artifact snapshot (content + encoded `yjsState`),
   * replacing the previous snapshot for the workspace. Requirement 8.3.
   */
  saveArtifactSnapshot(a: ArtifactSnapshot): Promise<void>;

  /** Load the current artifact snapshot for a workspace, or null. Requirement 8.5. */
  loadArtifact(workspaceId: string): Promise<ArtifactSnapshot | null>;

  /** Insert or update a participant of a workspace (idempotent by id). */
  upsertParticipant(workspaceId: string, p: Participant): Promise<void>;

  /**
   * Load the current participant roster for a workspace. Returns an empty
   * array for an unknown workspace. Because {@link upsertParticipant} is
   * idempotent by id, a reconnecting participant appears exactly once here —
   * making the roster the observable for join idempotency (Requirements 1.4,
   * 1.5). Also used to build the join snapshot's participant list.
   */
  loadParticipants(workspaceId: string): Promise<Participant[]>;

  /** Remove a participant from a workspace (no-op if absent). */
  removeParticipant(workspaceId: string, participantId: string): Promise<void>;

  /** Durably save a shared-result history entry. */
  saveHistoryEntry(entry: SavedResultEntry): Promise<void>;

  /** Load the saved-result history for a workspace, newest first. */
  loadHistory(workspaceId: string): Promise<SavedResultEntry[]>;

  /** Delete a saved-result history entry by id (no-op if absent). */
  deleteHistoryEntry(workspaceId: string, entryId: string): Promise<void>;
}

/**
 * Artifact Service — the authoritative Yjs CRDT layer for the collaborative
 * artifact (design: "Artifact Service").
 *
 * Responsibilities implemented by task 7.1:
 *  - Wrap one authoritative `Y.Doc` / `Y.Text` per workspace in an in-memory
 *    registry.
 *  - Apply incoming Yjs updates, enforcing the 100,000-character content limit
 *    on the *resulting* document. Over-limit updates are rejected with
 *    `SIZE_LIMIT` and the prior content is preserved (Requirements 6.5, 6.7).
 *  - Persist the artifact snapshot (content + encoded `yjsState`) BEFORE the
 *    update is treated as committed/broadcastable; on persist failure the doc
 *    is reverted to the last successfully persisted `yjsState` and
 *    `PERSIST_FAILED` is returned (Requirements 8.3, 8.4).
 *  - Record `lastEditorId` / `lastEditedAt` on every applied change
 *    (Requirement 6.6) and expose `getContent`.
 *
 * `snapshotOrigin` / `rollbackOrigin` (task 7.2) let an agent's edits be applied
 * inside an origin-tagged transaction and later undone via a scoped
 * `Y.UndoManager` — reverting only the agent's operations while preserving any
 * concurrent human edits (Requirements 5.4, 6.7).
 */

import { ARTIFACT_CONTENT_LIMIT, type ArtifactSnapshot, type ArtifactType } from "@maw/shared";
import * as Y from "yjs";
import type { WorkspaceStore } from "../store/index.js";

/** The shared `Y.Text` key inside each workspace's `Y.Doc`. */
export const ARTIFACT_TEXT_KEY = "content";

/** Result of {@link ArtifactService.applyUpdate}. */
export type ArtifactApplyResult =
  | { ok: true; length: number }
  | { ok: false; reason: "SIZE_LIMIT" | "PERSIST_FAILED" };

/**
 * Result of {@link ArtifactService.applyProposedContent}. On success it carries
 * the resulting `length` plus the incremental Yjs `update` (encoded against the
 * pre-edit state vector) so the transport layer can broadcast the edit to peers
 * without re-sending the whole document.
 */
export type ArtifactProposeResult =
  | { ok: true; length: number; update: Uint8Array }
  | { ok: false; reason: "SIZE_LIMIT" | "PERSIST_FAILED" };

/** Optional dependency injection for the service (used by tests). */
export interface ArtifactServiceOptions {
  /** Clock used to stamp `lastEditedAt`; defaults to `Date.now`. */
  now?: () => number;
}

/**
 * In-memory state for a single workspace's authoritative artifact document.
 * Designed so task 7.2 can attach a per-origin `Y.UndoManager` without changing
 * the applyUpdate/persist flow.
 */
interface ArtifactEntry {
  workspaceId: string;
  artifactId: string;
  artifactType: ArtifactType;
  /** The authoritative CRDT document. */
  doc: Y.Doc;
  /** Encoded state of the last snapshot that was successfully persisted. */
  lastPersistedState: Uint8Array;
  lastEditorId: string | null;
  lastEditedAt: number | null;
  /**
   * Per-origin `Y.UndoManager`s created by {@link ArtifactService.snapshotOrigin}.
   * Each manager tracks ONLY transactions whose origin equals its key (an agent
   * id), so undoing it reverts only that agent's operations. Concurrent edits by
   * other origins (humans or other agents) are never tracked and thus preserved.
   */
  undoManagers: Map<string, Y.UndoManager>;
}

export class ArtifactService {
  private readonly registry = new Map<string, ArtifactEntry>();
  private readonly now: () => number;

  constructor(
    private readonly store: WorkspaceStore,
    options: ArtifactServiceOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Ensure the workspace's authoritative document is loaded into the registry
   * from the persisted snapshot. Safe to call repeatedly. Room-manager code can
   * use this to warm the registry on join so {@link getContent} is populated.
   */
  async ensureLoaded(workspaceId: string): Promise<void> {
    await this.getEntry(workspaceId);
  }

  /**
   * Apply an incoming Yjs update to the authoritative document.
   *
   * The size guard is evaluated on a clone so an over-limit update never
   * mutates the authoritative document (Requirement 6.5). On a valid update the
   * snapshot is persisted before success is reported; a persist failure reverts
   * the document to the last persisted state (Requirements 8.3, 8.4).
   */
  async applyUpdate(
    workspaceId: string,
    update: Uint8Array,
    editorId: string,
  ): Promise<ArtifactApplyResult> {
    const entry = await this.getEntry(workspaceId);

    // --- Size guard on a clone (never touch the authoritative doc yet) ---
    const clone = new Y.Doc();
    Y.applyUpdate(clone, Y.encodeStateAsUpdate(entry.doc));
    Y.applyUpdate(clone, update);
    const resultingLength = clone.getText(ARTIFACT_TEXT_KEY).length;
    clone.destroy();

    if (resultingLength > ARTIFACT_CONTENT_LIMIT) {
      // Reject; prior content is preserved because we never mutated entry.doc.
      return { ok: false, reason: "SIZE_LIMIT" };
    }

    // Remember prior metadata so we can revert on a persist failure.
    const prevEditorId = entry.lastEditorId;
    const prevEditedAt = entry.lastEditedAt;

    // --- Commit to the authoritative doc, tagging the origin with the editor ---
    Y.applyUpdate(entry.doc, update, editorId);
    entry.lastEditorId = editorId;
    entry.lastEditedAt = this.now();

    const content = entry.doc.getText(ARTIFACT_TEXT_KEY).toString();
    const yjsState = Y.encodeStateAsUpdate(entry.doc);
    const snapshot: ArtifactSnapshot = {
      id: entry.artifactId,
      workspaceId,
      artifactType: entry.artifactType,
      content,
      lastEditorId: entry.lastEditorId,
      lastEditedAt: entry.lastEditedAt,
      yjsState,
    };

    // --- Persist before treating the edit as committed (persist-before-broadcast) ---
    try {
      await this.store.saveArtifactSnapshot(snapshot);
    } catch {
      // Revert to the last successfully persisted state (Requirement 8.4).
      this.revert(entry, prevEditorId, prevEditedAt);
      return { ok: false, reason: "PERSIST_FAILED" };
    }

    entry.lastPersistedState = yjsState;
    return { ok: true, length: content.length };
  }

  /**
   * Apply an agent's FULL proposed artifact content as a single transaction
   * tagged with the agent's id, mirroring {@link applyUpdate}'s size guard and
   * persist-before-broadcast semantics (Requirements 5.2, 6.4, 6.5, 8.3, 8.4).
   *
   * The proposed content replaces the current content inside one transaction
   * whose origin is `agentId`, so a matching {@link snapshotOrigin} /
   * {@link rollbackOrigin} pair can cleanly revert exactly this edit (and only
   * this edit) on a later failure without discarding concurrent human edits
   * (Requirement 5.4). The size guard is checked on the proposed content length
   * before any mutation, so an over-limit proposal leaves the prior content
   * untouched. On a persist failure the document is reverted to the last
   * successfully persisted state.
   *
   * Returns the resulting length and the incremental Yjs update (encoded
   * against the pre-edit state vector) for broadcast.
   */
  async applyProposedContent(
    workspaceId: string,
    content: string,
    agentId: string,
  ): Promise<ArtifactProposeResult> {
    const entry = await this.getEntry(workspaceId);

    // Size guard on the proposed content BEFORE mutating (Requirement 6.5).
    if (content.length > ARTIFACT_CONTENT_LIMIT) {
      return { ok: false, reason: "SIZE_LIMIT" };
    }

    const prevEditorId = entry.lastEditorId;
    const prevEditedAt = entry.lastEditedAt;
    // State vector before the edit so we can compute the incremental update.
    const stateBefore = Y.encodeStateVector(entry.doc);

    const text = entry.doc.getText(ARTIFACT_TEXT_KEY);
    // Replace the whole content inside ONE transaction tagged with the agent id
    // so the scoped Y.UndoManager (see snapshotOrigin) captures exactly this
    // edit as a discrete, revertible step.
    entry.doc.transact(() => {
      if (text.length > 0) text.delete(0, text.length);
      if (content.length > 0) text.insert(0, content);
    }, agentId);

    entry.lastEditorId = agentId;
    entry.lastEditedAt = this.now();

    const newContent = text.toString();
    const yjsState = Y.encodeStateAsUpdate(entry.doc);
    const update = Y.encodeStateAsUpdate(entry.doc, stateBefore);
    const snapshot: ArtifactSnapshot = {
      id: entry.artifactId,
      workspaceId,
      artifactType: entry.artifactType,
      content: newContent,
      lastEditorId: entry.lastEditorId,
      lastEditedAt: entry.lastEditedAt,
      yjsState,
    };

    // Persist before treating the edit as committed (persist-before-broadcast).
    try {
      await this.store.saveArtifactSnapshot(snapshot);
    } catch {
      // Revert to the last successfully persisted state (Requirement 8.4). This
      // also discards the just-applied tagged transaction.
      this.revert(entry, prevEditorId, prevEditedAt);
      return { ok: false, reason: "PERSIST_FAILED" };
    }

    entry.lastPersistedState = yjsState;
    return { ok: true, length: newContent.length, update };
  }

  /** Current authoritative artifact content, or "" if not loaded. */
  getContent(workspaceId: string): string {
    const entry = this.registry.get(workspaceId);
    return entry ? entry.doc.getText(ARTIFACT_TEXT_KEY).toString() : "";
  }

  /** The artifact type for a loaded workspace, or null if not loaded. */
  getArtifactType(workspaceId: string): ArtifactType | null {
    return this.registry.get(workspaceId)?.artifactType ?? null;
  }

  /** The identity and timestamp of the last applied change, if any. */
  getLastEditor(workspaceId: string): { editorId: string | null; editedAt: number | null } {
    const entry = this.registry.get(workspaceId);
    return {
      editorId: entry?.lastEditorId ?? null,
      editedAt: entry?.lastEditedAt ?? null,
    };
  }

  /**
   * Checkpoint the document for a given `origin` (an agent id) so the edits that
   * agent commits afterwards can be cleanly rolled back without discarding
   * concurrent human edits (Requirements 5.4, 6.7).
   *
   * A `Y.UndoManager` scoped to `origin` is attached to the workspace's
   * `Y.Text`. It tracks ONLY transactions whose origin equals `origin` — which
   * is exactly the value {@link applyUpdate} passes to `Y.applyUpdate` as the
   * transaction origin (the `editorId`). `captureTimeout: 0` makes every applied
   * update a discrete undo step. The manager's stack is cleared so rollback only
   * ever reverts operations committed after this checkpoint.
   *
   * The workspace must already be loaded (e.g. via {@link ensureLoaded} or a
   * prior {@link applyUpdate}); this method is synchronous by design so the room
   * manager can checkpoint immediately before invoking an agent.
   */
  snapshotOrigin(workspaceId: string, origin: string): void {
    const entry = this.getLoadedEntry(workspaceId);

    // Replace any prior manager for this origin so the checkpoint starts fresh.
    const previous = entry.undoManagers.get(origin);
    if (previous) previous.destroy();

    const text = entry.doc.getText(ARTIFACT_TEXT_KEY);
    const undoManager = new Y.UndoManager(text, {
      trackedOrigins: new Set<string>([origin]),
      captureTimeout: 0,
    });
    // A fresh manager starts empty, but clear() makes the checkpoint explicit
    // and guards against reuse of a recycled instance.
    undoManager.clear();
    entry.undoManagers.set(origin, undoManager);
  }

  /**
   * Undo only the operations tagged with `origin` since the matching
   * {@link snapshotOrigin}, reverting the agent's edits while leaving concurrent
   * edits from other origins intact (Requirements 5.4, 6.7).
   *
   * Because CRDT operations from other origins are never tracked by the scoped
   * `Y.UndoManager`, undoing the agent's stack cannot drop a committed human
   * edit — it only removes/inverts the agent's own operations. The reverted
   * content is left in the authoritative in-memory doc; the room manager
   * (task 10.2) is responsible for persisting the resulting snapshot so it stays
   * consistent with durable storage.
   *
   * If no checkpoint exists for `origin` (e.g. the agent committed nothing, or
   * snapshotting never happened on an error path), this is a no-op.
   */
  rollbackOrigin(workspaceId: string, origin: string): void {
    const entry = this.getLoadedEntry(workspaceId);
    const undoManager = entry.undoManagers.get(origin);
    if (!undoManager) return;

    // Revert every discrete step captured since the checkpoint.
    while (undoManager.canUndo()) {
      undoManager.undo();
    }

    // The checkpoint is spent; detach the manager so it stops observing.
    undoManager.destroy();
    entry.undoManagers.delete(origin);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Lazily load (or return the cached) authoritative document for a workspace. */
  private async getEntry(workspaceId: string): Promise<ArtifactEntry> {
    const existing = this.registry.get(workspaceId);
    if (existing) return existing;

    const snapshot = await this.store.loadArtifact(workspaceId);
    if (!snapshot) {
      throw new Error(`no artifact snapshot for workspace ${workspaceId}`);
    }

    const doc = new Y.Doc();
    if (snapshot.yjsState.length > 0) {
      Y.applyUpdate(doc, snapshot.yjsState);
    }

    const entry: ArtifactEntry = {
      workspaceId,
      artifactId: snapshot.id,
      artifactType: snapshot.artifactType,
      doc,
      // Canonicalize the persisted state so a revert always has a valid update.
      lastPersistedState: Y.encodeStateAsUpdate(doc),
      lastEditorId: snapshot.lastEditorId,
      lastEditedAt: snapshot.lastEditedAt,
      undoManagers: new Map(),
    };
    this.registry.set(workspaceId, entry);
    return entry;
  }

  /**
   * Return the already-loaded entry for a workspace or throw. Used by the
   * synchronous origin snapshot/rollback methods, which require the room to have
   * been warmed (via {@link ensureLoaded} or a prior {@link applyUpdate}).
   */
  private getLoadedEntry(workspaceId: string): ArtifactEntry {
    const entry = this.registry.get(workspaceId);
    if (!entry) {
      throw new Error(`workspace ${workspaceId} is not loaded`);
    }
    return entry;
  }

  /** Rebuild the authoritative doc from the last persisted state and metadata. */
  private revert(
    entry: ArtifactEntry,
    prevEditorId: string | null,
    prevEditedAt: number | null,
  ): void {
    const reverted = new Y.Doc();
    Y.applyUpdate(reverted, entry.lastPersistedState);
    // Any origin checkpoints observe the doc we are about to discard; detach
    // them so they don't dangle on a destroyed doc. The persist-failure revert
    // already removes the just-applied edit, so a later rollback is a no-op.
    for (const manager of entry.undoManagers.values()) manager.destroy();
    entry.undoManagers.clear();
    entry.doc.destroy();
    entry.doc = reverted;
    entry.lastEditorId = prevEditorId;
    entry.lastEditedAt = prevEditedAt;
  }
}

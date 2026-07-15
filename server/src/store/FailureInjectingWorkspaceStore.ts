/**
 * A {@link WorkspaceStore} decorator that can force persistence failures on
 * demand, wrapping any inner store.
 *
 * It exists to exercise the System's transactional / rollback behavior:
 *  - Requirement 8.2: a failed message append is rejected and excluded from the
 *    log.
 *  - Requirement 8.4: a failed artifact persist retains the last persisted
 *    content.
 *
 * A forced failure throws BEFORE delegating to the inner store, so the inner
 * store is never mutated — the failure is indistinguishable from a real
 * pre-commit persistence error. Persistence property tests (20, 21) use this
 * over an {@link InMemoryWorkspaceStore}.
 */

import type {
  ArtifactSnapshot,
  Message,
  Participant,
  Workspace,
} from "@maw/shared";
import type { WorkspaceCreation, WorkspaceStore } from "./WorkspaceStore.js";

/** The set of store operations a failure can be injected into. */
export type StoreOperation =
  | "createWorkspace"
  | "getWorkspaceByJoinRef"
  | "workspaceExists"
  | "appendMessage"
  | "loadMessages"
  | "saveArtifactSnapshot"
  | "loadArtifact"
  | "upsertParticipant"
  | "removeParticipant"
  | "loadParticipants";

/** Error thrown when a failure is injected into a store operation. */
export class InjectedPersistenceError extends Error {
  constructor(public readonly operation: StoreOperation) {
    super(`injected persistence failure in ${operation}`);
    this.name = "InjectedPersistenceError";
  }
}

export class FailureInjectingWorkspaceStore implements WorkspaceStore {
  /** Operations that fail on every call until cleared. */
  private readonly alwaysFail = new Set<StoreOperation>();
  /** Remaining one-shot failures queued per operation. */
  private readonly failCounts = new Map<StoreOperation, number>();

  constructor(private readonly inner: WorkspaceStore) {}

  /** Force `op` to fail on every call until {@link clearFailure} is called. */
  failOn(op: StoreOperation): void {
    this.alwaysFail.add(op);
  }

  /** Force `op` to fail on the next `times` calls (default 1), then succeed. */
  failOnce(op: StoreOperation, times = 1): void {
    this.failCounts.set(op, (this.failCounts.get(op) ?? 0) + Math.max(0, times));
  }

  /** Stop forcing failures for `op` (both persistent and one-shot). */
  clearFailure(op: StoreOperation): void {
    this.alwaysFail.delete(op);
    this.failCounts.delete(op);
  }

  /** Clear all injected failures. */
  clearAll(): void {
    this.alwaysFail.clear();
    this.failCounts.clear();
  }

  /** Throw if a failure is queued/forced for `op`; otherwise consume one-shots. */
  private guard(op: StoreOperation): void {
    if (this.alwaysFail.has(op)) {
      throw new InjectedPersistenceError(op);
    }
    const remaining = this.failCounts.get(op) ?? 0;
    if (remaining > 0) {
      if (remaining === 1) {
        this.failCounts.delete(op);
      } else {
        this.failCounts.set(op, remaining - 1);
      }
      throw new InjectedPersistenceError(op);
    }
  }

  async createWorkspace(creation: WorkspaceCreation): Promise<void> {
    this.guard("createWorkspace");
    return this.inner.createWorkspace(creation);
  }

  async getWorkspaceByJoinRef(ref: string): Promise<Workspace | null> {
    this.guard("getWorkspaceByJoinRef");
    return this.inner.getWorkspaceByJoinRef(ref);
  }

  async workspaceExists(id: string): Promise<boolean> {
    this.guard("workspaceExists");
    return this.inner.workspaceExists(id);
  }

  async appendMessage(m: Message): Promise<void> {
    this.guard("appendMessage");
    return this.inner.appendMessage(m);
  }

  async loadMessages(workspaceId: string): Promise<Message[]> {
    this.guard("loadMessages");
    return this.inner.loadMessages(workspaceId);
  }

  async saveArtifactSnapshot(a: ArtifactSnapshot): Promise<void> {
    this.guard("saveArtifactSnapshot");
    return this.inner.saveArtifactSnapshot(a);
  }

  async loadArtifact(workspaceId: string): Promise<ArtifactSnapshot | null> {
    this.guard("loadArtifact");
    return this.inner.loadArtifact(workspaceId);
  }

  async upsertParticipant(
    workspaceId: string,
    p: Participant,
  ): Promise<void> {
    this.guard("upsertParticipant");
    return this.inner.upsertParticipant(workspaceId, p);
  }

  async removeParticipant(
    workspaceId: string,
    participantId: string,
  ): Promise<void> {
    this.guard("removeParticipant");
    return this.inner.removeParticipant(workspaceId, participantId);
  }

  async loadParticipants(workspaceId: string): Promise<Participant[]> {
    this.guard("loadParticipants");
    return this.inner.loadParticipants(workspaceId);
  }
}

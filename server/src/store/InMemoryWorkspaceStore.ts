/**
 * In-memory {@link WorkspaceStore} for tests and local development.
 *
 * Mirrors {@link SqliteWorkspaceStore} semantics without a database: workspace
 * creation is atomic (validated before any mutation), messages load ordered by
 * `(timestamp, sequence)`, and there is a single artifact snapshot per
 * workspace. Values are defensively copied on write and read so callers cannot
 * mutate stored state through shared references — this matters for `yjsState`
 * (a `Uint8Array`) which must round-trip unchanged.
 *
 * Used directly by persistence property tests (Properties 20 and 21), the
 * latter in combination with {@link FailureInjectingWorkspaceStore}.
 */

import type {
  ArtifactSnapshot,
  Message,
  Participant,
  SavedResultEntry,
  Workspace,
} from "@maw/shared";
import type { WorkspaceCreation, WorkspaceStore } from "./WorkspaceStore.js";

export class InMemoryWorkspaceStore implements WorkspaceStore {
  private readonly workspaces = new Map<string, Workspace>();
  private readonly joinRefIndex = new Map<string, string>();
  private readonly participants = new Map<string, Map<string, Participant>>();
  private readonly messages = new Map<string, Message[]>();
  private readonly artifacts = new Map<string, ArtifactSnapshot>();
  private readonly history = new Map<string, SavedResultEntry[]>();

  async createWorkspace(creation: WorkspaceCreation): Promise<void> {
    const { workspace, owner, artifact } = creation;

    // Validate everything before mutating so a rejected creation leaves no
    // partial rows (Requirement 1.2).
    if (this.workspaces.has(workspace.id)) {
      throw new Error(`workspace id already exists: ${workspace.id}`);
    }
    if (this.joinRefIndex.has(workspace.joinReference)) {
      throw new Error(
        `joinReference already exists: ${workspace.joinReference}`,
      );
    }

    this.workspaces.set(workspace.id, cloneWorkspace(workspace));
    this.joinRefIndex.set(workspace.joinReference, workspace.id);

    const roster = new Map<string, Participant>();
    roster.set(owner.id, cloneParticipant(owner));
    this.participants.set(workspace.id, roster);

    this.messages.set(workspace.id, []);
    this.artifacts.set(workspace.id, cloneArtifact(artifact));
  }

  async getWorkspaceByJoinRef(ref: string): Promise<Workspace | null> {
    const id = this.joinRefIndex.get(ref);
    if (id === undefined) return null;
    const ws = this.workspaces.get(id);
    return ws ? cloneWorkspace(ws) : null;
  }

  async workspaceExists(id: string): Promise<boolean> {
    return this.workspaces.has(id);
  }

  async appendMessage(m: Message): Promise<void> {
    const log = this.messages.get(m.workspaceId) ?? [];
    log.push(cloneMessage(m));
    this.messages.set(m.workspaceId, log);
  }

  async loadMessages(workspaceId: string): Promise<Message[]> {
    const log = this.messages.get(workspaceId) ?? [];
    return [...log]
      .sort((a, b) =>
        a.timestamp !== b.timestamp
          ? a.timestamp - b.timestamp
          : a.sequence - b.sequence,
      )
      .map(cloneMessage);
  }

  async saveArtifactSnapshot(a: ArtifactSnapshot): Promise<void> {
    this.artifacts.set(a.workspaceId, cloneArtifact(a));
  }

  async loadArtifact(workspaceId: string): Promise<ArtifactSnapshot | null> {
    const a = this.artifacts.get(workspaceId);
    return a ? cloneArtifact(a) : null;
  }

  async upsertParticipant(
    workspaceId: string,
    p: Participant,
  ): Promise<void> {
    const roster = this.participants.get(workspaceId) ?? new Map();
    roster.set(p.id, cloneParticipant(p));
    this.participants.set(workspaceId, roster);
  }

  async removeParticipant(
    workspaceId: string,
    participantId: string,
  ): Promise<void> {
    this.participants.get(workspaceId)?.delete(participantId);
  }

  async loadParticipants(workspaceId: string): Promise<Participant[]> {
    const roster = this.participants.get(workspaceId);
    if (roster === undefined) return [];
    return [...roster.values()].map(cloneParticipant);
  }

  async saveHistoryEntry(entry: SavedResultEntry): Promise<void> {
    const list = this.history.get(entry.workspaceId) ?? [];
    if (!list.some((e) => e.id === entry.id)) list.push({ ...entry });
    this.history.set(entry.workspaceId, list);
  }

  async loadHistory(workspaceId: string): Promise<SavedResultEntry[]> {
    const list = this.history.get(workspaceId) ?? [];
    return [...list]
      .sort((a, b) => b.savedAt - a.savedAt)
      .map((e) => ({ ...e }));
  }

  async deleteHistoryEntry(
    workspaceId: string,
    entryId: string,
  ): Promise<void> {
    const list = this.history.get(workspaceId);
    if (list) {
      this.history.set(
        workspaceId,
        list.filter((e) => e.id !== entryId),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Defensive copy helpers
// ---------------------------------------------------------------------------

function cloneWorkspace(w: Workspace): Workspace {
  return { ...w };
}

function cloneParticipant(p: Participant): Participant {
  return { ...p };
}

function cloneMessage(m: Message): Message {
  return { ...m };
}

function cloneArtifact(a: ArtifactSnapshot): ArtifactSnapshot {
  return { ...a, yjsState: new Uint8Array(a.yjsState) };
}

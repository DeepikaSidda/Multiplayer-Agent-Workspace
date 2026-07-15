import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { ARTIFACT_CONTENT_LIMIT, type ArtifactSnapshot } from "@maw/shared";
import {
  InMemoryWorkspaceStore,
  FailureInjectingWorkspaceStore,
} from "../store/index.js";
import { ArtifactService, ARTIFACT_TEXT_KEY } from "./ArtifactService.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WORKSPACE_ID = "ws-1";
const ARTIFACT_ID = "art-1";

/** A fresh empty artifact snapshot for the workspace under test. */
function emptyArtifact(): ArtifactSnapshot {
  const doc = new Y.Doc();
  return {
    id: ARTIFACT_ID,
    workspaceId: WORKSPACE_ID,
    artifactType: "plan",
    content: "",
    lastEditorId: null,
    lastEditedAt: null,
    yjsState: Y.encodeStateAsUpdate(doc),
  };
}

/** A local Yjs client used to generate incoming updates for the service. */
class Client {
  readonly doc = new Y.Doc();
  private get text(): Y.Text {
    return this.doc.getText(ARTIFACT_TEXT_KEY);
  }
  /** Insert text and return the full encoded state as the update to send. */
  edit(fn: (t: Y.Text) => void): Uint8Array {
    fn(this.text);
    return Y.encodeStateAsUpdate(this.doc);
  }
  get length(): number {
    return this.text.length;
  }
}

async function seededStore(): Promise<InMemoryWorkspaceStore> {
  const store = new InMemoryWorkspaceStore();
  await store.createWorkspace({
    workspace: {
      id: WORKSPACE_ID,
      joinReference: "join-abc",
      ownerId: "p-owner",
      artifactId: ARTIFACT_ID,
      createdAt: 1_000,
    },
    owner: {
      id: "p-owner",
      workspaceId: WORKSPACE_ID,
      type: "human",
      displayName: "Owner",
      joinedAt: 1_000,
      presenceState: "active",
    },
    artifact: emptyArtifact(),
  });
  return store;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ArtifactService", () => {
  it("applies a valid edit, records metadata, and persists the snapshot", async () => {
    const store = await seededStore();
    let clock = 5_000;
    const service = new ArtifactService(store, { now: () => clock });

    const client = new Client();
    const update = client.edit((t) => t.insert(0, "Hello, team"));

    const result = await service.applyUpdate(WORKSPACE_ID, update, "p-owner");

    expect(result).toEqual({ ok: true, length: "Hello, team".length });
    expect(service.getContent(WORKSPACE_ID)).toBe("Hello, team");
    expect(service.getLastEditor(WORKSPACE_ID)).toEqual({
      editorId: "p-owner",
      editedAt: 5_000,
    });

    // Persisted snapshot reflects the applied content and editor metadata.
    const persisted = await store.loadArtifact(WORKSPACE_ID);
    expect(persisted?.content).toBe("Hello, team");
    expect(persisted?.lastEditorId).toBe("p-owner");
    expect(persisted?.lastEditedAt).toBe(5_000);
    expect(persisted!.yjsState.length).toBeGreaterThan(0);
  });

  it("applies edits from multiple editors and records the latest editor", async () => {
    const store = await seededStore();
    const service = new ArtifactService(store);

    const client = new Client();
    await service.applyUpdate(WORKSPACE_ID, client.edit((t) => t.insert(0, "abc")), "human-1");
    await service.applyUpdate(WORKSPACE_ID, client.edit((t) => t.insert(3, "def")), "agent-1");

    expect(service.getContent(WORKSPACE_ID)).toBe("abcdef");
    expect(service.getLastEditor(WORKSPACE_ID).editorId).toBe("agent-1");
  });

  it("applies an edit resulting in exactly 100,000 characters", async () => {
    const store = await seededStore();
    const service = new ArtifactService(store);

    const client = new Client();
    const atLimit = "a".repeat(ARTIFACT_CONTENT_LIMIT);
    const result = await service.applyUpdate(
      WORKSPACE_ID,
      client.edit((t) => t.insert(0, atLimit)),
      "p-owner",
    );

    expect(result).toEqual({ ok: true, length: ARTIFACT_CONTENT_LIMIT });
    expect(service.getContent(WORKSPACE_ID).length).toBe(ARTIFACT_CONTENT_LIMIT);
  });

  it("rejects an over-limit edit with SIZE_LIMIT and preserves prior content", async () => {
    const store = await seededStore();
    const service = new ArtifactService(store);

    // First, establish some valid content.
    const client = new Client();
    await service.applyUpdate(WORKSPACE_ID, client.edit((t) => t.insert(0, "keep-me")), "p-owner");

    // Now attempt an edit that pushes the document past the limit.
    const overflow = "x".repeat(ARTIFACT_CONTENT_LIMIT);
    const result = await service.applyUpdate(
      WORKSPACE_ID,
      client.edit((t) => t.insert(t.length, overflow)),
      "p-owner",
    );

    expect(result).toEqual({ ok: false, reason: "SIZE_LIMIT" });
    // Prior content is preserved and never exceeds the limit.
    expect(service.getContent(WORKSPACE_ID)).toBe("keep-me");

    // The persisted snapshot is likewise unchanged.
    const persisted = await store.loadArtifact(WORKSPACE_ID);
    expect(persisted?.content).toBe("keep-me");
    expect(persisted!.content.length).toBeLessThanOrEqual(ARTIFACT_CONTENT_LIMIT);
  });

  it("reverts to the last persisted state and returns PERSIST_FAILED on persist failure", async () => {
    const inner = await seededStore();
    const store = new FailureInjectingWorkspaceStore(inner);
    const service = new ArtifactService(store);

    // A first successful edit becomes the last persisted state.
    const client = new Client();
    await service.applyUpdate(WORKSPACE_ID, client.edit((t) => t.insert(0, "committed")), "human-1");
    expect(service.getContent(WORKSPACE_ID)).toBe("committed");

    // Force the next persist to fail.
    store.failOn("saveArtifactSnapshot");
    const result = await service.applyUpdate(
      WORKSPACE_ID,
      client.edit((t) => t.insert(t.length, " and more")),
      "human-2",
    );

    expect(result).toEqual({ ok: false, reason: "PERSIST_FAILED" });
    // Document reverted to the last persisted content and editor metadata.
    expect(service.getContent(WORKSPACE_ID)).toBe("committed");
    expect(service.getLastEditor(WORKSPACE_ID).editorId).toBe("human-1");
    // The persisted snapshot still holds only the committed content.
    expect((await inner.loadArtifact(WORKSPACE_ID))?.content).toBe("committed");

    // After recovery, a subsequent edit applies cleanly on top of the reverted state.
    // Reuse the same client (its local doc shares history with the authoritative
    // doc) so the edit is a genuine incremental CRDT update.
    store.clearFailure("saveArtifactSnapshot");
    const ok = await service.applyUpdate(
      WORKSPACE_ID,
      client.edit((t) => t.insert(t.length, "!")),
      "human-3",
    );
    expect(ok.ok).toBe(true);
    expect(service.getLastEditor(WORKSPACE_ID).editorId).toBe("human-3");
  });

  it("getContent returns empty string for an unloaded workspace", () => {
    const store = new InMemoryWorkspaceStore();
    const service = new ArtifactService(store);
    expect(service.getContent("unknown")).toBe("");
  });

  it("throws when applying to a workspace with no persisted artifact", async () => {
    const store = new InMemoryWorkspaceStore();
    const service = new ArtifactService(store);
    const client = new Client();
    await expect(
      service.applyUpdate("missing", client.edit((t) => t.insert(0, "x")), "p"),
    ).rejects.toThrow();
  });

  describe("origin-tagged snapshot / rollback (task 7.2)", () => {
    /** Fork a client synced to the workspace's currently persisted CRDT state. */
    async function clientFromStore(store: InMemoryWorkspaceStore): Promise<Client> {
      const snapshot = await store.loadArtifact(WORKSPACE_ID);
      const client = new Client();
      if (snapshot && snapshot.yjsState.length > 0) {
        Y.applyUpdate(client.doc, snapshot.yjsState);
      }
      return client;
    }

    it("rolls back only the agent's edits while preserving concurrent human edits", async () => {
      const store = await seededStore();
      const service = new ArtifactService(store);

      // Base content committed by the owner.
      const base = new Client();
      await service.applyUpdate(WORKSPACE_ID, base.edit((t) => t.insert(0, "BASE")), "p-owner");
      expect(service.getContent(WORKSPACE_ID)).toBe("BASE");

      // Checkpoint the agent origin BEFORE it edits.
      service.snapshotOrigin(WORKSPACE_ID, "agent-1");

      // Two clients forked from the same base => genuinely concurrent edits.
      const agentClient = await clientFromStore(store);
      const humanClient = await clientFromStore(store);

      // Agent appends at the end; tagged with the agent origin.
      await service.applyUpdate(
        WORKSPACE_ID,
        agentClient.edit((t) => t.insert(t.length, " AGENT")),
        "agent-1",
      );
      // Concurrent human edit at the start; a different (untracked) origin.
      await service.applyUpdate(
        WORKSPACE_ID,
        humanClient.edit((t) => t.insert(0, "HUMAN ")),
        "human-2",
      );

      const merged = service.getContent(WORKSPACE_ID);
      expect(merged).toContain("AGENT");
      expect(merged).toContain("HUMAN");
      expect(merged).toContain("BASE");

      // Roll back only the agent's tagged transaction.
      service.rollbackOrigin(WORKSPACE_ID, "agent-1");

      const after = service.getContent(WORKSPACE_ID);
      expect(after).not.toContain("AGENT"); // agent edit reverted
      expect(after).toContain("HUMAN"); // concurrent human edit preserved
      expect(after).toContain("BASE"); // pre-generation content preserved
    });

    it("restores the pre-generation content when only the agent edited", async () => {
      const store = await seededStore();
      const service = new ArtifactService(store);

      const base = new Client();
      await service.applyUpdate(WORKSPACE_ID, base.edit((t) => t.insert(0, "Draft")), "p-owner");

      service.snapshotOrigin(WORKSPACE_ID, "agent-x");

      // Multiple discrete agent edits after the checkpoint.
      const agent = await clientFromStore(store);
      await service.applyUpdate(WORKSPACE_ID, agent.edit((t) => t.insert(t.length, " one")), "agent-x");
      await service.applyUpdate(WORKSPACE_ID, agent.edit((t) => t.insert(t.length, " two")), "agent-x");
      expect(service.getContent(WORKSPACE_ID)).toBe("Draft one two");

      service.rollbackOrigin(WORKSPACE_ID, "agent-x");
      expect(service.getContent(WORKSPACE_ID)).toBe("Draft");
    });

    it("does not revert edits committed before the checkpoint", async () => {
      const store = await seededStore();
      const service = new ArtifactService(store);

      // Agent edits BEFORE the checkpoint should survive a rollback.
      const before = new Client();
      await service.applyUpdate(WORKSPACE_ID, before.edit((t) => t.insert(0, "kept")), "agent-1");

      service.snapshotOrigin(WORKSPACE_ID, "agent-1");

      const after = await clientFromStore(store);
      await service.applyUpdate(WORKSPACE_ID, after.edit((t) => t.insert(t.length, "-undone")), "agent-1");
      expect(service.getContent(WORKSPACE_ID)).toBe("kept-undone");

      service.rollbackOrigin(WORKSPACE_ID, "agent-1");
      expect(service.getContent(WORKSPACE_ID)).toBe("kept");
    });

    it("rollback with no checkpoint (or no agent edits) is a no-op", async () => {
      const store = await seededStore();
      const service = new ArtifactService(store);
      await service.ensureLoaded(WORKSPACE_ID);

      const base = new Client();
      await service.applyUpdate(WORKSPACE_ID, base.edit((t) => t.insert(0, "content")), "p-owner");

      // No checkpoint was taken for this origin.
      expect(() => service.rollbackOrigin(WORKSPACE_ID, "agent-none")).not.toThrow();
      expect(service.getContent(WORKSPACE_ID)).toBe("content");

      // Checkpoint but no agent edits => rollback changes nothing.
      service.snapshotOrigin(WORKSPACE_ID, "agent-idle");
      service.rollbackOrigin(WORKSPACE_ID, "agent-idle");
      expect(service.getContent(WORKSPACE_ID)).toBe("content");
    });

    it("snapshotOrigin throws when the workspace is not loaded", () => {
      const store = new InMemoryWorkspaceStore();
      const service = new ArtifactService(store);
      expect(() => service.snapshotOrigin(WORKSPACE_ID, "agent-1")).toThrow();
    });
  });
});

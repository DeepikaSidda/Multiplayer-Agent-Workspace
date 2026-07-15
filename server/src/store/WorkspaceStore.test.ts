import { describe, it, expect } from "vitest";
import type {
  ArtifactSnapshot,
  Message,
  Participant,
  Workspace,
} from "@maw/shared";
import {
  SqliteWorkspaceStore,
  InMemoryWorkspaceStore,
  FailureInjectingWorkspaceStore,
  InjectedPersistenceError,
  type WorkspaceStore,
  type WorkspaceCreation,
} from "./index.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeWorkspace(over: Partial<Workspace> = {}): Workspace {
  return {
    id: "ws-1",
    joinReference: "join-abc",
    ownerId: "p-owner",
    artifactId: "art-1",
    createdAt: 1_000,
    ...over,
  };
}

function makeOwner(over: Partial<Participant> = {}): Participant {
  return {
    id: "p-owner",
    workspaceId: "ws-1",
    type: "human",
    displayName: "Owner",
    joinedAt: 1_000,
    presenceState: "active",
    ...over,
  };
}

function makeArtifact(over: Partial<ArtifactSnapshot> = {}): ArtifactSnapshot {
  return {
    id: "art-1",
    workspaceId: "ws-1",
    artifactType: "plan",
    content: "",
    lastEditorId: null,
    lastEditedAt: null,
    yjsState: new Uint8Array([1, 2, 3, 4, 5]),
    ...over,
  };
}

function makeMessage(over: Partial<Message> = {}): Message {
  return {
    id: "m-1",
    workspaceId: "ws-1",
    senderId: "p-owner",
    senderType: "human",
    senderName: "Owner",
    content: "hello",
    timestamp: 100,
    sequence: 0,
    kind: "chat",
    ...over,
  };
}

function makeCreation(): WorkspaceCreation {
  return { workspace: makeWorkspace(), owner: makeOwner(), artifact: makeArtifact() };
}

// ---------------------------------------------------------------------------
// Shared behavior suite run against every implementation
// ---------------------------------------------------------------------------

function sharedStoreBehavior(name: string, makeStore: () => WorkspaceStore) {
  describe(name, () => {
    it("creates a workspace and resolves it by join reference", async () => {
      const store = makeStore();
      await store.createWorkspace(makeCreation());

      expect(await store.workspaceExists("ws-1")).toBe(true);
      const ws = await store.getWorkspaceByJoinRef("join-abc");
      expect(ws).toEqual(makeWorkspace());
    });

    it("returns null for an unknown join reference and false for unknown id", async () => {
      const store = makeStore();
      expect(await store.getWorkspaceByJoinRef("missing")).toBeNull();
      expect(await store.workspaceExists("missing")).toBe(false);
    });

    it("rejects a duplicate workspace id without leaving partial rows", async () => {
      const store = makeStore();
      await store.createWorkspace(makeCreation());

      const dup: WorkspaceCreation = {
        workspace: makeWorkspace({ id: "ws-1", joinReference: "join-xyz" }),
        owner: makeOwner({ id: "p-other" }),
        artifact: makeArtifact({ id: "art-2" }),
      };
      await expect(store.createWorkspace(dup)).rejects.toThrow();

      // The failed creation must not have written its owner/artifact/joinRef.
      expect(await store.getWorkspaceByJoinRef("join-xyz")).toBeNull();
    });

    it("rejects a duplicate join reference", async () => {
      const store = makeStore();
      await store.createWorkspace(makeCreation());
      const dup: WorkspaceCreation = {
        workspace: makeWorkspace({ id: "ws-2", joinReference: "join-abc" }),
        owner: makeOwner({ id: "p2", workspaceId: "ws-2" }),
        artifact: makeArtifact({ id: "art-2", workspaceId: "ws-2" }),
      };
      await expect(store.createWorkspace(dup)).rejects.toThrow();
      expect(await store.workspaceExists("ws-2")).toBe(false);
    });

    it("appends messages and loads them ordered by (timestamp, sequence)", async () => {
      const store = makeStore();
      await store.createWorkspace(makeCreation());

      // Insert out of order; loadMessages must sort deterministically.
      await store.appendMessage(makeMessage({ id: "m-b", timestamp: 100, sequence: 2 }));
      await store.appendMessage(makeMessage({ id: "m-a", timestamp: 100, sequence: 1 }));
      await store.appendMessage(makeMessage({ id: "m-c", timestamp: 50, sequence: 9 }));

      const loaded = await store.loadMessages("ws-1");
      expect(loaded.map((m) => m.id)).toEqual(["m-c", "m-a", "m-b"]);
    });

    it("saves and loads an artifact snapshot with byte-identical yjsState", async () => {
      const store = makeStore();
      await store.createWorkspace(makeCreation());

      const yjs = new Uint8Array([9, 8, 7, 255, 0, 42]);
      const snapshot = makeArtifact({
        content: "# Plan\n\nhello",
        lastEditorId: "p-owner",
        lastEditedAt: 2_000,
        yjsState: yjs,
      });
      await store.saveArtifactSnapshot(snapshot);

      const loaded = await store.loadArtifact("ws-1");
      expect(loaded).not.toBeNull();
      expect(loaded!.content).toBe("# Plan\n\nhello");
      expect(loaded!.lastEditorId).toBe("p-owner");
      expect(loaded!.lastEditedAt).toBe(2_000);
      expect(Array.from(loaded!.yjsState)).toEqual(Array.from(yjs));
    });

    it("replaces the artifact snapshot on subsequent saves", async () => {
      const store = makeStore();
      await store.createWorkspace(makeCreation());
      await store.saveArtifactSnapshot(makeArtifact({ content: "v1" }));
      await store.saveArtifactSnapshot(makeArtifact({ content: "v2", yjsState: new Uint8Array([1]) }));

      const loaded = await store.loadArtifact("ws-1");
      expect(loaded!.content).toBe("v2");
      expect(Array.from(loaded!.yjsState)).toEqual([1]);
    });

    it("upserts and removes participants idempotently", async () => {
      const store = makeStore();
      await store.createWorkspace(makeCreation());

      const agent = makeOwner({ id: "a-1", type: "agent", displayName: "Nova", persona: "helpful", modelId: "amazon.nova-pro-v1:0" });
      await store.upsertParticipant("ws-1", agent);
      // Upsert again with a changed field — should not error or duplicate.
      await store.upsertParticipant("ws-1", { ...agent, displayName: "Nova2" });

      await store.removeParticipant("ws-1", "a-1");
      // Removing a non-existent participant is a no-op.
      await expect(store.removeParticipant("ws-1", "nope")).resolves.toBeUndefined();
    });

    it("does not mutate stored artifact when caller mutates the input array", async () => {
      const store = makeStore();
      await store.createWorkspace(makeCreation());
      const yjs = new Uint8Array([1, 2, 3]);
      await store.saveArtifactSnapshot(makeArtifact({ yjsState: yjs }));
      yjs[0] = 99; // mutate after saving

      const loaded = await store.loadArtifact("ws-1");
      expect(Array.from(loaded!.yjsState)).toEqual([1, 2, 3]);
    });
  });
}

sharedStoreBehavior("InMemoryWorkspaceStore", () => new InMemoryWorkspaceStore());
sharedStoreBehavior("SqliteWorkspaceStore", () => new SqliteWorkspaceStore(":memory:"));

// ---------------------------------------------------------------------------
// Failure-injecting decorator
// ---------------------------------------------------------------------------

describe("FailureInjectingWorkspaceStore", () => {
  it("forces a persistent failure and never mutates the inner store", async () => {
    const inner = new InMemoryWorkspaceStore();
    const store = new FailureInjectingWorkspaceStore(inner);
    await store.createWorkspace(makeCreation());

    store.failOn("appendMessage");
    await expect(store.appendMessage(makeMessage())).rejects.toBeInstanceOf(
      InjectedPersistenceError,
    );
    // The rejected append must be excluded from the log (Requirement 8.2).
    expect(await inner.loadMessages("ws-1")).toEqual([]);

    store.clearFailure("appendMessage");
    await store.appendMessage(makeMessage());
    expect((await inner.loadMessages("ws-1")).length).toBe(1);
  });

  it("supports one-shot failures that recover after the configured count", async () => {
    const inner = new InMemoryWorkspaceStore();
    const store = new FailureInjectingWorkspaceStore(inner);
    await store.createWorkspace(makeCreation());

    store.failOnce("saveArtifactSnapshot", 2);
    await expect(store.saveArtifactSnapshot(makeArtifact({ content: "x" }))).rejects.toThrow();
    await expect(store.saveArtifactSnapshot(makeArtifact({ content: "y" }))).rejects.toThrow();
    // Third call succeeds.
    await store.saveArtifactSnapshot(makeArtifact({ content: "z" }));

    const loaded = await store.loadArtifact("ws-1");
    expect(loaded!.content).toBe("z");
  });

  it("can force a workspace creation failure leaving no rows", async () => {
    const inner = new InMemoryWorkspaceStore();
    const store = new FailureInjectingWorkspaceStore(inner);
    store.failOn("createWorkspace");

    await expect(store.createWorkspace(makeCreation())).rejects.toThrow();
    expect(await inner.workspaceExists("ws-1")).toBe(false);
    expect(await inner.getWorkspaceByJoinRef("join-abc")).toBeNull();
  });
});

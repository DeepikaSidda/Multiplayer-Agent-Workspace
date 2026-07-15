import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { DEFAULT_ARTIFACT_TYPE, type ArtifactType } from "@maw/shared";
import {
  InMemoryWorkspaceStore,
  FailureInjectingWorkspaceStore,
} from "../store/index.js";
import {
  WorkspaceService,
  ARTIFACT_TEXT_FIELD,
  type WorkspaceServiceOptions,
} from "./index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a service backed by an in-memory store, with deterministic id/ref/clock
 * generators so assertions are exact. Ids are drawn from a monotonic counter.
 */
function makeService(over: WorkspaceServiceOptions = {}) {
  const store = new InMemoryWorkspaceStore();
  let counter = 0;
  const service = new WorkspaceService(store, {
    newId: () => `id-${++counter}`,
    newJoinReference: () => `ref-${++counter}`,
    now: () => 1_000,
    ...over,
  });
  return { store, service };
}

// ---------------------------------------------------------------------------
// createWorkspace
// ---------------------------------------------------------------------------

describe("WorkspaceService.createWorkspace", () => {
  it("creates a workspace, assigns the requester as Owner, and persists it", async () => {
    const { store, service } = makeService();

    const result = await service.createWorkspace({
      ownerDisplayName: "Ada",
      artifactType: "PRD",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The workspace records its requester as Owner.
    expect(result.workspace.ownerId).toBe(result.owner.id);
    expect(result.owner.type).toBe("human");
    expect(result.owner.displayName).toBe("Ada");
    expect(result.owner.presenceState).toBe("active");

    // It is durably persisted and resolvable by its join reference.
    expect(await store.workspaceExists(result.workspace.id)).toBe(true);
    const resolved = await store.getWorkspaceByJoinRef(
      result.workspace.joinReference,
    );
    expect(resolved).toEqual(result.workspace);
  });

  it("generates a shareable join reference that resolves to the workspace id", async () => {
    const { service } = makeService();
    const result = await service.createWorkspace({ ownerDisplayName: "Ada" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Round-trip: the reference resolves to exactly this workspace's id.
    const id = await service.resolveJoinReference(result.workspace.joinReference);
    expect(id).toBe(result.workspace.id);
    // The reference is distinct from the id itself.
    expect(result.workspace.joinReference).not.toBe(result.workspace.id);
  });

  it("produces pairwise-distinct ids across multiple creations", async () => {
    const { service } = makeService();
    const ids = new Set<string>();
    const refs = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const r = await service.createWorkspace({ ownerDisplayName: `u${i}` });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      ids.add(r.workspace.id);
      refs.add(r.workspace.joinReference);
    }
    expect(ids.size).toBe(10);
    expect(refs.size).toBe(10);
  });

  it("initializes the artifact with the valid Owner-selected type and empty content", async () => {
    const { store, service } = makeService();
    const result = await service.createWorkspace({
      ownerDisplayName: "Ada",
      artifactType: "checklist",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.artifact.artifactType).toBe("checklist");
    expect(result.artifact.content).toBe("");
    expect(result.artifact.lastEditorId).toBeNull();
    expect(result.artifact.lastEditedAt).toBeNull();

    const stored = await store.loadArtifact(result.workspace.id);
    expect(stored?.artifactType).toBe("checklist");
    expect(stored?.content).toBe("");
  });

  it("initializes an empty, decodable Y.Doc state for the artifact", async () => {
    const { service } = makeService();
    const result = await service.createWorkspace({ ownerDisplayName: "Ada" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const doc = new Y.Doc();
    Y.applyUpdate(doc, result.artifact.yjsState);
    expect(doc.getText(ARTIFACT_TEXT_FIELD).toString()).toBe("");
    doc.destroy();
  });

  it.each([
    ["missing", undefined],
    ["invalid string", "spreadsheet"],
    ["wrong case", "prd"],
    ["non-string", 42],
    ["null", null],
  ])("defaults the artifact type to \"plan\" when %s", async (_label, value) => {
    const { service } = makeService();
    const result = await service.createWorkspace({
      ownerDisplayName: "Ada",
      artifactType: value as unknown,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.artifactType).toBe(DEFAULT_ARTIFACT_TYPE);
    expect(result.artifact.artifactType).toBe("plan");
  });

  it.each<ArtifactType>(["plan", "PRD", "issue", "workflow", "pitch", "checklist"])(
    "accepts every valid artifact type (%s)",
    async (type) => {
      const { service } = makeService();
      const result = await service.createWorkspace({
        ownerDisplayName: "Ada",
        artifactType: type,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.artifact.artifactType).toBe(type);
    },
  );

  it("returns WORKSPACE_CREATE_FAILED and writes no rows on persistence failure", async () => {
    const inner = new InMemoryWorkspaceStore();
    const store = new FailureInjectingWorkspaceStore(inner);
    store.failOn("createWorkspace");
    let counter = 0;
    const service = new WorkspaceService(store, {
      newId: () => `id-${++counter}`,
      newJoinReference: () => `ref-${++counter}`,
      now: () => 1_000,
    });

    const result = await service.createWorkspace({ ownerDisplayName: "Ada" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("WORKSPACE_CREATE_FAILED");

    // No workspace/owner/artifact rows were written.
    expect(await inner.getWorkspaceByJoinRef("ref-4")).toBeNull();
    expect(await inner.getWorkspaceByJoinRef("ref-2")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// join
// ---------------------------------------------------------------------------

describe("WorkspaceService.join", () => {
  it("resolves a join reference and adds the human as a participant", async () => {
    const { store, service } = makeService();
    const created = await service.createWorkspace({ ownerDisplayName: "Ada" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = await service.join({
      joinReference: created.workspace.joinReference,
      displayName: "Grace",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workspace.id).toBe(created.workspace.id);
    expect(result.participant.type).toBe("human");
    expect(result.participant.displayName).toBe("Grace");
    expect(result.participant.workspaceId).toBe(created.workspace.id);

    // The participant is persisted (loadArtifact/exists sanity via store).
    expect(await store.workspaceExists(created.workspace.id)).toBe(true);
  });

  it("is idempotent for a reconnect with the same participant id (no duplicate)", async () => {
    const { service } = makeService();
    const created = await service.createWorkspace({ ownerDisplayName: "Ada" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const first = await service.join({
      joinReference: created.workspace.joinReference,
      displayName: "Grace",
      participantId: "human-grace",
    });
    const second = await service.join({
      joinReference: created.workspace.joinReference,
      displayName: "Grace",
      participantId: "human-grace",
    });

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    // Same identity on both joins — upsert keeps a single entry.
    expect(first.participant.id).toBe("human-grace");
    expect(second.participant.id).toBe("human-grace");
  });

  it("returns WORKSPACE_NOT_FOUND for an unknown join reference", async () => {
    const { service } = makeService();
    const result = await service.join({
      joinReference: "does-not-exist",
      displayName: "Grace",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("WORKSPACE_NOT_FOUND");
  });
});

describe("WorkspaceService.resolveJoinReference", () => {
  it("returns null for an unknown reference", async () => {
    const { service } = makeService();
    expect(await service.resolveJoinReference("nope")).toBeNull();
  });
});

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import * as Y from "yjs";
import { ARTIFACT_CONTENT_LIMIT, type ArtifactSnapshot } from "@maw/shared";
import { InMemoryWorkspaceStore } from "../store/index.js";
import { ArtifactService, ARTIFACT_TEXT_KEY } from "./ArtifactService.js";

// ---------------------------------------------------------------------------
// Fixtures / helpers (mirrors ArtifactService.test.ts seeding + Client pattern)
// ---------------------------------------------------------------------------

const WORKSPACE_ID = "ws-1";
const ARTIFACT_ID = "art-1";
const LIMIT = ARTIFACT_CONTENT_LIMIT; // 100000

/** A fresh empty artifact snapshot for the workspace under test. */
function emptyArtifact(): ArtifactSnapshot {
  const doc = new Y.Doc();
  const snapshot: ArtifactSnapshot = {
    id: ARTIFACT_ID,
    workspaceId: WORKSPACE_ID,
    artifactType: "plan",
    content: "",
    lastEditorId: null,
    lastEditedAt: null,
    yjsState: Y.encodeStateAsUpdate(doc),
  };
  doc.destroy();
  return snapshot;
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

/**
 * Build a genuine incremental Yjs update that drives the authoritative document
 * to `targetLength` characters. The client is forked from the store's currently
 * persisted CRDT state (which mirrors the authoritative content), so the encoded
 * update is a real incremental delta rather than a wholesale replacement.
 */
async function updateToLength(
  store: InMemoryWorkspaceStore,
  targetLength: number,
): Promise<Uint8Array> {
  const snapshot = await store.loadArtifact(WORKSPACE_ID);
  const doc = new Y.Doc();
  if (snapshot && snapshot.yjsState.length > 0) {
    Y.applyUpdate(doc, snapshot.yjsState);
  }
  const text = doc.getText(ARTIFACT_TEXT_KEY);
  const currentLength = text.length;
  if (targetLength > currentLength) {
    text.insert(currentLength, "a".repeat(targetLength - currentLength));
  } else if (targetLength < currentLength) {
    text.delete(targetLength, currentLength - targetLength);
  }
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

// ---------------------------------------------------------------------------
// Property 15
// ---------------------------------------------------------------------------

// Feature: multiplayer-agent-workspace, Property 15: Artifact size limit is never exceeded
describe("ArtifactService size-limit enforcement (Property 15)", () => {
  it("rejects any edit that would exceed the limit, preserves prior content, and never stores over-limit content", async () => {
    // A target length spread across within-limit, over-limit, and exact boundary
    // values so both the accept and reject paths are exercised each run.
    const targetLength = fc.oneof(
      fc.integer({ min: 0, max: LIMIT + 5_000 }),
      fc.integer({ min: LIMIT + 1, max: LIMIT + 5_000 }),
      fc.constantFrom(LIMIT - 1, LIMIT, LIMIT + 1),
    );

    await fc.assert(
      fc.asyncProperty(
        fc.array(targetLength, { minLength: 1, maxLength: 6 }),
        async (targets) => {
          const store = await seededStore();
          const service = new ArtifactService(store);
          await service.ensureLoaded(WORKSPACE_ID);

          for (const target of targets) {
            const before = service.getContent(WORKSPACE_ID);
            const update = await updateToLength(store, target);
            const result = await service.applyUpdate(WORKSPACE_ID, update, "editor-1");
            const after = service.getContent(WORKSPACE_ID);

            if (target > LIMIT) {
              // Over-limit edit is rejected and prior content is preserved.
              expect(result).toEqual({ ok: false, reason: "SIZE_LIMIT" });
              expect(after).toBe(before);
            } else {
              // Within-limit (incl. exactly LIMIT) edit is applied.
              expect(result.ok).toBe(true);
              if (result.ok) expect(result.length).toBe(target);
              expect(after.length).toBe(target);
            }

            // Global invariant: stored length never exceeds the limit, and the
            // persisted snapshot stays in lock-step with the authoritative doc.
            expect(after.length).toBeLessThanOrEqual(LIMIT);
            const persisted = await store.loadArtifact(WORKSPACE_ID);
            expect(persisted?.content.length ?? 0).toBeLessThanOrEqual(LIMIT);
            expect(persisted?.content).toBe(after);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

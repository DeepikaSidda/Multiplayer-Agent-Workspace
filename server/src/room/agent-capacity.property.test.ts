import { describe, it, expect } from "vitest";
import fc from "fast-check";
import * as Y from "yjs";
import {
  MAX_AGENTS_PER_WORKSPACE,
  type ArtifactSnapshot,
  type Participant,
  type Workspace,
} from "@maw/shared";
import { InMemoryWorkspaceStore } from "../store/index.js";
import { RoomManager } from "./index.js";

// Feature: multiplayer-agent-workspace, Property 9: Agent capacity is capped at five
//
// For any sequence of add-agent requests against a workspace, the number of
// agent participants never exceeds five, and any add request issued while five
// agents are present is rejected with an error and adds no participant.
//
// Validates: Requirements 4.1, 4.5
//
// We drive an arbitrary sequence of add/remove operations against a freshly
// set-up RoomManager and maintain a reference count of the agents currently
// present. Removes are interleaved so the add path repeatedly reaches, backs
// off from, and re-reaches the cap. After every operation we assert the
// observed `countAgents` equals the reference count and never exceeds
// MAX_AGENTS_PER_WORKSPACE. For each add we assert: below the cap it succeeds
// and adds exactly one participant; at the cap it is rejected with
// `AGENT_LIMIT_REACHED` and adds nothing.

/** Encode an empty artifact Y.Doc state (mirrors WorkspaceService). */
function emptyArtifactState(): Uint8Array {
  const doc = new Y.Doc();
  doc.getText("content");
  const state = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return state;
}

/** Seed a workspace (with owner + empty artifact) directly into the store. */
async function seedWorkspace(
  store: InMemoryWorkspaceStore,
  workspaceId: string,
  ownerId: string,
): Promise<void> {
  const workspace: Workspace = {
    id: workspaceId,
    joinReference: `${workspaceId}-ref`,
    ownerId,
    artifactId: `${workspaceId}-artifact`,
    createdAt: 1_000,
  };
  const owner: Participant = {
    id: ownerId,
    workspaceId,
    type: "human",
    displayName: "Owner",
    joinedAt: 1_000,
    presenceState: "active",
  };
  const artifact: ArtifactSnapshot = {
    id: workspace.artifactId,
    workspaceId,
    artifactType: "plan",
    content: "",
    lastEditorId: null,
    lastEditedAt: null,
    yjsState: emptyArtifactState(),
  };
  await store.createWorkspace({ workspace, owner, artifact });
}

/** A RoomManager over an in-memory store with a human already registered. */
async function setupRoom(): Promise<{ rm: RoomManager; workspaceId: string }> {
  const store = new InMemoryWorkspaceStore();
  const workspaceId = "ws-1";
  const ownerId = "owner-1";
  await seedWorkspace(store, workspaceId, ownerId);

  let n = 0;
  const rm = new RoomManager(store, {
    now: () => 2_000,
    newId: () => `agent-${n++}`,
  });
  await rm.ensureRoom(workspaceId);
  await rm.registerHuman(workspaceId, {
    id: ownerId,
    workspaceId,
    type: "human",
    displayName: "Owner",
    joinedAt: 1_000,
    presenceState: "active",
  });
  return { rm, workspaceId };
}

describe("Property 9: Agent capacity is capped at five", () => {
  it("agent count never exceeds five and adds at the cap are rejected without adding", async () => {
    // An operation is either an add or a remove. `removeSelector` picks which
    // existing agent to remove (modulo the current count) so removes are valid
    // whenever any agent is present.
    const op = fc.oneof(
      fc.record({ kind: fc.constant("add" as const) }),
      fc.record({
        kind: fc.constant("remove" as const),
        removeSelector: fc.nat(),
      }),
    );

    await fc.assert(
      fc.asyncProperty(
        // Enough operations to reach the cap several times over.
        fc.array(op, { minLength: 1, maxLength: 40 }),
        async (ops) => {
          const { rm, workspaceId } = await setupRoom();

          // Reference model of the agents currently present (their ids).
          const present: string[] = [];

          for (const o of ops) {
            if (o.kind === "add") {
              const atCap = present.length >= MAX_AGENTS_PER_WORKSPACE;
              const result = await rm.addAgent(workspaceId, {
                displayName: "A",
              });

              if (atCap) {
                // At the cap: rejected with the error, nothing added.
                expect(result).toEqual({
                  ok: false,
                  error: "AGENT_LIMIT_REACHED",
                });
              } else {
                // Below the cap: succeeds and adds exactly one participant.
                expect(result.ok).toBe(true);
                if (!result.ok) return;
                present.push(result.participant.id);
              }
            } else {
              if (present.length === 0) {
                // Nothing to remove; skip so the model stays valid.
                continue;
              }
              const index = o.removeSelector % present.length;
              const [agentId] = present.splice(index, 1);
              const result = await rm.removeAgent(workspaceId, agentId!);
              expect(result.ok).toBe(true);
            }

            // Invariants after every operation: the observed count matches the
            // reference model and never exceeds the cap.
            expect(rm.countAgents(workspaceId)).toBe(present.length);
            expect(rm.countAgents(workspaceId)).toBeLessThanOrEqual(
              MAX_AGENTS_PER_WORKSPACE,
            );
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

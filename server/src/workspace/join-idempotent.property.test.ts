import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { InMemoryWorkspaceStore } from "../store/index.js";
import { WorkspaceService } from "./index.js";

// Feature: multiplayer-agent-workspace, Property 3: Join membership is idempotent
//
// For any workspace and any human participant, joining via a valid reference
// results in that participant being a member exactly once; joining again when
// already a member leaves the participant set unchanged (no duplicate entry).
//
// Validates: Requirements 1.4, 1.5
//
// The observable for membership is the store's participant roster: because
// `upsertParticipant` is idempotent by id, a participant that joins (or
// rejoins) with the same id appears exactly once. We drive an arbitrary
// sequence of joins over a small pool of (participantId, displayName) pairs —
// with repeats — and compare the resulting roster (minus the Owner, who is
// created with the workspace) against a reference set of ids that have joined.

describe("Property 3: Join membership is idempotent", () => {
  it("adds each participant exactly once and rejoins never duplicate", async () => {
    // A pool of distinct participant ids; joins draw from this pool (with
    // repeats) so the generator exercises both first-joins and rejoins.
    const idPool = ["p-a", "p-b", "p-c", "p-d", "p-e"] as const;

    const joinOp = fc.record({
      poolIndex: fc.integer({ min: 0, max: idPool.length - 1 }),
      // Display name may vary across rejoins; idempotency keys off the id only.
      displayName: fc.string({ minLength: 1, maxLength: 20 }),
    });

    await fc.assert(
      fc.asyncProperty(
        fc.array(joinOp, { minLength: 1, maxLength: 40 }),
        async (ops) => {
          const store = new InMemoryWorkspaceStore();
          let counter = 0;
          const service = new WorkspaceService(store, {
            newId: () => `gen-${++counter}`,
            newJoinReference: () => `ref-${++counter}`,
            now: () => 1_000,
          });

          const created = await service.createWorkspace({
            ownerDisplayName: "Owner",
          });
          expect(created.ok).toBe(true);
          if (!created.ok) return;
          const { joinReference, id: workspaceId, ownerId } = created.workspace;

          // Reference set of participant ids that have joined via the ref.
          const joined = new Set<string>();

          for (const op of ops) {
            const participantId = idPool[op.poolIndex];
            const result = await service.join({
              joinReference,
              displayName: op.displayName,
              participantId,
            });

            // Every join with a valid reference succeeds (Requirement 1.4).
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.workspace.id).toBe(workspaceId);
            expect(result.participant.id).toBe(participantId);

            joined.add(participantId);
          }

          // The roster equals the Owner plus exactly the joined-id set: each
          // joined id present once, and rejoins produced no duplicates.
          const roster = await store.loadParticipants(workspaceId);
          const rosterIds = roster.map((p) => p.id);

          // No duplicate entries in the roster at all.
          expect(rosterIds.length).toBe(new Set(rosterIds).size);

          // Non-owner roster ids equal the reference set of joined ids.
          const joinedRosterIds = new Set(
            rosterIds.filter((id) => id !== ownerId),
          );
          expect(joinedRosterIds).toEqual(joined);
        },
      ),
      { numRuns: 200 },
    );
  });
});

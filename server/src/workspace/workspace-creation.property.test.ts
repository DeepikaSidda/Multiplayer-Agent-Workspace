import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { InMemoryWorkspaceStore } from "../store/index.js";
import { WorkspaceService } from "./index.js";

// ---------------------------------------------------------------------------
// Property-based test for workspace-creation identifiers and ownership.
//
// Uses the REAL default id/join-reference generation (crypto.randomUUID) so
// uniqueness is a genuine property of the service rather than trivially
// guaranteed by an injected counter.
// ---------------------------------------------------------------------------

/** A single creation request: an owner display name and an optional/arbitrary type. */
const creationRequestArb = fc.record({
  ownerDisplayName: fc.string(),
  // Mix of valid types, invalid strings, absent, and non-string values to
  // exercise the (untrusted) artifact-type input space.
  artifactType: fc.oneof(
    fc.constantFrom("plan", "PRD", "issue", "workflow", "pitch", "checklist"),
    fc.string(),
    fc.constant(undefined),
    fc.integer(),
    fc.constant(null),
  ),
});

// Feature: multiplayer-agent-workspace, Property 1: Workspace creation produces unique identifiers and correct ownership
describe("Property 1: Workspace creation produces unique identifiers and correct ownership", () => {
  it("produces pairwise-distinct ids/join references and records each requester as Owner", async () => {
    // **Validates: Requirements 1.1**
    await fc.assert(
      fc.asyncProperty(
        fc.array(creationRequestArb, { minLength: 1, maxLength: 30 }),
        async (requests) => {
          // Fresh service backed by an in-memory store, using the default
          // (real) crypto.randomUUID id + join-reference generators.
          const store = new InMemoryWorkspaceStore();
          const service = new WorkspaceService(store);

          const workspaceIds: string[] = [];
          const joinReferences: string[] = [];
          const ownerIds: string[] = [];
          const artifactIds: string[] = [];

          for (const request of requests) {
            const result = await service.createWorkspace({
              ownerDisplayName: request.ownerDisplayName,
              artifactType: request.artifactType,
            });

            // Creation against a healthy store always succeeds.
            expect(result.ok).toBe(true);
            if (!result.ok) return false;

            const { workspace, owner } = result;

            // (c) Each workspace records its requester as Owner: the
            // workspace's ownerId is the returned owner participant's id, the
            // owner is a human, and the display name matches the request.
            expect(workspace.ownerId).toBe(owner.id);
            expect(owner.type).toBe("human");
            expect(owner.displayName).toBe(request.ownerDisplayName);
            expect(owner.workspaceId).toBe(workspace.id);

            workspaceIds.push(workspace.id);
            joinReferences.push(workspace.joinReference);
            ownerIds.push(owner.id);
            artifactIds.push(workspace.artifactId);
          }

          // (a) All workspace ids are pairwise distinct.
          expect(new Set(workspaceIds).size).toBe(workspaceIds.length);

          // (b) All join references are pairwise distinct.
          expect(new Set(joinReferences).size).toBe(joinReferences.length);

          // Owner ids and artifact ids are likewise pairwise distinct, and no
          // identifier collides across the different id namespaces.
          expect(new Set(ownerIds).size).toBe(ownerIds.length);
          expect(new Set(artifactIds).size).toBe(artifactIds.length);

          const allIds = [
            ...workspaceIds,
            ...joinReferences,
            ...ownerIds,
            ...artifactIds,
          ];
          expect(new Set(allIds).size).toBe(allIds.length);

          return true;
        },
      ),
      { numRuns: 100 },
    );
  });
});

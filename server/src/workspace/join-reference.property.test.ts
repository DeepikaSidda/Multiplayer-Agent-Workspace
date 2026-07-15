import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { InMemoryWorkspaceStore } from "../store/index.js";
import { WorkspaceService } from "./index.js";

// ---------------------------------------------------------------------------
// Property-based test for join-reference resolution.
//
// Uses the REAL default id/join-reference generation (crypto.randomUUID) so
// the round-trip is genuinely exercised rather than trivially guaranteed by an
// injected counter.
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

// Feature: multiplayer-agent-workspace, Property 2: Join reference round-trip
describe("Property 2: Join reference round-trip", () => {
  it("resolves each workspace's generated join reference to exactly that workspace's id", async () => {
    // **Validates: Requirements 1.3**
    await fc.assert(
      fc.asyncProperty(
        fc.array(creationRequestArb, { minLength: 1, maxLength: 20 }),
        async (requests) => {
          // Fresh service backed by an in-memory store, using the default
          // (real) crypto.randomUUID id + join-reference generators.
          const store = new InMemoryWorkspaceStore();
          const service = new WorkspaceService(store);

          // Track every (joinReference -> id) mapping created in this run.
          const created: { joinReference: string; id: string }[] = [];

          for (const request of requests) {
            const result = await service.createWorkspace({
              ownerDisplayName: request.ownerDisplayName,
              artifactType: request.artifactType,
            });

            // Creation against a healthy store always succeeds.
            expect(result.ok).toBe(true);
            if (!result.ok) return false;

            created.push({
              joinReference: result.workspace.joinReference,
              id: result.workspace.id,
            });
          }

          // Every generated join reference resolves to exactly its own
          // workspace id — including after later workspaces are created.
          for (const { joinReference, id } of created) {
            const resolved = await service.resolveJoinReference(joinReference);
            expect(resolved).toBe(id);
          }

          // An unrelated/unknown reference resolves to null (no false match).
          const knownRefs = new Set(created.map((c) => c.joinReference));
          const unknownRef = "unknown-ref";
          if (!knownRefs.has(unknownRef)) {
            expect(await service.resolveJoinReference(unknownRef)).toBeNull();
          }

          return true;
        },
      ),
      { numRuns: 100 },
    );
  });
});

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { InMemoryWorkspaceStore } from "../store/index.js";
import { WorkspaceService } from "./index.js";

// ---------------------------------------------------------------------------
// Property-based test for artifact initialization type.
//
// Uses the REAL default id/join-reference generators so creation is exercised
// end-to-end. The set of valid artifact types is hardcoded here (rather than
// imported from @maw/shared) so the expected value is derived independently of
// the implementation's own validation, keeping the property non-tautological.
// ---------------------------------------------------------------------------

/** The six valid artifact types, per Requirement 6.1 — hardcoded intentionally. */
const VALID_TYPES = [
  "plan",
  "PRD",
  "issue",
  "workflow",
  "pitch",
  "checklist",
] as const;

/**
 * Arbitrary Owner-selected artifact-type input spanning the untrusted input
 * space: valid types, invalid/empty/wrong-case strings, numbers, null,
 * undefined, and objects.
 */
const artifactTypeArb = fc.oneof(
  fc.constantFrom(...VALID_TYPES),
  fc.string(),
  fc.constant(""),
  fc.constantFrom("prd", "Plan", "ISSUE", "spreadsheet"),
  fc.integer(),
  fc.constant(null),
  fc.constant(undefined),
  fc.object(),
);

/** The expected initialized type: the input when valid, otherwise "plan". */
function expectedType(input: unknown): string {
  return typeof input === "string" &&
    (VALID_TYPES as readonly string[]).includes(input)
    ? input
    : "plan";
}

// Feature: multiplayer-agent-workspace, Property 16: Artifact initialization uses a valid type
describe("Property 16: Artifact initialization uses a valid type", () => {
  it("initializes an empty artifact with the valid Owner-selected type, else \"plan\"", async () => {
    // **Validates: Requirements 6.1, 6.2**
    await fc.assert(
      fc.asyncProperty(
        fc.string(),
        artifactTypeArb,
        async (ownerDisplayName, artifactType) => {
          const store = new InMemoryWorkspaceStore();
          const service = new WorkspaceService(store);

          const result = await service.createWorkspace({
            ownerDisplayName,
            artifactType,
          });

          // Creation against a healthy store always succeeds.
          expect(result.ok).toBe(true);
          if (!result.ok) return false;

          // The initialized artifact always starts empty (Requirement 6.2).
          expect(result.artifact.content).toBe("");

          // The artifact type is the Owner selection when valid, else "plan"
          // (Requirements 6.1, 6.2).
          expect(result.artifact.artifactType).toBe(expectedType(artifactType));

          // Regardless of input, the resulting type is always one of the six
          // valid types.
          expect(VALID_TYPES).toContain(result.artifact.artifactType);

          return true;
        },
      ),
      { numRuns: 100 },
    );
  });
});

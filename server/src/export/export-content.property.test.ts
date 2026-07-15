import { describe, it, expect } from "vitest";
import fc from "fast-check";

import type { ArtifactType } from "@maw/shared";
import {
  createExportService,
  extractExportedBody,
  ARTIFACT_BODY_SENTINEL,
  type ExportSource,
} from "./index.js";

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const ARTIFACT_TYPES: readonly ArtifactType[] = [
  "plan",
  "PRD",
  "issue",
  "workflow",
  "pitch",
  "checklist",
];

const artifactTypeArb = fc.constantFrom(...ARTIFACT_TYPES);

// A pool of tricky fragments that have historically broken naive wrapping:
// markdown separators, backticks/code fences, the sentinel string itself, and
// unicode. Interleaved with free-form text and whitespace runs.
const trickyFragmentArb = fc.constantFrom(
  "---",
  "```",
  "```ts",
  ARTIFACT_BODY_SENTINEL,
  "<!-- comment -->",
  "  \t leading/trailing  ",
  "\n\n",
  "héllo wörld 🌍 café",
  "# Heading",
  "> quote",
);

/**
 * Non-empty content: at least one non-whitespace character is guaranteed by
 * appending a non-whitespace anchor after assembling arbitrary (possibly
 * whitespace-heavy / tricky) fragments and free text.
 */
const nonEmptyContentArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.array(fc.oneof(fc.string(), trickyFragmentArb), {
      minLength: 0,
      maxLength: 8,
    }),
    // Anchor guarantees a non-whitespace char so the source is never "EMPTY".
    fc.stringMatching(/^[^\s]+$/).filter((s) => s.length > 0 && s.trim() !== ""),
    fc.array(fc.oneof(fc.string(), trickyFragmentArb), {
      minLength: 0,
      maxLength: 8,
    }),
  )
  .map(([before, anchor, after]) =>
    [...before, anchor, ...after].join(""),
  )
  .filter((content) => content.trim().length > 0);

const sourceArb: fc.Arbitrary<ExportSource> = fc.record({
  workspaceId: fc.string({ minLength: 1, maxLength: 40 }),
  artifactType: artifactTypeArb,
  content: nonEmptyContentArb,
  workspaceTitle: fc.option(fc.string({ maxLength: 60 }), { nil: undefined }),
});

// ---------------------------------------------------------------------------
// Property 18: Export contains the complete artifact content (7.1, 7.3)
// ---------------------------------------------------------------------------

// Feature: multiplayer-agent-workspace, Property 18: Export contains the complete artifact content
describe("ExportService — Property 18: export contains the complete artifact content", () => {
  it("includes the full current content verbatim (extracted body equals the original)", () => {
    // **Validates: Requirements 7.1, 7.3**
    fc.assert(
      fc.property(sourceArb, (source) => {
        const service = createExportService(() => source);
        const result = service.export(source.workspaceId);

        // Non-empty content always exports successfully.
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        // The complete content is present verbatim — nothing truncated/omitted.
        expect(result.markdown).toContain(source.content);
        // The wrapping is cleanly reversible: extracted body === original.
        expect(extractExportedBody(result.markdown)).toBe(source.content);
      }),
      { numRuns: 300 },
    );
  });
});

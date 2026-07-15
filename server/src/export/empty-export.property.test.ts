import { describe, it, expect } from "vitest";
import fc from "fast-check";

import type { ArtifactType } from "@maw/shared";
import { createExportService, type ExportSource } from "./index.js";

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

/**
 * Whitespace characters that `String.prototype.trim` treats as whitespace,
 * matching the implementation's `hasNonWhitespace` check (which relies on
 * `trim().length`). Includes ASCII whitespace plus a couple of Unicode space
 * characters that `trim()` also strips (NBSP, EM SPACE, LINE/PARAGRAPH
 * SEPARATORS), to exercise the boundary broadly.
 */
const whitespaceCharArb = fc.constantFrom(
  " ",
  "\t",
  "\n",
  "\r",
  "\f",
  "\v",
  "\u00A0", // no-break space
  "\u2003", // em space
  "\u2028", // line separator
  "\u2029", // paragraph separator
);

/**
 * Whitespace-only content: the empty string, or an arbitrary-length string
 * composed solely of whitespace characters. Every value here satisfies
 * `content.trim().length === 0`, i.e. has no non-whitespace character.
 */
const emptyContentArb: fc.Arbitrary<string> = fc
  .array(whitespaceCharArb, { minLength: 0, maxLength: 40 })
  .map((chars) => chars.join(""))
  .filter((content) => content.trim().length === 0);

const emptySourceArb: fc.Arbitrary<ExportSource> = fc.record({
  workspaceId: fc.string({ minLength: 1, maxLength: 40 }),
  artifactType: artifactTypeArb,
  content: emptyContentArb,
  workspaceTitle: fc.option(fc.string({ maxLength: 60 }), { nil: undefined }),
});

// ---------------------------------------------------------------------------
// Property 19: Empty artifact export is refused (7.4)
// ---------------------------------------------------------------------------

// Feature: multiplayer-agent-workspace, Property 19: Empty artifact export is refused
describe("ExportService — Property 19: empty artifact export is refused", () => {
  it("refuses whitespace-only content with reason EMPTY and produces no export", () => {
    // **Validates: Requirements 7.4**
    fc.assert(
      fc.property(emptySourceArb, (source) => {
        const service = createExportService(() => source);
        const result = service.export(source.workspaceId);

        // Export is refused for empty/whitespace-only content: exactly the
        // EMPTY refusal, with no markdown or filename produced.
        expect(result).toEqual({ ok: false, reason: "EMPTY" });
        expect("markdown" in result).toBe(false);
        expect("filename" in result).toBe(false);
      }),
      { numRuns: 200 },
    );
  });
});

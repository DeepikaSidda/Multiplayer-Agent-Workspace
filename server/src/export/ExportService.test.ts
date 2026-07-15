import { describe, it, expect } from "vitest";
import type { ArtifactType } from "@maw/shared";
import {
  createExportService,
  extractExportedBody,
  EXPORT_REASON_TO_ERROR_CODE,
  ARTIFACT_BODY_SENTINEL,
  type ExportSource,
} from "./index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSource(over: Partial<ExportSource> = {}): ExportSource {
  return {
    workspaceId: "ws-1",
    artifactType: "plan",
    content: "# My Plan\n\nStep one\nStep two",
    workspaceTitle: "Team Rocket",
    ...over,
  };
}

/** A service whose provider always returns the given source. */
function serviceFor(source: ExportSource | null) {
  return createExportService(() => source);
}

// ---------------------------------------------------------------------------
// Round-trip: exported body equals the original content verbatim (7.1, 7.3)
// ---------------------------------------------------------------------------

describe("createExportService — complete content round-trip", () => {
  it("wraps content and produces an extractable body equal to the original", () => {
    const source = makeSource();
    const result = serviceFor(source).export("ws-1");

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The full original content is present verbatim (nothing truncated).
    expect(result.markdown).toContain(source.content);
    // And the body extracted back out equals the original exactly.
    expect(extractExportedBody(result.markdown)).toBe(source.content);
  });

  it("preserves content that itself contains markdown separators and the sentinel text", () => {
    // Content includes a '---' separator and even the sentinel string; the
    // FIRST sentinel (the header's) must still bound the body correctly.
    const tricky = `---\nheading\n${ARTIFACT_BODY_SENTINEL}\ntrailing --- text`;
    const result = serviceFor(makeSource({ content: tricky })).export("ws-1");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(extractExportedBody(result.markdown)).toBe(tricky);
  });

  it("includes a header derived from artifact type and workspace metadata", () => {
    const result = serviceFor(
      makeSource({ artifactType: "PRD", workspaceTitle: "Team Rocket" }),
    ).export("ws-1");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.markdown).toContain("# PRD");
    expect(result.markdown).toContain("Team Rocket");
    expect(result.markdown).toContain("Artifact type: PRD");
  });

  it("derives a safe filename from type and workspace id", () => {
    const result = serviceFor(
      makeSource({ artifactType: "checklist", workspaceId: "WS/Abc 123" }),
    ).export("WS/Abc 123");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.filename).toBe("checklist-ws-abc-123.md");
  });

  it("falls back to the workspace id in the header when no title is provided", () => {
    const result = serviceFor(
      makeSource({ workspaceTitle: undefined, workspaceId: "ws-xyz" }),
    ).export("ws-xyz");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.markdown).toContain("ws-xyz");
  });

  it("preserves leading/trailing whitespace within otherwise non-empty content", () => {
    const content = "\n\n  # Notes  \n\ncontent\n\n";
    const result = serviceFor(makeSource({ content })).export("ws-1");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(extractExportedBody(result.markdown)).toBe(content);
  });
});

// ---------------------------------------------------------------------------
// Empty / whitespace refusal (7.4)
// ---------------------------------------------------------------------------

describe("createExportService — empty/whitespace refusal", () => {
  const emptyish = ["", " ", "\n", "\t", "   \n\t  \r\n"];

  for (const content of emptyish) {
    it(`refuses export for whitespace-only content ${JSON.stringify(content)}`, () => {
      const result = serviceFor(makeSource({ content })).export("ws-1");
      expect(result).toEqual({ ok: false, reason: "EMPTY" });
    });
  }
});

// ---------------------------------------------------------------------------
// Failure handling (7.5)
// ---------------------------------------------------------------------------

describe("createExportService — failure handling", () => {
  it("returns FAILED when the provider throws", () => {
    const service = createExportService(() => {
      throw new Error("boom");
    });
    expect(service.export("ws-1")).toEqual({ ok: false, reason: "FAILED" });
  });

  it("returns FAILED when the provider yields no source (unknown workspace)", () => {
    expect(serviceFor(null).export("missing")).toEqual({
      ok: false,
      reason: "FAILED",
    });
  });

  it("returns FAILED for an unknown artifact type", () => {
    const result = serviceFor(
      makeSource({ artifactType: "bogus" as ArtifactType }),
    ).export("ws-1");
    expect(result).toEqual({ ok: false, reason: "FAILED" });
  });
});

// ---------------------------------------------------------------------------
// Reason -> ErrorCode mapping
// ---------------------------------------------------------------------------

describe("EXPORT_REASON_TO_ERROR_CODE", () => {
  it("maps interface reasons to the transport error codes", () => {
    expect(EXPORT_REASON_TO_ERROR_CODE.EMPTY).toBe("EXPORT_EMPTY");
    expect(EXPORT_REASON_TO_ERROR_CODE.FAILED).toBe("EXPORT_FAILED");
  });
});

// ---------------------------------------------------------------------------
// extractExportedBody edge case
// ---------------------------------------------------------------------------

describe("extractExportedBody", () => {
  it("returns null when the sentinel is absent", () => {
    expect(extractExportedBody("no sentinel here")).toBeNull();
  });
});

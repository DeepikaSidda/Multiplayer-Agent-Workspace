/**
 * Export Service — produces a Markdown representation of a workspace's current
 * artifact content (Requirement 7: Export the Final Output).
 *
 * Design references:
 * - The export is a pure transform over the *current* artifact content string:
 *   verify it has at least one non-whitespace character (Requirement 7.4),
 *   otherwise refuse; wrap the full content verbatim with a small header
 *   derived from `ArtifactType` + workspace metadata, and return it as a
 *   downloadable `.md` payload (Requirements 7.1, 7.2). The full content is
 *   included with nothing truncated (Requirement 7.3); on unexpected failure
 *   the artifact is left unchanged (Requirement 7.5).
 *
 * Decoupling: to avoid a hard dependency on the concurrently-built
 * `ArtifactService`, this service reads the artifact content + type + workspace
 * metadata through an injected {@link ExportSourceProvider} rather than
 * importing `ArtifactService` directly. The provider can be backed by
 * `ArtifactService.getContent(...)` (plus workspace metadata) at wiring time.
 *
 * Reason-code mapping: the {@link ExportService} interface in design.md returns
 * `reason: 'EMPTY' | 'FAILED'`. The task text and the WebSocket `ErrorCode`
 * contract use `EXPORT_EMPTY` / `EXPORT_FAILED`. This module returns the
 * interface's `'EMPTY' | 'FAILED'` and exposes {@link EXPORT_REASON_TO_ERROR_CODE}
 * so the gateway layer can map a refusal/failure to the corresponding
 * `ErrorCode` (`EMPTY -> EXPORT_EMPTY`, `FAILED -> EXPORT_FAILED`).
 */

import type { ArtifactType } from "@maw/shared";
import type { ErrorCode } from "@maw/shared";

/**
 * The artifact + workspace context required to produce an export, supplied by
 * the caller so the service need not depend on `ArtifactService` directly.
 */
export interface ExportSource {
  /** The workspace whose artifact is being exported. */
  workspaceId: string;
  /** The artifact's type; drives the export title/header. */
  artifactType: ArtifactType;
  /** The current artifact content, verbatim, at the time of export. */
  content: string;
  /**
   * Optional human-friendly workspace title/name for the header. When absent,
   * the header falls back to the workspace id.
   */
  workspaceTitle?: string;
}

/**
 * Resolves the {@link ExportSource} for a workspace id. Returning `null`/
 * `undefined` (unknown workspace) or throwing is treated as an export failure
 * (`reason: 'FAILED'`), leaving the artifact untouched (Requirement 7.5).
 */
export type ExportSourceProvider = (
  workspaceId: string,
) => ExportSource | null | undefined;

/** Successful export payload (Requirements 7.1, 7.2). */
export interface ExportSuccess {
  ok: true;
  /** Suggested download filename, e.g. `plan-ws-123.md`. */
  filename: string;
  /** The complete Markdown export (header + verbatim content). */
  markdown: string;
}

/**
 * Export refusal/failure.
 * - `EMPTY`: the artifact has no non-whitespace content (Requirement 7.4).
 * - `FAILED`: an unexpected failure occurred (Requirement 7.5).
 */
export interface ExportFailure {
  ok: false;
  reason: "EMPTY" | "FAILED";
}

export type ExportResult = ExportSuccess | ExportFailure;

/**
 * Maps an {@link ExportFailure} reason to the WebSocket `ErrorCode` used by the
 * server -> client event contract. Keeps the interface-level reason and the
 * transport-level code reconciled in one place.
 */
export const EXPORT_REASON_TO_ERROR_CODE: Record<
  ExportFailure["reason"],
  Extract<ErrorCode, "EXPORT_EMPTY" | "EXPORT_FAILED">
> = {
  EMPTY: "EXPORT_EMPTY",
  FAILED: "EXPORT_FAILED",
};

/**
 * Sentinel that separates the generated header from the verbatim artifact body.
 * It is an HTML comment (invisible in rendered Markdown) and is guaranteed not
 * to appear in the header this module generates, so the FIRST occurrence in the
 * export always marks the true start of the body. This makes the wrapping
 * cleanly reversible: everything after the sentinel (and its trailing newline)
 * equals the original content, byte for byte (Requirement 7.3, Property 18).
 */
export const ARTIFACT_BODY_SENTINEL = "<!-- @maw:artifact-body -->";

/** Human-friendly title for each artifact type, used in the export header. */
const ARTIFACT_TYPE_TITLE: Record<ArtifactType, string> = {
  plan: "Plan",
  PRD: "PRD",
  issue: "Issue",
  workflow: "Workflow",
  pitch: "Pitch",
  checklist: "Checklist",
};

/** True when the string contains at least one non-whitespace character. */
function hasNonWhitespace(content: string): boolean {
  return content.trim().length > 0;
}

/**
 * Derives a safe, lowercase filename slug from workspace/type. Falls back to
 * `artifact` when nothing usable remains after sanitization.
 */
function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "artifact";
}

/** Builds the Markdown header block that precedes the body sentinel. */
function buildHeader(source: ExportSource): string {
  const title = ARTIFACT_TYPE_TITLE[source.artifactType];
  const label = source.workspaceTitle?.trim()
    ? source.workspaceTitle.trim()
    : source.workspaceId;
  return [
    `# ${title}`,
    "",
    `> Exported from workspace: ${label}`,
    `> Artifact type: ${source.artifactType}`,
    "",
    "---",
    "",
  ].join("\n");
}

/**
 * Wraps verbatim `content` with the generated header + body sentinel. The
 * returned Markdown is cleanly reversible via {@link extractExportedBody}.
 */
function wrap(source: ExportSource): string {
  return `${buildHeader(source)}${ARTIFACT_BODY_SENTINEL}\n${source.content}`;
}

/**
 * Inverse of the wrapping: extracts the verbatim artifact body from an exported
 * Markdown string. Uses the FIRST occurrence of {@link ARTIFACT_BODY_SENTINEL}
 * (always the one inserted by the header) and returns everything after its
 * trailing newline. Returns `null` when the sentinel is absent.
 */
export function extractExportedBody(markdown: string): string | null {
  const index = markdown.indexOf(ARTIFACT_BODY_SENTINEL);
  if (index === -1) return null;
  const afterSentinel = index + ARTIFACT_BODY_SENTINEL.length;
  // The sentinel is always followed by exactly one newline before the body.
  const bodyStart =
    markdown[afterSentinel] === "\n" ? afterSentinel + 1 : afterSentinel;
  return markdown.slice(bodyStart);
}

/**
 * Produces a Markdown export for a workspace's current artifact content.
 *
 * @param workspaceId the workspace whose artifact to export
 * @returns `{ ok: true, filename, markdown }` on success; `{ ok: false, reason }`
 *   where `reason` is `'EMPTY'` (whitespace-only content, Requirement 7.4) or
 *   `'FAILED'` (unexpected failure, Requirement 7.5).
 */
export interface ExportService {
  export(workspaceId: string): ExportResult;
}

/** Creates an {@link ExportService} backed by the given source provider. */
export function createExportService(
  provider: ExportSourceProvider,
): ExportService {
  return {
    export(workspaceId: string): ExportResult {
      let source: ExportSource | null | undefined;
      try {
        source = provider(workspaceId);
      } catch {
        // Provider blew up unexpectedly — treat as failure, leave artifact as-is.
        return { ok: false, reason: "FAILED" };
      }

      // Unknown workspace / missing source is an unexpected failure.
      if (!source) {
        return { ok: false, reason: "FAILED" };
      }

      try {
        const { content, artifactType } = source;

        // Requirement 7.4: refuse export of empty/whitespace-only content.
        if (!hasNonWhitespace(content)) {
          return { ok: false, reason: "EMPTY" };
        }

        // Defensive: an invalid artifact type would make header/filename
        // derivation ambiguous — treat as an unexpected failure.
        if (!(artifactType in ARTIFACT_TYPE_TITLE)) {
          return { ok: false, reason: "FAILED" };
        }

        const markdown = wrap(source);
        const filename = `${slugify(artifactType)}-${slugify(source.workspaceId)}.md`;
        return { ok: true, filename, markdown };
      } catch {
        return { ok: false, reason: "FAILED" };
      }
    },
  };
}

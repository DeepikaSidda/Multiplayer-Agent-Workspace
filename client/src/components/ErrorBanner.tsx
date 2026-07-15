/**
 * ErrorBanner — surfaces artifact rejections and general operation errors to
 * the responsible participant, so failures are never silently swallowed.
 *
 * Requirements:
 *  - 6.5: an artifact edit that would exceed the content limit is rejected with
 *    `SIZE_LIMIT`; surface a "content limit exceeded" message.
 *  - 8.4: a failed artifact persist is rejected with `PERSIST_FAILED`; surface a
 *    "changes were not saved" message.
 *  - General workspace errors (`WORKSPACE_CREATE_FAILED`, `WORKSPACE_NOT_FOUND`,
 *    `MALFORMED_EVENT`, `INTERNAL_ERROR`) are surfaced here. Agent-scoped and
 *    export-scoped errors are surfaced by {@link AgentManager} /
 *    {@link ExportControl} respectively, so they are excluded here to avoid
 *    duplicate messaging.
 *
 * Message validation/persistence rejections (Requirements 3.2, 8.2) are surfaced
 * at the composer by {@link MessageInput}.
 */

import {
  ARTIFACT_CONTENT_LIMIT,
  type ArtifactRejectionReason,
  type ErrorPayload,
} from "@maw/shared";

/** Error codes owned by other, more specific controls. */
const HANDLED_ELSEWHERE = new Set([
  "AGENT_LIMIT_REACHED",
  "AGENT_NOT_FOUND",
  "EXPORT_EMPTY",
  "EXPORT_FAILED",
]);

export interface ErrorBannerProps {
  /** Latest artifact edit rejection, if any. */
  artifactRejection?: ArtifactRejectionReason | null;
  /** Clear the surfaced artifact rejection. */
  onClearArtifactRejection?: () => void;
  /** Latest structured operation error, if any. */
  error?: ErrorPayload | null;
  /** Clear the surfaced error. */
  onClearError?: () => void;
}

function artifactRejectionMessage(reason: ArtifactRejectionReason): string {
  switch (reason) {
    case "SIZE_LIMIT":
      return `Edit rejected: the artifact cannot exceed ${ARTIFACT_CONTENT_LIMIT.toLocaleString()} characters. Your existing content is preserved.`;
    case "PERSIST_FAILED":
      return "Your edit could not be saved and was not applied. The artifact reverted to the last saved content.";
    default:
      return "Your edit was not accepted.";
  }
}

function errorMessage(error: ErrorPayload): string {
  switch (error.code) {
    case "WORKSPACE_CREATE_FAILED":
      return "The workspace could not be created. Please try again.";
    case "WORKSPACE_NOT_FOUND":
      return "That workspace was not found.";
    case "MALFORMED_EVENT":
      return "The last action could not be processed.";
    case "INTERNAL_ERROR":
      return "Something went wrong on the server. Please try again.";
    default:
      return error.message;
  }
}

export function ErrorBanner({
  artifactRejection,
  onClearArtifactRejection,
  error,
  onClearError,
}: ErrorBannerProps) {
  const generalError = error && !HANDLED_ELSEWHERE.has(error.code) ? error : null;

  if (!artifactRejection && !generalError) return null;

  return (
    <div className="error-banner" role="alert" aria-label="Errors">
      {artifactRejection && (
        <p className="error-banner-item" data-testid="artifact-rejection">
          {artifactRejectionMessage(artifactRejection)}
          {onClearArtifactRejection && (
            <button
              type="button"
              className="error-banner-dismiss"
              data-testid="artifact-rejection-dismiss"
              onClick={onClearArtifactRejection}
              aria-label="Dismiss artifact error"
            >
              ×
            </button>
          )}
        </p>
      )}
      {generalError && (
        <p className="error-banner-item" data-testid="operation-error">
          {errorMessage(generalError)}
          {onClearError && (
            <button
              type="button"
              className="error-banner-dismiss"
              data-testid="operation-error-dismiss"
              onClick={onClearError}
              aria-label="Dismiss error"
            >
              ×
            </button>
          )}
        </p>
      )}
    </div>
  );
}

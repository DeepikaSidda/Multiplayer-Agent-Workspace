/**
 * Shared domain constants and invariants for the Multiplayer Agent Workspace.
 *
 * Centralizing these bounds keeps validation identical on the server and the
 * client (client-side feedback vs. server-side enforcement).
 */

import type { ArtifactType } from "./types.js";

/** Minimum message content length (inclusive). Requirement 3.1/3.2. */
export const MESSAGE_MIN_LENGTH = 1;

/** Maximum message content length (inclusive). Requirement 3.1/3.2. */
export const MESSAGE_MAX_LENGTH = 4000;

/** Maximum artifact content length in characters. Requirement 6.5. */
export const ARTIFACT_CONTENT_LIMIT = 100000;

/** Maximum number of agent participants per workspace. Requirement 4.1/4.5. */
export const MAX_AGENTS_PER_WORKSPACE = 5;

/** Agent generation timeout in milliseconds. Requirement 5.5. */
export const AGENT_TIMEOUT_MS = 60000;

/** The default artifact type used when no valid type is selected. Requirement 6.2. */
export const DEFAULT_ARTIFACT_TYPE: ArtifactType = "plan";

/** The Bedrock model id backing agent teammates. */
export const AGENT_MODEL_ID = "amazon.nova-pro-v1:0";

/** The complete, valid set of artifact types. Requirement 6.1. */
export const VALID_ARTIFACT_TYPES: ReadonlySet<ArtifactType> = new Set<ArtifactType>([
  "plan",
  "PRD",
  "issue",
  "workflow",
  "pitch",
  "checklist",
]);

/**
 * Narrowing guard: returns true when `value` is one of the valid artifact types.
 * Useful for validating untrusted Owner-selected types at the boundary.
 */
export function isArtifactType(value: unknown): value is ArtifactType {
  return typeof value === "string" && VALID_ARTIFACT_TYPES.has(value as ArtifactType);
}

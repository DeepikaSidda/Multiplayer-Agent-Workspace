/**
 * Shared domain types for the Multiplayer Agent Workspace.
 *
 * These types mirror the Data Models section of the design document and are
 * consumed by both the server (`@maw/server`) and client (`@maw/client`).
 */

/** Whether a participant is a human user or an AI agent teammate. */
export type ParticipantType = "human" | "agent";

/**
 * Presence state of a participant.
 * - `active`: connected and participating.
 * - `processing`: an agent is currently generating a response.
 * - `disconnected`: session ended or reaped after a disconnect.
 */
export type PresenceState = "active" | "processing" | "disconnected";

/** The category of the collaborative artifact. */
export type ArtifactType =
  | "plan"
  | "PRD"
  | "issue"
  | "workflow"
  | "pitch"
  | "checklist";

/**
 * Classification of a message in the log.
 * - `chat`: a normal human chat message.
 * - `agent`: a successful agent-authored response.
 * - `error`: an agent-attributed error (e.g., failed/timed-out generation).
 */
export type MessageKind = "chat" | "agent" | "error";

/** A shared collaborative room. */
export interface Workspace {
  /** Unique across all workspaces. */
  id: string;
  /** Shareable reference that resolves to exactly one workspace `id`. */
  joinReference: string;
  /** The `Participant.id` of the Owner (a human). */
  ownerId: string;
  /** Identifier of the workspace's single artifact. */
  artifactId: string;
  /** Creation time in epoch milliseconds. */
  createdAt: number;
}

/** A member of a workspace — either a human or an agent. */
export interface Participant {
  id: string;
  workspaceId: string;
  type: ParticipantType;
  displayName: string;
  /** Join time in epoch milliseconds. */
  joinedAt: number;
  presenceState: PresenceState;
  /** Agent-only: persona/system framing for the agent. */
  persona?: string;
  /** Agent-only: Bedrock model id, e.g. "amazon.nova-pro-v1:0". */
  modelId?: string;
}

/** A single entry in the workspace message log. */
export interface Message {
  id: string;
  workspaceId: string;
  senderId: string;
  senderType: ParticipantType;
  senderName: string;
  /** 1..4000 characters, containing at least one non-whitespace character. */
  content: string;
  /** Epoch milliseconds, millisecond precision. */
  timestamp: number;
  /** Monotonic per-workspace tiebreaker for total ordering. */
  sequence: number;
  kind: MessageKind;
}

/** A durable snapshot of the collaborative artifact. */
export interface ArtifactSnapshot {
  id: string;
  workspaceId: string;
  artifactType: ArtifactType;
  /** Markdown text, at most 100000 characters. */
  content: string;
  lastEditorId: string | null;
  lastEditedAt: number | null;
  /** Encoded Y.Doc state for durable CRDT restore. */
  yjsState: Uint8Array;
}

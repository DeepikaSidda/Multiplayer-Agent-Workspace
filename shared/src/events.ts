/**
 * WebSocket event contract for the Multiplayer Agent Workspace.
 *
 * All real-time traffic flows over a single connection per session using the
 * typed envelope `{ type, workspaceId, payload }`. Binary CRDT data (Yjs
 * updates / state) is transmitted as base64-encoded strings so envelopes are
 * JSON-serializable; the transport layer is responsible for encode/decode.
 */

import type {
  ArtifactType,
  Message,
  Participant,
  PresenceState,
  ParticipantType,
  SavedResultEntry,
  Workspace,
} from "./types.js";

/** Base64-encoded binary payload (e.g., an encoded Yjs update or state). */
export type Base64 = string;

/** Reason a message was rejected. Requirement 3.2. */
export type MessageRejectionReason = "EMPTY" | "WHITESPACE_ONLY" | "TOO_LONG";

/** Reason an artifact update was rejected. Requirements 6.5, 8.4. */
export type ArtifactRejectionReason = "SIZE_LIMIT" | "PERSIST_FAILED";

/** Structured operation error codes surfaced to the responsible participant. */
export type ErrorCode =
  | "WORKSPACE_CREATE_FAILED"
  | "WORKSPACE_NOT_FOUND"
  | "AGENT_LIMIT_REACHED"
  | "AGENT_NOT_FOUND"
  | "EXPORT_EMPTY"
  | "EXPORT_FAILED"
  | "MALFORMED_EVENT"
  | "INTERNAL_ERROR";

/**
 * Serializable artifact state delivered inside a workspace snapshot.
 * Mirrors `ArtifactSnapshot` but carries the encoded Y.Doc state as base64.
 */
export interface ArtifactState {
  id: string;
  workspaceId: string;
  artifactType: ArtifactType;
  content: string;
  lastEditorId: string | null;
  lastEditedAt: number | null;
  /** Encoded Y.Doc state as base64 for durable CRDT restore on the client. */
  yjsState: Base64;
}

// ---------------------------------------------------------------------------
// Client -> Server payloads
// ---------------------------------------------------------------------------

/** Join or reconnect to a workspace via its shareable reference. */
export interface JoinPayload {
  joinReference: string;
  displayName: string;
  /**
   * Optional stable participant id. Supplying it makes the join idempotent
   * (upsert instead of a new participant) — e.g. the workspace creator joins as
   * the already-recorded Owner, and a reconnecting session keeps its identity.
   */
  participantId?: string;
}

/** Post a chat message to the workspace. */
export interface SendMessagePayload {
  content: string;
}

/** Commit a CRDT edit to the shared artifact. */
export interface ArtifactUpdatePayload {
  /** Base64-encoded incremental Yjs update. */
  yjsUpdate: Base64;
}

/** Add an agent teammate to the workspace. */
export interface AddAgentPayload {
  displayName: string;
  persona?: string;
}

/** Remove an agent teammate from the workspace. */
export interface RemoveAgentPayload {
  agentId: string;
}

/** Gracefully end the session. */
export type LeavePayload = Record<string, never>;

/** Request a Markdown export of the current artifact. */
export type ExportPayload = Record<string, never>;

/** Save the current shared-result content into the durable, shared history. */
export interface SaveHistoryPayload {
  content: string;
}

/** Delete a saved history entry by id. */
export interface DeleteHistoryPayload {
  id: string;
}

/** Discriminated union of all client -> server events. */
export type ClientToServerEvent =
  | { type: "join"; workspaceId: string; payload: JoinPayload }
  | { type: "sendMessage"; workspaceId: string; payload: SendMessagePayload }
  | { type: "artifactUpdate"; workspaceId: string; payload: ArtifactUpdatePayload }
  | { type: "addAgent"; workspaceId: string; payload: AddAgentPayload }
  | { type: "removeAgent"; workspaceId: string; payload: RemoveAgentPayload }
  | { type: "leave"; workspaceId: string; payload: LeavePayload }
  | { type: "export"; workspaceId: string; payload: ExportPayload }
  | { type: "saveHistory"; workspaceId: string; payload: SaveHistoryPayload }
  | { type: "deleteHistory"; workspaceId: string; payload: DeleteHistoryPayload };

/** All client -> server event type discriminants. */
export type ClientToServerEventType = ClientToServerEvent["type"];

// ---------------------------------------------------------------------------
// Server -> Client payloads
// ---------------------------------------------------------------------------

/** Full workspace state delivered on join/rejoin. Requirements 1.7, 8.5. */
export interface WorkspaceSnapshotPayload {
  workspace: Workspace;
  participants: Participant[];
  artifact: ArtifactState;
  /** Complete message log ordered by ascending (timestamp, sequence). */
  messages: Message[];
  /** Saved shared-result history, newest first. */
  history: SavedResultEntry[];
}

/** The saved-result history changed. Sent to all participants. */
export interface HistoryUpdatedPayload {
  /** The full saved-result history, newest first. */
  entries: SavedResultEntry[];
}

/** A participant's presence changed. Requirements 2.1, 2.2, 2.3, 5.3. */
export interface PresenceUpdatePayload {
  participantId: string;
  presenceState: PresenceState;
  participantType: ParticipantType;
}

/** The active participant count changed. Requirement 2.5. */
export interface ParticipantCountUpdatePayload {
  activeCount: number;
}

/** A new message was appended to the log. Requirement 3.3. */
export interface MessageAppendedPayload {
  message: Message;
}

/** A message was rejected (validation or persistence). Requirements 3.2, 8.2. */
export interface MessageRejectedPayload {
  reason: MessageRejectionReason;
}

/** A CRDT edit to apply to the local artifact. Requirements 6.3, 6.4, 6.6. */
export interface ArtifactUpdateBroadcastPayload {
  /** Base64-encoded incremental Yjs update. */
  yjsUpdate: Base64;
  lastEditorId: string;
  lastEditedAt: number;
}

/** An artifact update was rejected (size limit or persistence). Requirements 6.5, 8.4. */
export interface ArtifactRejectedPayload {
  reason: ArtifactRejectionReason;
}

/** A streamed token of an in-progress agent response (optional live view). */
export interface AgentResponseDeltaPayload {
  agentId: string;
  textDelta: string;
}

/** An agent participant was added to the workspace. Requirement 4.2. */
export interface AgentAddedPayload {
  participant: Participant;
}

/** An agent participant was removed from the workspace. Requirement 4.4. */
export interface AgentRemovedPayload {
  agentId: string;
}

/** A completed Markdown export payload. Requirements 7.1, 7.2. */
export interface ExportReadyPayload {
  filename: string;
  markdown: string;
}

/** A structured operation error surfaced to the participant. */
export interface ErrorPayload {
  code: ErrorCode;
  message: string;
}

/** Discriminated union of all server -> client events. */
export type ServerToClientEvent =
  | { type: "workspaceSnapshot"; workspaceId: string; payload: WorkspaceSnapshotPayload }
  | { type: "presenceUpdate"; workspaceId: string; payload: PresenceUpdatePayload }
  | { type: "participantCountUpdate"; workspaceId: string; payload: ParticipantCountUpdatePayload }
  | { type: "messageAppended"; workspaceId: string; payload: MessageAppendedPayload }
  | { type: "messageRejected"; workspaceId: string; payload: MessageRejectedPayload }
  | { type: "artifactUpdate"; workspaceId: string; payload: ArtifactUpdateBroadcastPayload }
  | { type: "artifactRejected"; workspaceId: string; payload: ArtifactRejectedPayload }
  | { type: "agentResponseDelta"; workspaceId: string; payload: AgentResponseDeltaPayload }
  | { type: "agentAdded"; workspaceId: string; payload: AgentAddedPayload }
  | { type: "agentRemoved"; workspaceId: string; payload: AgentRemovedPayload }
  | { type: "exportReady"; workspaceId: string; payload: ExportReadyPayload }
  | { type: "historyUpdated"; workspaceId: string; payload: HistoryUpdatedPayload }
  | { type: "error"; workspaceId: string; payload: ErrorPayload };

/** All server -> client event type discriminants. */
export type ServerToClientEventType = ServerToClientEvent["type"];

/**
 * Generic event envelope. Concrete envelopes are the discriminated unions
 * `ClientToServerEvent` and `ServerToClientEvent`; this alias is the shared
 * `{ type, workspaceId, payload }` shape referenced by the design document.
 */
export interface EventEnvelope<
  TType extends string = string,
  TPayload = unknown,
> {
  type: TType;
  workspaceId: string;
  payload: TPayload;
}

/**
 * useWorkspaceConnection — a React hook that adapts the imperative
 * {@link WorkspaceConnection} transport (task 13.1) into reactive state for the
 * UI (task 13.2).
 *
 * The connection already maintains the rendered snapshot (roster, message log,
 * artifact metadata) and updates it before emitting each server event. This
 * hook subscribes to the relevant channels and mirrors that state into React
 * state so presence, the message log, and validation feedback re-render as
 * events arrive:
 *  - `workspaceSnapshot` / `agentAdded` / `agentRemoved` / `presenceUpdate`
 *    refresh the participant roster (Requirements 2.1, 2.5).
 *  - `participantCountUpdate` sets the authoritative active count; presence and
 *    snapshot changes fall back to counting non-disconnected participants
 *    (Requirement 2.5).
 *  - `messageAppended` / `workspaceSnapshot` refresh the message log
 *    (Requirements 3.3, 3.4).
 *  - `messageRejected` surfaces the latest server-side validation/persistence
 *    rejection to the composer (Requirements 3.2, 8.2).
 *  - `error` surfaces the latest structured operation error (e.g.
 *    `AGENT_LIMIT_REACHED`, `AGENT_NOT_FOUND`, `EXPORT_EMPTY`, `EXPORT_FAILED`)
 *    to the responsible participant (Requirements 4.5, 4.6, 7.4, 7.5).
 *  - `artifactRejected` surfaces the latest artifact edit rejection
 *    (size limit or save failure) to the editing participant
 *    (Requirements 6.5, 8.4).
 *
 * The connection is injected, so components (and their tests) can drive a fake
 * socket without a real network.
 */

import { useCallback, useEffect, useState } from "react";
import type {
  ArtifactRejectionReason,
  ArtifactState,
  ErrorPayload,
  Message,
  MessageRejectionReason,
  Participant,
  Workspace,
} from "@maw/shared";
import type { ConnectionState, WorkspaceConnection } from "./WorkspaceConnection.js";

/** A participant counts toward the active total unless it has disconnected. */
function countActive(participants: readonly Participant[]): number {
  return participants.filter((p) => p.presenceState !== "disconnected").length;
}

/** Reactive view of a {@link WorkspaceConnection} for the UI layer. */
export interface WorkspaceView {
  /** The underlying transport (for sending intents from components). */
  connection: WorkspaceConnection;
  /** Current connection lifecycle state. */
  connectionState: ConnectionState;
  /** The joined workspace, or null before the first snapshot. */
  workspace: Workspace | null;
  /** Current participant roster. */
  participants: Participant[];
  /** Message log in `(timestamp, sequence)` order. */
  messages: Message[];
  /** Count of currently active participants. */
  activeCount: number;
  /** Artifact metadata (type, last editor, timestamps) sans CRDT state. */
  artifactMeta: Omit<ArtifactState, "yjsState"> | null;
  /** The most recent server-side message rejection, if any. */
  lastMessageRejection: MessageRejectionReason | null;
  /** Clear the surfaced message rejection (e.g. after a successful send). */
  clearMessageRejection: () => void;
  /** The most recent structured operation error, if any. */
  lastError: ErrorPayload | null;
  /** Clear the surfaced operation error. */
  clearError: () => void;
  /** The most recent artifact edit rejection (size limit / save failure), if any. */
  lastArtifactRejection: ArtifactRejectionReason | null;
  /** Clear the surfaced artifact rejection. */
  clearArtifactRejection: () => void;
}

/**
 * Subscribe to a {@link WorkspaceConnection} and expose its state reactively.
 * Re-subscribes if the `connection` instance identity changes.
 */
export function useWorkspaceConnection(connection: WorkspaceConnection): WorkspaceView {
  const [connectionState, setConnectionState] = useState<ConnectionState>(
    connection.state,
  );
  const [workspace, setWorkspace] = useState<Workspace | null>(() =>
    connection.getWorkspace(),
  );
  const [participants, setParticipants] = useState<Participant[]>(() =>
    connection.getParticipants(),
  );
  const [messages, setMessages] = useState<Message[]>(() => connection.getMessages());
  const [activeCount, setActiveCount] = useState<number>(() =>
    countActive(connection.getParticipants()),
  );
  const [artifactMeta, setArtifactMeta] = useState<
    Omit<ArtifactState, "yjsState"> | null
  >(() => connection.getArtifactMeta());
  const [lastMessageRejection, setLastMessageRejection] =
    useState<MessageRejectionReason | null>(null);
  const [lastError, setLastError] = useState<ErrorPayload | null>(null);
  const [lastArtifactRejection, setLastArtifactRejection] =
    useState<ArtifactRejectionReason | null>(null);

  useEffect(() => {
    const syncRoster = () => {
      const roster = connection.getParticipants();
      setParticipants(roster);
      setActiveCount(countActive(roster));
    };
    const syncSnapshot = () => {
      setWorkspace(connection.getWorkspace());
      setArtifactMeta(connection.getArtifactMeta());
      setMessages(connection.getMessages());
      syncRoster();
    };

    const unsubscribers = [
      connection.onStateChange(setConnectionState),
      connection.on("workspaceSnapshot", syncSnapshot),
      connection.on("messageAppended", () => setMessages(connection.getMessages())),
      connection.on("presenceUpdate", syncRoster),
      connection.on("participantCountUpdate", (payload) =>
        setActiveCount(payload.activeCount),
      ),
      connection.on("agentAdded", syncRoster),
      connection.on("agentRemoved", syncRoster),
      connection.on("messageRejected", (payload) =>
        setLastMessageRejection(payload.reason),
      ),
      connection.on("error", (payload) => setLastError(payload)),
      connection.on("artifactRejected", (payload) =>
        setLastArtifactRejection(payload.reason),
      ),
    ];

    // Adopt any state that changed between render and effect attachment.
    setConnectionState(connection.state);
    syncSnapshot();

    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [connection]);

  const clearMessageRejection = useCallback(() => setLastMessageRejection(null), []);
  const clearError = useCallback(() => setLastError(null), []);
  const clearArtifactRejection = useCallback(
    () => setLastArtifactRejection(null),
    [],
  );

  return {
    connection,
    connectionState,
    workspace,
    participants,
    messages,
    activeCount,
    artifactMeta,
    lastMessageRejection,
    clearMessageRejection,
    lastError,
    clearError,
    lastArtifactRejection,
    clearArtifactRejection,
  };
}

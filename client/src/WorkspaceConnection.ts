/**
 * WorkspaceConnection — the client transport that connects a session to the
 * Real-Time Workspace Server over a single WebSocket and keeps a local Yjs
 * document in sync with the authoritative server document.
 *
 * Responsibilities (task 13.1):
 *  - Open a WebSocket to a given URL and, on open, authenticate the session by
 *    sending a `join` envelope with `{ joinReference, displayName }`
 *    (Requirement 1.4). A same-session reconnect re-sends `join` automatically.
 *  - Parse inbound `{ type, workspaceId, payload }` envelopes and dispatch them
 *    to registered listeners (one channel per server event type).
 *  - Render the `workspaceSnapshot` delivered on join/rejoin: load the artifact
 *    `yjsState` (base64 -> bytes -> `Y.applyUpdate`) into the local `Y.Doc`, and
 *    expose the workspace, participant roster, artifact metadata, and the
 *    complete message log (Requirements 1.7, 8.5).
 *  - Apply server `artifactUpdate` events to the local `Y.Doc` and emit local
 *    edits back to the server as client `artifactUpdate` envelopes, avoiding
 *    echo loops via a remote-origin tag so applying a remote update never
 *    re-emits it (Requirement 6.3).
 *  - Send the remaining client intents (`sendMessage`, `addAgent`,
 *    `removeAgent`, `leave`, `export`).
 *  - Reconnect on unexpected socket close (re-open + re-join) and expose the
 *    connection state.
 *
 * Testability: the raw socket is abstracted behind {@link ClientSocket} and
 * created through an injectable {@link SocketFactory}, so unit tests drive a
 * fake socket with no real network or browser. The reconnect timer is injected
 * via {@link WorkspaceConnectionOptions.setTimeoutFn}.
 */

import * as Y from "yjs";
import type {
  ArtifactState,
  ClientToServerEvent,
  Message,
  Participant,
  ServerToClientEvent,
  Workspace,
  WorkspaceSnapshotPayload,
} from "@maw/shared";
import { base64ToBytes, bytesToBase64, isBase64 } from "./codec.js";

/** The shared `Y.Text` key inside the workspace `Y.Doc` (mirrors the server). */
export const ARTIFACT_TEXT_KEY = "content";

/**
 * Minimal socket surface the transport depends on. The browser `WebSocket`
 * satisfies this shape; tests supply a fake implementation.
 */
export interface ClientSocket {
  /** Send a serialized (JSON) envelope as a text frame. */
  send(data: string): void;
  /** Close the connection. */
  close(): void;
  /** Called once the socket is open and ready to send. */
  onopen: (() => void) | null;
  /** Called for each inbound text frame; only `data` is read. */
  onmessage: ((event: { data: string }) => void) | null;
  /** Called when the socket closes (gracefully or unexpectedly). */
  onclose: (() => void) | null;
  /** Called on a socket error. */
  onerror: ((error?: unknown) => void) | null;
}

/** Creates a {@link ClientSocket} for a URL. Injectable for tests. */
export type SocketFactory = (url: string) => ClientSocket;

/** Observable lifecycle state of the connection. */
export type ConnectionState =
  | "idle"
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed";

/**
 * Maps each server -> client event type to its payload, so {@link
 * WorkspaceConnection.on} is fully typed per channel.
 */
export type ServerEventPayloadMap = {
  [E in ServerToClientEvent as E["type"]]: E["payload"];
};

/** A listener for a specific server event channel. */
export type ServerEventListener<K extends keyof ServerEventPayloadMap> = (
  payload: ServerEventPayloadMap[K],
) => void;

/** Unsubscribe handle returned by every subscription method. */
export type Unsubscribe = () => void;

/** Options for creating a {@link WorkspaceConnection}. */
export interface WorkspaceConnectionOptions {
  /** WebSocket URL of the workspace server. */
  url: string;
  /** Shareable reference resolving to the workspace to join/create. */
  joinReference: string;
  /** Display name announced to the room. */
  displayName: string;
  /**
   * Optional stable participant id. When provided (e.g. the workspace creator
   * joining as the recorded Owner), the join is idempotent and does not create
   * a duplicate participant.
   */
  participantId?: string;
  /** Creates the underlying socket. Defaults to the browser `WebSocket`. */
  socketFactory?: SocketFactory;
  /** Whether to auto-reconnect on unexpected close. Defaults to `true`. */
  reconnect?: boolean;
  /** Delay before a reconnect attempt, in ms. Defaults to 1000. */
  reconnectDelayMs?: number;
  /** Timer seam for reconnect scheduling. Defaults to the global `setTimeout`. */
  setTimeoutFn?: (handler: () => void, ms: number) => void;
}

/** Default socket factory backed by the browser `WebSocket`. */
const defaultSocketFactory: SocketFactory = (url) =>
  new WebSocket(url) as unknown as ClientSocket;

/**
 * Union two message lists by id (later list wins on conflict) and return them
 * ordered by ascending `(timestamp, sequence)`. Used so a fresh snapshot never
 * drops messages the client already received.
 */
function mergeMessagesById(
  existing: readonly Message[],
  incoming: readonly Message[],
): Message[] {
  const byId = new Map<string, Message>();
  for (const m of existing) byId.set(m.id, m);
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) =>
    a.timestamp !== b.timestamp ? a.timestamp - b.timestamp : a.sequence - b.sequence,
  );
}

export class WorkspaceConnection {
  // --- configuration ------------------------------------------------------
  private readonly url: string;
  private readonly joinReference: string;
  private readonly displayName: string;
  private readonly initialParticipantId?: string;
  private readonly socketFactory: SocketFactory;
  private readonly reconnectEnabled: boolean;
  private readonly reconnectDelayMs: number;
  private readonly setTimeoutFn: (handler: () => void, ms: number) => void;

  // --- local CRDT state ---------------------------------------------------
  /** The local authoritative-mirror document bound by the artifact editor. */
  readonly doc = new Y.Doc();
  private readonly text = this.doc.getText(ARTIFACT_TEXT_KEY);
  /**
   * Origin tag used when applying updates that arrived from the server. Local
   * edits carry a different origin, so the doc-update observer can tell them
   * apart and only forward genuinely local edits to the server (no echo).
   */
  private readonly remoteOrigin = Symbol("maw:remote");

  // --- session state ------------------------------------------------------
  private socket: ClientSocket | null = null;
  private connectionState: ConnectionState = "idle";
  /** True once `close()` was called by the app; suppresses auto-reconnect. */
  private intentionalClose = false;
  /**
   * The workspace id learned from the first snapshot. Sent on subsequent
   * envelopes; empty until the first `join` resolves (the server resolves join
   * by reference and ignores the envelope id for `join`).
   */
  private workspaceId = "";

  // --- rendered snapshot (exposed to the UI in 13.2/13.3) -----------------
  private workspace: Workspace | null = null;
  private participants: Participant[] = [];
  private messages: Message[] = [];
  private artifactMeta: Omit<ArtifactState, "yjsState"> | null = null;

  // --- subscriptions ------------------------------------------------------
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
  private readonly stateListeners = new Set<(state: ConnectionState) => void>();

  constructor(options: WorkspaceConnectionOptions) {
    this.url = options.url;
    this.joinReference = options.joinReference;
    this.displayName = options.displayName;
    this.initialParticipantId = options.participantId;
    this.socketFactory = options.socketFactory ?? defaultSocketFactory;
    this.reconnectEnabled = options.reconnect ?? true;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1000;
    this.setTimeoutFn =
      options.setTimeoutFn ?? ((handler, ms) => void setTimeout(handler, ms));

    // Forward genuinely local edits (editor typing) to the server. Updates we
    // applied from the server carry `remoteOrigin` and are skipped, breaking
    // the echo loop (Requirement 6.3).
    this.doc.on("update", this.handleLocalDocUpdate);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Open the socket and join the workspace. Idempotent while already open. */
  connect(): void {
    if (this.connectionState === "open" || this.connectionState === "connecting") {
      return;
    }
    this.intentionalClose = false;
    this.openSocket();
  }

  /**
   * Gracefully leave and close the connection. Sends a `leave` envelope (best
   * effort) and suppresses auto-reconnect.
   */
  close(): void {
    this.intentionalClose = true;
    if (this.socket && this.connectionState === "open") {
      this.sendEnvelope({ type: "leave", workspaceId: this.workspaceId, payload: {} });
    }
    this.socket?.close();
    this.socket = null;
    this.setState("closed");
  }

  /** The current connection lifecycle state. */
  get state(): ConnectionState {
    return this.connectionState;
  }

  /** Subscribe to connection-state changes; returns an unsubscribe handle. */
  onStateChange(listener: (state: ConnectionState) => void): Unsubscribe {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  // -------------------------------------------------------------------------
  // Client -> server intents
  // -------------------------------------------------------------------------

  /** Post a chat message. Requirement 3.1 (server validates + stamps). */
  sendMessage(content: string): void {
    this.sendEnvelope({
      type: "sendMessage",
      workspaceId: this.workspaceId,
      payload: { content },
    });
  }

  /** Add an agent teammate to the workspace. Requirement 4.1. */
  addAgent(displayName: string, persona?: string): void {
    this.sendEnvelope({
      type: "addAgent",
      workspaceId: this.workspaceId,
      payload: persona === undefined ? { displayName } : { displayName, persona },
    });
  }

  /** Remove an agent teammate from the workspace. Requirement 4.4. */
  removeAgent(agentId: string): void {
    this.sendEnvelope({
      type: "removeAgent",
      workspaceId: this.workspaceId,
      payload: { agentId },
    });
  }

  /** Request a Markdown export of the current artifact. Requirement 7.1. */
  requestExport(): void {
    this.sendEnvelope({ type: "export", workspaceId: this.workspaceId, payload: {} });
  }

  // -------------------------------------------------------------------------
  // Rendered snapshot accessors (consumed by 13.2 / 13.3 UI)
  // -------------------------------------------------------------------------

  /** The shared `Y.Text` the artifact editor binds to. */
  getText(): Y.Text {
    return this.text;
  }

  /** The current artifact content string. */
  getContent(): string {
    return this.text.toString();
  }

  /** The joined workspace, or null before the first snapshot. */
  getWorkspace(): Workspace | null {
    return this.workspace;
  }

  /** A copy of the current participant roster. */
  getParticipants(): Participant[] {
    return [...this.participants];
  }

  /** A copy of the message log in `(timestamp, sequence)` order. */
  getMessages(): Message[] {
    return [...this.messages];
  }

  /** Artifact metadata (type, last editor, timestamps) without the CRDT state. */
  getArtifactMeta(): Omit<ArtifactState, "yjsState"> | null {
    return this.artifactMeta;
  }

  // -------------------------------------------------------------------------
  // Subscriptions
  // -------------------------------------------------------------------------

  /**
   * Subscribe to a server event channel (e.g. `messageAppended`,
   * `presenceUpdate`, `workspaceSnapshot`). Returns an unsubscribe handle.
   */
  on<K extends keyof ServerEventPayloadMap>(
    type: K,
    listener: ServerEventListener<K>,
  ): Unsubscribe {
    let channel = this.listeners.get(type as string);
    if (!channel) {
      channel = new Set();
      this.listeners.set(type as string, channel);
    }
    const wrapped = listener as (payload: unknown) => void;
    channel.add(wrapped);
    return () => channel.delete(wrapped);
  }

  // -------------------------------------------------------------------------
  // Socket wiring
  // -------------------------------------------------------------------------

  private openSocket(): void {
    this.setState("connecting");
    const socket = this.socketFactory(this.url);
    this.socket = socket;

    socket.onopen = () => {
      this.setState("open");
      // Authenticate the (re)connected session by joining. On a reconnect this
      // re-establishes presence and yields a fresh snapshot (Requirement 1.4).
      this.sendEnvelope({
        type: "join",
        workspaceId: this.workspaceId,
        payload: {
          joinReference: this.joinReference,
          displayName: this.displayName,
          ...(this.initialParticipantId
            ? { participantId: this.initialParticipantId }
            : {}),
        },
      });
    };

    socket.onmessage = (event) => this.handleServerFrame(event.data);

    socket.onclose = () => {
      this.socket = null;
      if (this.intentionalClose) {
        this.setState("closed");
        return;
      }
      if (this.reconnectEnabled) {
        this.setState("reconnecting");
        this.setTimeoutFn(() => {
          if (!this.intentionalClose) this.openSocket();
        }, this.reconnectDelayMs);
      } else {
        this.setState("closed");
      }
    };

    socket.onerror = () => {
      // Errors are followed by a close; reconnect handling lives in onclose.
    };
  }

  // -------------------------------------------------------------------------
  // Inbound server events
  // -------------------------------------------------------------------------

  private handleServerFrame(data: string): void {
    let event: ServerToClientEvent;
    try {
      event = JSON.parse(data) as ServerToClientEvent;
    } catch {
      // Ignore malformed frames from the server rather than crashing the UI.
      return;
    }
    if (typeof event !== "object" || event === null || typeof event.type !== "string") {
      return;
    }

    // Apply transport-level side effects before notifying subscribers so that
    // a listener firing on `workspaceSnapshot` sees the synced doc/roster.
    switch (event.type) {
      case "workspaceSnapshot":
        this.applySnapshot(event.payload);
        break;
      case "artifactUpdate":
        this.applyRemoteArtifactUpdate(event.payload.yjsUpdate);
        break;
      case "messageAppended":
        // Ignore a message we already have (e.g. echoed after a resync).
        if (!this.messages.some((m) => m.id === event.payload.message.id)) {
          this.messages = [...this.messages, event.payload.message];
        }
        break;
      case "agentAdded":
        this.upsertParticipant(event.payload.participant);
        break;
      case "agentRemoved":
        this.participants = this.participants.filter(
          (p) => p.id !== event.payload.agentId,
        );
        break;
      case "presenceUpdate":
        this.applyPresenceUpdate(
          event.payload.participantId,
          event.payload.presenceState,
        );
        break;
      default:
        break;
    }

    this.emit(event.type, event.payload);
  }

  /**
   * Render a `workspaceSnapshot`: adopt the roster/messages/metadata and load
   * the artifact CRDT state into the local doc under the remote origin so the
   * initial sync is not re-emitted back to the server (Requirements 1.7, 8.5).
   */
  private applySnapshot(payload: WorkspaceSnapshotPayload): void {
    this.workspace = payload.workspace;
    this.workspaceId = payload.workspace.id;
    this.participants = [...payload.participants];
    // Merge (union by id) the snapshot's messages with any already on screen so
    // a reconnect/rejoin can never drop a message the client has already seen.
    // Ordered by (timestamp, sequence) to match the server's total order.
    this.messages = mergeMessagesById(this.messages, payload.messages);

    const { yjsState, ...meta } = payload.artifact;
    this.artifactMeta = meta;

    if (isBase64(yjsState) && yjsState.length > 0) {
      const state = base64ToBytes(yjsState);
      // Applying under remoteOrigin syncs the local doc toward the server state
      // (Yjs merges idempotently) without triggering an outbound artifactUpdate.
      Y.applyUpdate(this.doc, state, this.remoteOrigin);
    }
  }

  /** Apply a server-broadcast CRDT edit to the local doc without echoing it. */
  private applyRemoteArtifactUpdate(yjsUpdate: string): void {
    if (!isBase64(yjsUpdate) || yjsUpdate.length === 0) return;
    const update = base64ToBytes(yjsUpdate);
    try {
      Y.applyUpdate(this.doc, update, this.remoteOrigin);
    } catch {
      // A malformed update from the wire should not crash the client.
    }
  }

  /** Forward a genuinely local edit as a client `artifactUpdate` envelope. */
  private readonly handleLocalDocUpdate = (
    update: Uint8Array,
    origin: unknown,
  ): void => {
    if (origin === this.remoteOrigin) return; // Applied from the server: no echo.
    if (this.connectionState !== "open") return; // Buffered locally until open.
    this.sendEnvelope({
      type: "artifactUpdate",
      workspaceId: this.workspaceId,
      payload: { yjsUpdate: bytesToBase64(update) },
    });
  };

  private applyPresenceUpdate(
    participantId: string,
    presenceState: Participant["presenceState"],
  ): void {
    this.participants = this.participants.map((p) =>
      p.id === participantId ? { ...p, presenceState } : p,
    );
  }

  private upsertParticipant(participant: Participant): void {
    const index = this.participants.findIndex((p) => p.id === participant.id);
    if (index === -1) {
      this.participants = [...this.participants, participant];
    } else {
      const next = [...this.participants];
      next[index] = participant;
      this.participants = next;
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private sendEnvelope(event: ClientToServerEvent): void {
    if (!this.socket || this.connectionState !== "open") return;
    this.socket.send(JSON.stringify(event));
  }

  private emit(type: string, payload: unknown): void {
    const channel = this.listeners.get(type);
    if (!channel) return;
    for (const listener of [...channel]) listener(payload);
  }

  private setState(state: ConnectionState): void {
    if (this.connectionState === state) return;
    this.connectionState = state;
    for (const listener of [...this.stateListeners]) listener(state);
  }

  /** Release the local doc observer and any subscriptions. */
  destroy(): void {
    this.doc.off("update", this.handleLocalDocUpdate);
    this.listeners.clear();
    this.stateListeners.clear();
    this.socket?.close();
    this.socket = null;
  }
}

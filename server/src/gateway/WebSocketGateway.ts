/**
 * WebSocketGateway — the transport boundary that wires the client event
 * contract to the Room Manager and services (design: "WebSocket Gateway").
 *
 * Responsibilities (task 11.1):
 *  - Accept connections and authenticate each session to a workspace via
 *    `join` (Requirements 1.4, 1.7).
 *  - Schema-validate ALL inbound envelopes; malformed frames are dropped with a
 *    `MALFORMED_EVENT` error and never mutate room state (design: "Untrusted
 *    input").
 *  - Route typed client -> server events (`join`, `sendMessage`,
 *    `artifactUpdate`, `addAgent`, `removeAgent`, `leave`, `export`) to the
 *    {@link RoomManager} / {@link WorkspaceService} / {@link ExportService}.
 *  - Emit server -> client events (`workspaceSnapshot`, `presenceUpdate`,
 *    `participantCountUpdate`, `messageAppended`, `messageRejected`,
 *    `artifactUpdate`, `artifactRejected`, `agentResponseDelta`, `agentAdded`,
 *    `agentRemoved`, `exportReady`, `error`).
 *  - On join/rejoin build and send a `workspaceSnapshot` with the current
 *    artifact content and the complete message log in `(timestamp, sequence)`
 *    order (Requirements 1.7, 8.5).
 *  - Detect missed heartbeats and reap the disconnected session's presence
 *    (Requirements 2.1–2.3).
 *
 * Testability: the gateway is written against the {@link GatewayConnection}
 * seam and never touches a real socket or timer directly. Heartbeat sweeps are
 * driven by {@link runHeartbeatSweep} (invoked either by an injected scheduler
 * in production or directly by tests), and deferred agent-response flows are
 * awaited via {@link idle}.
 */

import { randomUUID } from "node:crypto";
import {
  type ArtifactRejectionReason,
  type ClientToServerEvent,
  type ErrorCode,
  type Message,
  type MessageRejectionReason,
  type Participant,
  type ServerToClientEvent,
  type ArtifactState,
  type Workspace,
  type WorkspaceSnapshotPayload,
} from "@maw/shared";
import type { WorkspaceStore } from "../store/index.js";
import type { WorkspaceService } from "../workspace/WorkspaceService.js";
import type { RoomManager } from "../room/RoomManager.js";
import type { PresenceChange } from "../presence/index.js";
import {
  createExportService,
  EXPORT_REASON_TO_ERROR_CODE,
  type ExportService,
} from "../export/index.js";
import type { GatewayConnection } from "./Connection.js";
import { base64ToBytes, bytesToBase64, isBase64 } from "./codec.js";
import { validateEnvelope } from "./validate.js";

/** The validation-only message rejection reasons the wire contract carries. */
const MESSAGE_REJECTION_REASONS: ReadonlySet<MessageRejectionReason> = new Set([
  "EMPTY",
  "WHITESPACE_ONLY",
  "TOO_LONG",
]);

/** A minimal `setInterval`/`clearInterval` seam so tests avoid real timers. */
export interface HeartbeatScheduler {
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/** Injectable collaborators/seams for the gateway. */
export interface WebSocketGatewayDeps {
  workspaceService: WorkspaceService;
  roomManager: RoomManager;
  store: WorkspaceStore;
  /**
   * Export service used by the `export` route. Defaults to one backed by the
   * room manager's artifact service (current content + type per workspace).
   */
  exportService?: ExportService;
}

/** Optional configuration/seams. */
export interface WebSocketGatewayOptions {
  /** Millisecond clock; defaults to `Date.now`. */
  now?: () => number;
  /** Heartbeat sweep interval in ms; defaults to 10_000. */
  heartbeatIntervalMs?: number;
  /** Timer seam; defaults to the global timers. */
  scheduler?: HeartbeatScheduler;
  /** Session id generator; defaults to `crypto.randomUUID`. */
  newSessionId?: () => string;
}

/** Per-connection session state, keyed by a generated session id. */
interface Session {
  id: string;
  connection: GatewayConnection;
  /** Authenticated workspace id; null until a successful `join`. */
  workspaceId: string | null;
  /** Authenticated participant id; null until a successful `join`. */
  participantId: string | null;
  /** Heartbeat liveness flag; reset each sweep, set true on `pong`. */
  alive: boolean;
}

export class WebSocketGateway {
  private readonly workspaceService: WorkspaceService;
  private readonly roomManager: RoomManager;
  private readonly store: WorkspaceStore;
  private readonly exportService: ExportService;

  private readonly now: () => number;
  private readonly heartbeatIntervalMs: number;
  private readonly scheduler: HeartbeatScheduler;
  private readonly newSessionId: () => string;

  /** All live sessions, keyed by session id. */
  private readonly sessions = new Map<string, Session>();
  /** Per-workspace sets of joined sessions, for broadcasting. */
  private readonly rooms = new Map<string, Set<Session>>();
  /** In-flight deferred work (agent-response flows) awaited by {@link idle}. */
  private readonly pending = new Set<Promise<unknown>>();

  private heartbeatHandle: unknown;

  constructor(deps: WebSocketGatewayDeps, options: WebSocketGatewayOptions = {}) {
    this.workspaceService = deps.workspaceService;
    this.roomManager = deps.roomManager;
    this.store = deps.store;
    // Default the export service to read the current artifact from the room.
    this.exportService =
      deps.exportService ??
      createExportService((workspaceId) => {
        const artifactType = this.roomManager.artifacts.getArtifactType(workspaceId);
        if (artifactType === null) return null;
        return {
          workspaceId,
          artifactType,
          content: this.roomManager.artifacts.getContent(workspaceId),
        };
      });

    this.now = options.now ?? (() => Date.now());
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.newSessionId = options.newSessionId ?? (() => randomUUID());
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  /**
   * Register a freshly accepted connection: create its session, wire the
   * inbound handlers, and return the session id. The session is unauthenticated
   * until a successful `join`.
   */
  handleConnection(connection: GatewayConnection): string {
    const session: Session = {
      id: this.newSessionId(),
      connection,
      workspaceId: null,
      participantId: null,
      alive: true,
    };
    this.sessions.set(session.id, session);

    connection.onMessage((data) => this.dispatch(session, data));
    connection.onClose(() => this.handleDisconnect(session));
    connection.onPong(() => {
      session.alive = true;
      if (session.workspaceId && session.participantId) {
        this.roomManager
          .getPresence(session.workspaceId)
          ?.heartbeat(session.participantId, this.now());
      }
    });

    return session.id;
  }

  /**
   * Validate and route a single inbound frame. Malformed frames are dropped
   * with a `MALFORMED_EVENT` error and never touch room state.
   */
  async dispatch(session: Session, raw: string): Promise<void> {
    const validation = validateEnvelope(raw);
    if (!validation.ok) {
      this.sendError(session, "MALFORMED_EVENT", "Malformed or unknown event.");
      return;
    }
    await this.route(session, validation.event);
  }

  private async route(
    session: Session,
    event: ClientToServerEvent,
  ): Promise<void> {
    switch (event.type) {
      case "join":
        await this.onJoin(session, event.payload);
        return;
      case "sendMessage":
        await this.onSendMessage(session, event.payload.content);
        return;
      case "artifactUpdate":
        await this.onArtifactUpdate(session, event.payload.yjsUpdate);
        return;
      case "addAgent":
        await this.onAddAgent(session, event.payload);
        return;
      case "removeAgent":
        await this.onRemoveAgent(session, event.payload.agentId);
        return;
      case "leave":
        this.onLeave(session);
        return;
      case "export":
        this.onExport(session);
        return;
      case "saveHistory":
        await this.onSaveHistory(session, event.payload.content);
        return;
      case "deleteHistory":
        await this.onDeleteHistory(session, event.payload.id);
        return;
      default: {
        // Exhaustiveness guard: unreachable for a validated event.
        const _never: never = event;
        void _never;
        this.sendError(session, "MALFORMED_EVENT", "Malformed or unknown event.");
      }
    }
  }

  // -------------------------------------------------------------------------
  // Routes
  // -------------------------------------------------------------------------

  /**
   * `join`: resolve the reference, register the human, associate the session,
   * send the `workspaceSnapshot`, and broadcast presence/count. Requirements
   * 1.4, 1.7, 2.1, 2.5, 8.5.
   */
  private async onJoin(
    session: Session,
    payload: { joinReference: string; displayName: string; participantId?: string },
  ): Promise<void> {
    // Prefer an explicit participantId (e.g. the creator joining as the Owner),
    // then the existing session id on a same-session rejoin, so join stays
    // idempotent and never creates a duplicate participant (1.5).
    const participantId = payload.participantId ?? session.participantId ?? undefined;
    const joined = await this.workspaceService.join({
      joinReference: payload.joinReference,
      displayName: payload.displayName,
      ...(participantId ? { participantId } : {}),
    });
    if (!joined.ok) {
      this.sendError(session, "WORKSPACE_NOT_FOUND", joined.message);
      return;
    }

    const workspaceId = joined.workspace.id;
    await this.roomManager.ensureRoom(workspaceId);
    const presence = await this.roomManager.registerHuman(
      workspaceId,
      joined.participant,
    );

    // Authenticate + attach the session to the room before broadcasting.
    session.workspaceId = workspaceId;
    session.participantId = joined.participant.id;
    session.alive = true;
    this.attach(session, workspaceId);

    // Full state on join (Requirements 1.7, 8.5).
    const snapshot = await this.buildSnapshot(
      workspaceId,
      joined.workspace,
      joined.participant.displayName,
    );
    if (snapshot === null) {
      this.sendError(
        session,
        "INTERNAL_ERROR",
        "Workspace state is unavailable.",
      );
      return;
    }
    this.send(session, {
      type: "workspaceSnapshot",
      workspaceId,
      payload: snapshot,
    });

    // Announce the new participant to others; count to everyone.
    this.broadcastPresence(workspaceId, presence, { excludeSessionId: session.id });
  }

  /**
   * `sendMessage`: validate + stamp + persist + broadcast, then (for a human
   * message that mentions an agent) trigger the agent flow. Requirements 3.1,
   * 3.2, 3.3.
   */
  private async onSendMessage(
    session: Session,
    content: string,
  ): Promise<void> {
    if (!session.workspaceId || !session.participantId) {
      this.sendError(session, "MALFORMED_EVENT", "Join a workspace first.");
      return;
    }
    const workspaceId = session.workspaceId;

    const result = await this.roomManager.submitMessage(
      workspaceId,
      session.participantId,
      content,
    );

    if (!result.ok) {
      if (MESSAGE_REJECTION_REASONS.has(result.reason as MessageRejectionReason)) {
        this.send(session, {
          type: "messageRejected",
          workspaceId,
          payload: { reason: result.reason as MessageRejectionReason },
        });
      } else {
        // SAVE_FAILED: the message was not durably persisted (Requirement 8.2).
        this.sendError(session, "INTERNAL_ERROR", "Message was not saved.");
      }
      return;
    }

    this.broadcast(workspaceId, {
      type: "messageAppended",
      workspaceId,
      payload: { message: result.message },
    });

    // A human message that names an agent triggers that agent's response flow.
    this.maybeTriggerAgent(workspaceId, result.message);
  }

  /**
   * `artifactUpdate`: decode, apply through the CRDT service, and rebroadcast
   * the update to peers, or reject to the sender. Requirements 6.3–6.6, 8.4.
   */
  private async onArtifactUpdate(
    session: Session,
    yjsUpdate: string,
  ): Promise<void> {
    if (!session.workspaceId || !session.participantId) {
      this.sendError(session, "MALFORMED_EVENT", "Join a workspace first.");
      return;
    }
    const workspaceId = session.workspaceId;
    const editorId = session.participantId;

    if (!isBase64(yjsUpdate)) {
      this.sendError(session, "MALFORMED_EVENT", "Invalid artifact update encoding.");
      return;
    }
    const update = base64ToBytes(yjsUpdate);

    let result: Awaited<ReturnType<RoomManager["applyArtifactUpdate"]>>;
    try {
      result = await this.roomManager.applyArtifactUpdate(
        workspaceId,
        update,
        editorId,
      );
    } catch {
      // A structurally-valid base64 string that is not a valid Yjs update.
      this.sendError(session, "MALFORMED_EVENT", "Invalid artifact update.");
      return;
    }

    if (!result.ok) {
      this.send(session, {
        type: "artifactRejected",
        workspaceId,
        payload: { reason: result.reason as ArtifactRejectionReason },
      });
      return;
    }

    const { editedAt } = this.roomManager.artifacts.getLastEditor(workspaceId);
    // Deliver the CRDT edit to the OTHER clients (the sender already has it).
    this.broadcast(
      workspaceId,
      {
        type: "artifactUpdate",
        workspaceId,
        payload: {
          yjsUpdate: bytesToBase64(update),
          lastEditorId: editorId,
          lastEditedAt: editedAt ?? this.now(),
        },
      },
      { excludeSessionId: session.id },
    );
  }

  /** `addAgent`: add through the room manager and broadcast, or reject. */
  private async onAddAgent(
    session: Session,
    payload: { displayName: string; persona?: string },
  ): Promise<void> {
    if (!session.workspaceId) {
      this.sendError(session, "MALFORMED_EVENT", "Join a workspace first.");
      return;
    }
    const workspaceId = session.workspaceId;

    const result = await this.roomManager.addAgent(workspaceId, payload);
    if (!result.ok) {
      this.sendError(
        session,
        "AGENT_LIMIT_REACHED",
        "The maximum number of agents has been reached.",
      );
      return;
    }

    this.broadcast(workspaceId, {
      type: "agentAdded",
      workspaceId,
      payload: { participant: result.participant },
    });
    this.broadcastPresence(workspaceId, result.presence);
  }

  /** `removeAgent`: remove through the room manager and broadcast, or reject. */
  private async onRemoveAgent(
    session: Session,
    agentId: string,
  ): Promise<void> {
    if (!session.workspaceId) {
      this.sendError(session, "MALFORMED_EVENT", "Join a workspace first.");
      return;
    }
    const workspaceId = session.workspaceId;

    const result = await this.roomManager.removeAgent(workspaceId, agentId);
    if (!result.ok) {
      this.sendError(session, "AGENT_NOT_FOUND", "The agent was not found.");
      return;
    }

    this.broadcast(workspaceId, {
      type: "agentRemoved",
      workspaceId,
      payload: { agentId: result.agentId },
    });
    this.broadcastPresence(workspaceId, result.presence);
  }

  /** `leave`: graceful session end — remove presence and broadcast. Req 2.2. */
  private onLeave(session: Session): void {
    if (!session.workspaceId || !session.participantId) return;
    const workspaceId = session.workspaceId;
    const presence = this.roomManager
      .getPresence(workspaceId)
      ?.leave(session.participantId, this.now());
    this.detach(session);
    if (presence) this.broadcastPresence(workspaceId, presence);
  }

  /** `export`: produce Markdown for the requester, or surface the failure. */
  private onExport(session: Session): void {
    if (!session.workspaceId) {
      this.sendError(session, "MALFORMED_EVENT", "Join a workspace first.");
      return;
    }
    const workspaceId = session.workspaceId;

    const result = this.exportService.export(workspaceId);
    if (!result.ok) {
      const code: ErrorCode = EXPORT_REASON_TO_ERROR_CODE[result.reason];
      const message =
        result.reason === "EMPTY"
          ? "The artifact is empty; nothing to export."
          : "The export could not be produced.";
      this.sendError(session, code, message);
      return;
    }

    this.send(session, {
      type: "exportReady",
      workspaceId,
      payload: { filename: result.filename, markdown: result.markdown },
    });
  }

  /**
   * `saveHistory`: persist the current shared-result content as a durable,
   * shared history entry attributed to the saver, then broadcast the updated
   * history to everyone.
   */
  private async onSaveHistory(session: Session, content: string): Promise<void> {
    if (!session.workspaceId || !session.participantId) {
      this.sendError(session, "MALFORMED_EVENT", "Join a workspace first.");
      return;
    }
    const workspaceId = session.workspaceId;
    if (content.trim().length === 0) return; // Nothing to save.

    const saver = this.roomManager.getParticipant(
      workspaceId,
      session.participantId,
    );
    const entry = {
      id: randomUUID(),
      workspaceId,
      content,
      savedById: session.participantId,
      savedByName: saver?.displayName ?? "Unknown",
      savedAt: this.now(),
    };
    try {
      await this.store.saveHistoryEntry(entry);
    } catch {
      this.sendError(session, "INTERNAL_ERROR", "Could not save to history.");
      return;
    }
    // History is private per user (keyed by display name so it survives
    // rejoins and origin/IP changes): update this user's own sessions.
    await this.sendHistoryToName(workspaceId, entry.savedByName);
  }

  /** `deleteHistory`: delete the caller's saved entry, then refresh their list. */
  private async onDeleteHistory(session: Session, id: string): Promise<void> {
    if (!session.workspaceId || !session.participantId) {
      this.sendError(session, "MALFORMED_EVENT", "Join a workspace first.");
      return;
    }
    const workspaceId = session.workspaceId;
    const callerName = this.resolveParticipantName(
      workspaceId,
      session.participantId,
    );
    // Only allow deleting an entry the caller owns (private history by name).
    const all = await this.store.loadHistory(workspaceId);
    const target = all.find((e) => e.id === id);
    if (!target || (callerName !== null && target.savedByName !== callerName)) {
      if (callerName !== null) await this.sendHistoryToName(workspaceId, callerName);
      return;
    }
    try {
      await this.store.deleteHistoryEntry(workspaceId, id);
    } catch {
      this.sendError(session, "INTERNAL_ERROR", "Could not delete history entry.");
      return;
    }
    if (callerName !== null) await this.sendHistoryToName(workspaceId, callerName);
  }

  /** Resolve a participant's current display name in a room, or null. */
  private resolveParticipantName(
    workspaceId: string,
    participantId: string,
  ): string | null {
    return (
      this.roomManager.getParticipant(workspaceId, participantId)?.displayName ??
      null
    );
  }

  /**
   * Send the saved-result history for a given display name (private per user,
   * keyed by name so it survives rejoins/origin changes) to every session in
   * the room currently identified by that name.
   */
  private async sendHistoryToName(
    workspaceId: string,
    displayName: string,
  ): Promise<void> {
    const all = await this.store.loadHistory(workspaceId);
    const entries = all.filter((e) => e.savedByName === displayName);
    const room = this.rooms.get(workspaceId);
    if (!room) return;
    const event: ServerToClientEvent = {
      type: "historyUpdated",
      workspaceId,
      payload: { entries },
    };
    const serialized = JSON.stringify(event);
    for (const s of room) {
      if (
        s.participantId &&
        this.resolveParticipantName(workspaceId, s.participantId) === displayName
      ) {
        s.connection.send(serialized);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Agent orchestration
  // -------------------------------------------------------------------------

  /**
   * If `message` is a human message that names an agent by display name (simple
   * `@DisplayName` mention detection), trigger that agent's response flow and
   * broadcast its results. The flow is deferred (not awaited by the message
   * route) so a slow Bedrock call never blocks inbound processing; {@link idle}
   * awaits it in tests.
   */
  private maybeTriggerAgent(workspaceId: string, message: Message): void {
    if (message.senderType !== "human") return;
    if (!this.roomManager.agentService) return;

    const agentId = this.detectMentionedAgent(workspaceId, message.content);
    if (agentId === null) return;

    this.track(this.runAgentResponse(workspaceId, agentId));
  }

  /** First agent whose display name is mentioned as `@DisplayName`, or null. */
  private detectMentionedAgent(
    workspaceId: string,
    content: string,
  ): string | null {
    for (const participant of this.roomManager.getRoster(workspaceId)) {
      if (participant.type !== "agent") continue;
      if (content.includes(`@${participant.displayName}`)) {
        return participant.id;
      }
    }
    return null;
  }

  /** Run the agent response flow and broadcast its presence/message/artifact. */
  private async runAgentResponse(
    workspaceId: string,
    agentId: string,
  ): Promise<void> {
    const result = await this.roomManager.triggerAgentResponse(
      workspaceId,
      agentId,
      {
        // Broadcast the agent's `processing` presence while generation is in
        // flight (Requirement 5.3).
        onProcessing: (change) => this.broadcastPresence(workspaceId, change),
      },
    );

    if (!result.ok) return;

    if (result.message) {
      this.broadcast(workspaceId, {
        type: "messageAppended",
        workspaceId,
        payload: { message: result.message },
      });
    }

    if (result.artifact) {
      this.broadcast(workspaceId, {
        type: "artifactUpdate",
        workspaceId,
        payload: {
          yjsUpdate: bytesToBase64(result.artifact.yjsUpdate),
          lastEditorId: result.artifact.lastEditorId,
          lastEditedAt: result.artifact.lastEditedAt,
        },
      });
    }

    // Revert the agent to active (Requirement 5.3).
    this.broadcastPresence(workspaceId, result.idlePresence);
  }

  // -------------------------------------------------------------------------
  // Heartbeat
  // -------------------------------------------------------------------------

  /** Begin periodic heartbeat sweeps using the injected scheduler. */
  start(): void {
    if (this.heartbeatHandle !== undefined) return;
    this.heartbeatHandle = this.scheduler.setInterval(
      () => this.runHeartbeatSweep(),
      this.heartbeatIntervalMs,
    );
  }

  /** Stop periodic heartbeat sweeps. */
  stop(): void {
    if (this.heartbeatHandle === undefined) return;
    this.scheduler.clearInterval(this.heartbeatHandle);
    this.heartbeatHandle = undefined;
  }

  /**
   * One heartbeat sweep: a session that did not reply `pong` since the previous
   * sweep is treated as disconnected and reaped (presence removed + broadcast);
   * a live session is re-pinged and its liveness flag cleared until its next
   * pong (Requirements 2.1–2.3).
   */
  runHeartbeatSweep(): void {
    for (const session of [...this.sessions.values()]) {
      if (!session.alive) {
        this.handleDisconnect(session);
        continue;
      }
      session.alive = false;
      session.connection.ping();
    }
  }

  // -------------------------------------------------------------------------
  // Disconnect / teardown
  // -------------------------------------------------------------------------

  /** Reap a session: remove presence, broadcast, and forget the session. */
  private handleDisconnect(session: Session): void {
    if (!this.sessions.has(session.id)) return;
    if (session.workspaceId && session.participantId) {
      const presence = this.roomManager
        .getPresence(session.workspaceId)
        ?.leave(session.participantId, this.now());
      const workspaceId = session.workspaceId;
      this.detach(session);
      if (presence) this.broadcastPresence(workspaceId, presence);
    }
    this.sessions.delete(session.id);
  }

  /**
   * Await all deferred agent-response flows. Test-only convenience so a test
   * can assert on broadcasts produced after a triggering message settles.
   */
  async idle(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
  }

  // -------------------------------------------------------------------------
  // Snapshot building
  // -------------------------------------------------------------------------

  /**
   * Build the `workspaceSnapshot` payload: current artifact content + encoded
   * state, the participant roster from durable storage, and the complete
   * message log ordered by `(timestamp, sequence)` (Requirements 1.7, 8.5).
   * Returns null when the artifact snapshot is missing (an internal error).
   */
  private async buildSnapshot(
    workspaceId: string,
    workspace: Workspace,
    displayName: string,
  ): Promise<WorkspaceSnapshotPayload | null> {
    const artifactSnapshot = await this.store.loadArtifact(workspaceId);
    if (artifactSnapshot === null) return null;

    const storedParticipants: Participant[] = await this.store.loadParticipants(
      workspaceId,
    );
    // Reconcile the persisted roster against live presence. Human participants
    // are session-bound: a stored `active` state from an earlier session that
    // was never gracefully closed (e.g. a tab closed on an old build) must not
    // linger as active in a fresh snapshot. Any human who is not currently
    // connected in this room's presence is reported as `disconnected` so the
    // client filters them out and the active count reflects only live sessions.
    // Agents are durable teammates, not sessions, so their state is preserved.
    const livePresence = this.roomManager.getPresence(workspaceId);
    const participants: Participant[] = storedParticipants.map((p) => {
      if (p.type === "agent") return p;
      const liveState = livePresence?.getPresence(p.id) ?? null;
      return {
        ...p,
        presenceState:
          liveState !== null && liveState !== "disconnected"
            ? liveState
            : "disconnected",
      };
    });
    const messages: Message[] = await this.store.loadMessages(workspaceId);
    // History is private per user, keyed by display name so it survives
    // rejoins and origin/IP changes: only this user's own entries.
    const history = (await this.store.loadHistory(workspaceId)).filter(
      (e) => e.savedByName === displayName,
    );

    // Prefer the authoritative in-memory content (warmed via ensureRoom); fall
    // back to the persisted snapshot content if the room is somehow unloaded.
    const content =
      this.roomManager.artifacts.getContent(workspaceId) ||
      artifactSnapshot.content;

    const artifact: ArtifactState = {
      id: artifactSnapshot.id,
      workspaceId,
      artifactType: artifactSnapshot.artifactType,
      content,
      lastEditorId: artifactSnapshot.lastEditorId,
      lastEditedAt: artifactSnapshot.lastEditedAt,
      yjsState: bytesToBase64(artifactSnapshot.yjsState),
    };

    return { workspace, participants, artifact, messages, history };
  }

  // -------------------------------------------------------------------------
  // Room membership + broadcasting
  // -------------------------------------------------------------------------

  private attach(session: Session, workspaceId: string): void {
    let room = this.rooms.get(workspaceId);
    if (!room) {
      room = new Set<Session>();
      this.rooms.set(workspaceId, room);
    }
    room.add(session);
  }

  private detach(session: Session): void {
    if (!session.workspaceId) return;
    this.rooms.get(session.workspaceId)?.delete(session);
    session.workspaceId = null;
    session.participantId = null;
  }

  /** Send a serialized envelope to a single session. */
  private send(session: Session, event: ServerToClientEvent): void {
    session.connection.send(JSON.stringify(event));
  }

  /** Send a structured `error` event to a single session. */
  private sendError(session: Session, code: ErrorCode, message: string): void {
    this.send(session, {
      type: "error",
      workspaceId: session.workspaceId ?? "",
      payload: { code, message },
    });
  }

  /** Broadcast an envelope to every session in a room (optionally excluding one). */
  private broadcast(
    workspaceId: string,
    event: ServerToClientEvent,
    options: { excludeSessionId?: string } = {},
  ): void {
    const room = this.rooms.get(workspaceId);
    if (!room) return;
    const serialized = JSON.stringify(event);
    for (const session of room) {
      if (session.id === options.excludeSessionId) continue;
      session.connection.send(serialized);
    }
  }

  /**
   * Broadcast a {@link PresenceChange}: each presence update (optionally
   * excluding the origin session, e.g. the joiner) plus a
   * `participantCountUpdate` to everyone when the active count changed.
   */
  private broadcastPresence(
    workspaceId: string,
    change: PresenceChange,
    options: { excludeSessionId?: string } = {},
  ): void {
    for (const update of change.updates) {
      this.broadcast(
        workspaceId,
        { type: "presenceUpdate", workspaceId, payload: update },
        options,
      );
    }
    if (change.countChanged) {
      this.broadcast(workspaceId, {
        type: "participantCountUpdate",
        workspaceId,
        payload: { activeCount: change.activeCount },
      });
    }
  }

  // -------------------------------------------------------------------------
  // Deferred-work tracking
  // -------------------------------------------------------------------------

  private track(promise: Promise<unknown>): void {
    const tracked = promise
      .catch(() => undefined)
      .finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
  }
}

/** Default heartbeat scheduler backed by the global timers. */
const defaultScheduler: HeartbeatScheduler = {
  setInterval: (handler, ms) => setInterval(handler, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

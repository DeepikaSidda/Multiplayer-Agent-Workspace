/**
 * RoomManager — owns the per-workspace in-memory room state and serializes
 * state-changing operations per room (design: "Room Manager").
 *
 * For each active workspace the manager keeps:
 *  - the **participant roster** (humans + agents), keyed by participant id;
 *  - a **presence map** (a per-room {@link PresenceService});
 *  - the authoritative **`Y.Doc`** (owned by the shared {@link ArtifactService}
 *    registry, keyed by workspace id);
 *  - the **message sequence counter** (owned by the shared
 *    {@link MessageService}, keyed by workspace id).
 *
 * It composes the pure services — {@link PresenceService},
 * {@link MessageService}, and {@link ArtifactService} — and provides the
 * {@link MessageService} a {@link SenderResolver} that reads the roster so the
 * message layer never has to own participant identity.
 *
 * **Per-room serialization.** All state-changing operations for a given
 * workspace run through a per-room promise-chain lock ({@link runExclusive}) so
 * their ordering is deterministic and races cannot violate invariants — e.g.
 * two concurrent {@link addAgent} calls can never both slip past the capacity
 * guard and exceed {@link MAX_AGENTS_PER_WORKSPACE}. Operations for different
 * workspaces run independently.
 *
 * This task (10.1) implements the room state, the serialization lock, and
 * add/remove-agent with the capacity guard (`AGENT_LIMIT_REACHED`) and the
 * unknown-agent guard (`AGENT_NOT_FOUND`). The agent response orchestration
 * flow is task 10.2; the WebSocket transport/broadcast is task 11. Methods here
 * therefore return structured results (including the presence changes to
 * broadcast) rather than performing any transport.
 */

import { randomUUID } from "node:crypto";
import {
  AGENT_MODEL_ID,
  DEFAULT_ARTIFACT_TYPE,
  MAX_AGENTS_PER_WORKSPACE,
  MESSAGE_MAX_LENGTH,
  type ArtifactType,
  type Message,
  type Participant,
} from "@maw/shared";
import type { WorkspaceStore } from "../store/index.js";
import { PresenceService, type PresenceChange } from "../presence/index.js";
import {
  MessageService,
  type SenderInfo,
  type SubmitResult,
} from "../message/index.js";
import {
  ArtifactService,
  type ArtifactApplyResult,
  type ArtifactProposeResult,
} from "../artifact/index.js";
import type { BedrockAgentService } from "../agent/index.js";

/** Input for {@link RoomManager.addAgent}. */
export interface AddAgentInput {
  /** Display name shown for the agent teammate. */
  displayName: string;
  /** Optional persona/system framing for the agent. */
  persona?: string;
}

/**
 * Result of {@link RoomManager.addAgent}.
 * - success carries the created agent {@link Participant} (enough to broadcast
 *   `agentAdded`) plus the {@link PresenceChange} to broadcast
 *   (`presenceUpdate` + `participantCountUpdate`).
 * - failure is the capacity guard: `AGENT_LIMIT_REACHED` (no participant added).
 */
export type AddAgentResult =
  | { ok: true; participant: Participant; presence: PresenceChange }
  | { ok: false; error: "AGENT_LIMIT_REACHED" };

/**
 * Result of {@link RoomManager.removeAgent}.
 * - success carries the removed `agentId` (enough to broadcast `agentRemoved`)
 *   plus the {@link PresenceChange} to broadcast.
 * - failure is the unknown-agent guard: `AGENT_NOT_FOUND` (roster unchanged).
 */
export type RemoveAgentResult =
  | { ok: true; agentId: string; presence: PresenceChange }
  | { ok: false; error: "AGENT_NOT_FOUND" };

/**
 * The artifact edit produced by a successful agent generation, ready for the
 * transport layer to broadcast as `artifactUpdate`.
 */
export interface AgentArtifactEdit {
  /** Incremental Yjs update to apply on peers (see {@link ArtifactService.applyProposedContent}). */
  yjsUpdate: Uint8Array;
  lastEditorId: string;
  lastEditedAt: number;
}

/**
 * Structured outcome of {@link RoomManager.triggerAgentResponse}, describing
 * everything the transport layer (task 11) must broadcast. The orchestration
 * itself performs no transport.
 *
 * - `AGENT_NOT_FOUND`: the id is not an agent participant of the room; nothing
 *   was generated and presence/state are untouched.
 * - success: `outcome` distinguishes a completed generation from a
 *   failed/timed-out one. `processingPresence` is the presence change emitted
 *   when generation began (agent → `processing`, Requirement 5.3);
 *   `idlePresence` is the change emitted when it ended (agent → `active`).
 *   `message` is the single appended agent message (an `agent` response on
 *   success, an `error` message on failure — Requirements 5.2, 5.4).
 *   `artifact` is present only when a successful generation applied a proposed
 *   edit; `artifactRejected` records a rejected proposal (size/persist).
 */
export type AgentResponseResult =
  | { ok: false; error: "AGENT_NOT_FOUND" }
  | {
      ok: true;
      agentId: string;
      outcome: "success" | "failure";
      /** Failure reason when `outcome === "failure"`. */
      failure?: "TIMEOUT" | "MODEL_ERROR" | "PARSE_ERROR";
      processingPresence: PresenceChange;
      idlePresence: PresenceChange;
      /** The single agent-attributed message appended to the log, if any. */
      message?: Message;
      /** The artifact edit to broadcast (successful generation with a proposal). */
      artifact?: AgentArtifactEdit;
      /** Set when a proposed artifact edit was rejected. */
      artifactRejected?: "SIZE_LIMIT" | "PERSIST_FAILED";
    };

/**
 * Optional hooks so the transport layer can react to intermediate steps that
 * must be observable *during* generation rather than only in the final result
 * — notably broadcasting the agent's `processing` presence while the (slow)
 * Bedrock call is in flight (Requirement 5.3).
 */
export interface AgentResponseHooks {
  /**
   * Invoked once the agent has entered `processing` and its context has been
   * snapshotted, immediately before the Bedrock call begins. The `Y.Doc` lock
   * is not held while this runs.
   */
  onProcessing?: (change: PresenceChange) => void;
}

/** Injectable collaborators/seams for deterministic tests. */
export interface RoomManagerOptions {
  /** Millisecond clock; defaults to `Date.now`. */
  now?: () => number;
  /** Id generator for agent participants; defaults to `crypto.randomUUID`. */
  newId?: () => string;
  /** Shared, multi-workspace artifact service; a default is created if omitted. */
  artifactService?: ArtifactService;
  /**
   * The Bedrock agent service used by the orchestration flow (task 10.2). Held
   * here so the room manager can compose it; unused by task 10.1.
   */
  agentService?: BedrockAgentService;
}

/** In-memory state for a single active workspace room. */
interface Room {
  workspaceId: string;
  /** Participant roster (humans + agents), keyed by participant id. */
  roster: Map<string, Participant>;
  /** Per-room presence map. */
  presence: PresenceService;
  /**
   * Tail of the per-room serialization promise chain. Every state-changing op
   * is appended here so operations run one at a time in submission order.
   */
  tail: Promise<unknown>;
  /**
   * Whether the persisted roster has been loaded into this in-memory room. A
   * room is recreated empty after a process restart, so persisted agents (and
   * humans) must be rehydrated once so `@mention` detection and sender
   * resolution keep working across restarts.
   */
  hydrated: boolean;
}

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly now: () => number;
  private readonly newId: () => string;

  /** Shared, multi-workspace artifact CRDT service (keyed by workspace id). */
  readonly artifacts: ArtifactService;
  /** Shared, multi-workspace message service (keyed by workspace id). */
  readonly messages: MessageService;
  /** The agent service composed for the orchestration flow (task 10.2). */
  readonly agentService?: BedrockAgentService;

  constructor(
    private readonly store: WorkspaceStore,
    options: RoomManagerOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.newId = options.newId ?? (() => randomUUID());
    this.artifacts = options.artifactService ?? new ArtifactService(store);
    this.agentService = options.agentService;
    // The message service resolves sender identity through this manager's
    // roster, so the message layer never owns participant identity.
    this.messages = new MessageService(
      store,
      (workspaceId, senderId) => this.resolveSender(workspaceId, senderId),
      { now: this.now, generateId: this.newId },
    );
  }

  // -------------------------------------------------------------------------
  // Room lifecycle
  // -------------------------------------------------------------------------

  /**
   * Ensure a room exists for the workspace and warm its authoritative artifact
   * document from durable storage so {@link ArtifactService.getContent} and the
   * synchronous origin snapshot/rollback are usable. Safe to call repeatedly
   * (e.g. on every join/reconnect).
   */
  async ensureRoom(workspaceId: string): Promise<void> {
    const room = this.getOrCreateRoom(workspaceId);
    // Claim hydration synchronously (before any await) so concurrent joins
    // don't double-load the roster.
    const needsHydration = !room.hydrated;
    if (needsHydration) room.hydrated = true;

    await this.artifacts.ensureLoaded(workspaceId);

    if (needsHydration) {
      // Rehydrate the persisted roster into this in-memory room. Agents are
      // durable teammates: restore them to the roster AND mark them active in
      // presence so `@mention` detection and generation work after a restart.
      // Humans are added to the roster (so message sender resolution works) but
      // are NOT marked active until they actually reconnect.
      const participants = await this.store.loadParticipants(workspaceId);
      for (const p of participants) {
        if (!room.roster.has(p.id)) room.roster.set(p.id, { ...p });
        if (p.type === "agent") {
          room.presence.join({ id: p.id, type: "agent" });
        }
      }

      // Seed the message sequence counter from persisted messages so new
      // messages continue past the last one instead of reusing sequence
      // numbers and overwriting history after a restart.
      const messages = await this.store.loadMessages(workspaceId);
      this.messages.hydrate(workspaceId, messages);
    }
  }

  /** Whether an in-memory room currently exists for the workspace. */
  hasRoom(workspaceId: string): boolean {
    return this.rooms.has(workspaceId);
  }

  // -------------------------------------------------------------------------
  // Participant registration
  // -------------------------------------------------------------------------

  /**
   * Register (or refresh) a human participant on join/reconnect: add them to
   * the roster and mark them active in the presence map. Idempotent by id — a
   * reconnect with the same id upserts the roster entry and yields no duplicate
   * presence entry (Requirements 1.5, 2.1). Serialized per room.
   *
   * Persistence of the human participant is handled by the workspace join flow
   * ({@link WorkspaceService.join} upserts them); this only updates in-memory
   * room state and returns the {@link PresenceChange} to broadcast.
   */
  registerHuman(
    workspaceId: string,
    participant: Participant,
  ): Promise<PresenceChange> {
    return this.runExclusive(workspaceId, () => {
      const room = this.getOrCreateRoom(workspaceId);
      room.roster.set(participant.id, { ...participant });
      return room.presence.join({ id: participant.id, type: "human" });
    });
  }

  /**
   * Add an agent teammate to the workspace (Requirements 4.1, 4.2, 4.5).
   *
   * Capacity guard: if the room already contains
   * {@link MAX_AGENTS_PER_WORKSPACE} agents, the request is rejected with
   * `AGENT_LIMIT_REACHED` and nothing is added. Otherwise a new agent
   * {@link Participant} (`type: "agent"`, `modelId: AGENT_MODEL_ID`) is
   * persisted, added to the roster + presence map, and returned along with the
   * presence change to broadcast. Serialized per room so concurrent adds cannot
   * exceed the cap.
   */
  addAgent(
    workspaceId: string,
    input: AddAgentInput,
  ): Promise<AddAgentResult> {
    return this.runExclusive(workspaceId, async () => {
      const room = this.getOrCreateRoom(workspaceId);

      if (this.countAgentsIn(room) >= MAX_AGENTS_PER_WORKSPACE) {
        return { ok: false, error: "AGENT_LIMIT_REACHED" } as const;
      }

      const agent: Participant = {
        id: this.newId(),
        workspaceId,
        type: "agent",
        displayName: input.displayName,
        joinedAt: this.now(),
        presenceState: "active",
        modelId: AGENT_MODEL_ID,
        ...(input.persona !== undefined ? { persona: input.persona } : {}),
      };

      // Persist the new agent before committing it to in-memory room state.
      await this.store.upsertParticipant(workspaceId, agent);

      room.roster.set(agent.id, agent);
      const presence = room.presence.join({ id: agent.id, type: "agent" });

      return { ok: true, participant: { ...agent }, presence } as const;
    });
  }

  /**
   * Remove an agent teammate from the workspace (Requirements 4.4, 4.6).
   *
   * Unknown-agent guard: if `agentId` is not an agent participant of the room,
   * the request is rejected with `AGENT_NOT_FOUND` and the roster is left
   * unchanged. Otherwise the agent is removed from durable storage, the roster,
   * and the presence map, returning the presence change to broadcast.
   * Serialized per room.
   */
  removeAgent(
    workspaceId: string,
    agentId: string,
  ): Promise<RemoveAgentResult> {
    return this.runExclusive(workspaceId, async () => {
      const room = this.rooms.get(workspaceId);
      const participant = room?.roster.get(agentId);
      if (!room || !participant || participant.type !== "agent") {
        return { ok: false, error: "AGENT_NOT_FOUND" } as const;
      }

      await this.store.removeParticipant(workspaceId, agentId);

      room.roster.delete(agentId);
      const presence = room.presence.leave(agentId);

      return { ok: true, agentId, presence } as const;
    });
  }

  // -------------------------------------------------------------------------
  // Agent response orchestration (task 10.2)
  // -------------------------------------------------------------------------

  /**
   * Orchestrate an agent's response to the current conversation (Requirement 5).
   * Intended to be invoked after a message that names or replies to `agentId`
   * has already been appended, so the assembled context includes it.
   *
   * The flow is split into three phases so the slow Bedrock call does NOT hold
   * the per-room lock (which would stall all other room operations for up to
   * 60s):
   *
   * 1. **Setup (locked).** Mark the agent `processing` (Requirement 5.3),
   *    checkpoint the artifact for the agent's origin ({@link ArtifactService.snapshotOrigin}),
   *    and capture the generation context (artifact type + content, complete
   *    message log). The captured `processing` presence change is delivered via
   *    {@link AgentResponseHooks.onProcessing} so it can be broadcast during
   *    generation.
   * 2. **Generate (unlocked).** Invoke the injected {@link BedrockAgentService}.
   *    Concurrent human edits may be applied to the artifact meanwhile — they
   *    use their own (untracked) origins and are therefore preserved regardless
   *    of the outcome.
   * 3. **Commit (locked).** On success, append exactly one agent-attributed
   *    message and, if a proposal was returned, apply it as the agent-tagged
   *    transaction (Requirements 5.2, 6.4). On failure/timeout, append one
   *    agent-attributed `error` message and roll back only the agent's tagged
   *    transaction, preserving concurrent human edits (Requirements 5.4, 5.5).
   *    Either way the agent reverts to `active`.
   *
   * Returns a structured {@link AgentResponseResult} describing what to
   * broadcast; it performs no transport itself.
   */
  async triggerAgentResponse(
    workspaceId: string,
    agentId: string,
    hooks: AgentResponseHooks = {},
  ): Promise<AgentResponseResult> {
    if (!this.agentService) {
      throw new Error("triggerAgentResponse: no agentService configured");
    }

    // --- Phase 1: setup under the lock ---
    const setup = await this.runExclusive(workspaceId, () => {
      const room = this.rooms.get(workspaceId);
      const agent = room?.roster.get(agentId);
      if (!room || !agent || agent.type !== "agent") {
        return { kind: "not-found" as const };
      }

      const processingPresence = room.presence.markProcessing(agentId);
      // Checkpoint BEFORE generation so a failure can revert only this agent's
      // edits (Requirement 5.4). The room's artifact is warmed via ensureRoom.
      this.artifacts.snapshotOrigin(workspaceId, agentId);

      const artifactType: ArtifactType =
        this.artifacts.getArtifactType(workspaceId) ?? DEFAULT_ARTIFACT_TYPE;
      const artifactContent = this.artifacts.getContent(workspaceId);
      const messageLog = this.messages.getMessages(workspaceId);

      return {
        kind: "ready" as const,
        agent: { ...agent },
        processingPresence,
        artifactType,
        artifactContent,
        messageLog,
      };
    });

    if (setup.kind === "not-found") {
      return { ok: false, error: "AGENT_NOT_FOUND" };
    }

    // Let the transport broadcast the processing presence during generation.
    hooks.onProcessing?.(setup.processingPresence);

    // --- Phase 2: generation, WITHOUT holding the lock ---
    const generation = await this.agentService.generate({
      agent: setup.agent,
      artifactType: setup.artifactType,
      artifactContent: setup.artifactContent,
      messageLog: setup.messageLog,
    });

    // --- Phase 3: commit under the lock ---
    return this.runExclusive(workspaceId, async () => {
      const room = this.rooms.get(workspaceId);
      // The room/agent should still exist; if the agent was removed mid-flight
      // just release the checkpoint and report not-found.
      if (!room || room.roster.get(agentId)?.type !== "agent") {
        this.artifacts.rollbackOrigin(workspaceId, agentId);
        return { ok: false, error: "AGENT_NOT_FOUND" } as const;
      }

      if (generation.ok) {
        // Append exactly ONE agent-attributed response message (Requirement 5.2).
        const responseText = normalizeAgentText(
          generation.responseText,
          setup.agent.displayName,
        );
        const submitted = await this.messages.submit(
          workspaceId,
          agentId,
          responseText,
        );
        const message = submitted.ok ? submitted.message : undefined;

        // Apply the proposed artifact edit as the agent-tagged transaction.
        let artifact: AgentArtifactEdit | undefined;
        let artifactRejected: "SIZE_LIMIT" | "PERSIST_FAILED" | undefined;
        if (generation.proposedArtifact !== undefined) {
          const applied: ArtifactProposeResult =
            await this.artifacts.applyProposedContent(
              workspaceId,
              generation.proposedArtifact,
              agentId,
            );
          if (applied.ok) {
            const { editorId, editedAt } =
              this.artifacts.getLastEditor(workspaceId);
            artifact = {
              yjsUpdate: applied.update,
              lastEditorId: editorId ?? agentId,
              lastEditedAt: editedAt ?? this.now(),
            };
          } else {
            artifactRejected = applied.reason;
          }
        }

        const idlePresence = room.presence.endProcessing(agentId);
        return {
          ok: true,
          agentId,
          outcome: "success",
          processingPresence: setup.processingPresence,
          idlePresence,
          ...(message !== undefined ? { message } : {}),
          ...(artifact !== undefined ? { artifact } : {}),
          ...(artifactRejected !== undefined ? { artifactRejected } : {}),
        } as const;
      }

      // Failure / timeout: append ONE agent-attributed error message and revert
      // only this agent's artifact changes, preserving concurrent human edits.
      const errorText = agentErrorText(setup.agent.displayName, generation.failure);
      const submitted = await this.messages.submit(
        workspaceId,
        agentId,
        errorText,
        { kind: "error" },
      );
      const message = submitted.ok ? submitted.message : undefined;

      this.artifacts.rollbackOrigin(workspaceId, agentId);

      const idlePresence = room.presence.endProcessing(agentId);
      return {
        ok: true,
        agentId,
        outcome: "failure",
        failure: generation.failure,
        processingPresence: setup.processingPresence,
        idlePresence,
        ...(message !== undefined ? { message } : {}),
      } as const;
    });
  }

  // -------------------------------------------------------------------------
  // Serialized state-changing pass-throughs (support tasks 10.2 / 11)
  // -------------------------------------------------------------------------

  /**
   * Validate, stamp, persist, and commit a chat/agent message through the
   * per-room lock so message ordering is deterministic relative to other
   * state-changing operations. Delegates to {@link MessageService.submit}.
   */
  submitMessage(
    workspaceId: string,
    senderId: string,
    content: string,
  ): Promise<SubmitResult> {
    return this.runExclusive(workspaceId, () =>
      this.messages.submit(workspaceId, senderId, content),
    );
  }

  /**
   * Apply a CRDT artifact update through the per-room lock. Delegates to
   * {@link ArtifactService.applyUpdate} (size guard + persist-before-broadcast).
   */
  applyArtifactUpdate(
    workspaceId: string,
    update: Uint8Array,
    editorId: string,
  ): Promise<ArtifactApplyResult> {
    return this.runExclusive(workspaceId, () =>
      this.artifacts.applyUpdate(workspaceId, update, editorId),
    );
  }

  // -------------------------------------------------------------------------
  // Read-only accessors
  // -------------------------------------------------------------------------

  /**
   * Resolve a sender id to its identity within a workspace, reading the roster.
   * The {@link MessageService} calls this synchronously; the caller must have
   * registered the sender (join / addAgent) before submitting a message.
   */
  resolveSender(workspaceId: string, senderId: string): SenderInfo {
    const participant = this.rooms.get(workspaceId)?.roster.get(senderId);
    if (!participant) {
      throw new Error(
        `resolveSender: ${senderId} is not a participant of ${workspaceId}`,
      );
    }
    return {
      senderType: participant.type,
      senderName: participant.displayName,
    };
  }

  /** A defensive copy of the workspace roster (humans + agents). */
  getRoster(workspaceId: string): Participant[] {
    const room = this.rooms.get(workspaceId);
    if (!room) return [];
    return [...room.roster.values()].map((p) => ({ ...p }));
  }

  /** A single participant by id, or undefined if not in the room. */
  getParticipant(workspaceId: string, id: string): Participant | undefined {
    const p = this.rooms.get(workspaceId)?.roster.get(id);
    return p ? { ...p } : undefined;
  }

  /** The number of agent participants currently in the workspace. */
  countAgents(workspaceId: string): number {
    const room = this.rooms.get(workspaceId);
    return room ? this.countAgentsIn(room) : 0;
  }

  /** The per-room presence service, if the room exists. */
  getPresence(workspaceId: string): PresenceService | undefined {
    return this.rooms.get(workspaceId)?.presence;
  }

  /** The number of active participants in the workspace (0 if no room). */
  getActiveCount(workspaceId: string): number {
    return this.rooms.get(workspaceId)?.presence.getActiveCount() ?? 0;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Get an existing room or lazily create empty in-memory state for it. */
  private getOrCreateRoom(workspaceId: string): Room {
    let room = this.rooms.get(workspaceId);
    if (!room) {
      room = {
        workspaceId,
        roster: new Map<string, Participant>(),
        presence: new PresenceService(this.now),
        tail: Promise.resolve(),
        hydrated: false,
      };
      this.rooms.set(workspaceId, room);
    }
    return room;
  }

  private countAgentsIn(room: Room): number {
    let count = 0;
    for (const p of room.roster.values()) {
      if (p.type === "agent") count += 1;
    }
    return count;
  }

  /**
   * Run `fn` under the per-room serialization lock: append it to the room's
   * promise chain so it starts only after all previously submitted operations
   * for that room settle, guaranteeing deterministic ordering. The chain is
   * insulated from rejections so one failed operation never blocks or breaks
   * the ordering of subsequent operations, while the original result/rejection
   * is still propagated to this caller.
   */
  private runExclusive<T>(
    workspaceId: string,
    fn: () => T | Promise<T>,
  ): Promise<T> {
    const room = this.getOrCreateRoom(workspaceId);
    const result = room.tail.then(() => fn());
    // Swallow rejection/return on the chain tail so the next op still runs.
    room.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/**
 * Coerce an agent's conversational reply into valid message content. A
 * successful generation may return an empty reply (e.g. the agent only proposed
 * an artifact change); a message requires at least one non-whitespace char, so
 * fall back to a short acknowledgement. Over-long replies are truncated to stay
 * within the message length bound.
 */
function normalizeAgentText(responseText: string, agentName: string): string {
  const trimmed = responseText.trim();
  const text =
    trimmed.length > 0 ? responseText : `${agentName} updated the artifact.`;
  return text.length > MESSAGE_MAX_LENGTH
    ? text.slice(0, MESSAGE_MAX_LENGTH)
    : text;
}

/** The agent-attributed error message for a failed/timed-out generation. */
function agentErrorText(
  agentName: string,
  failure: "TIMEOUT" | "MODEL_ERROR" | "PARSE_ERROR",
): string {
  const reason =
    failure === "TIMEOUT"
      ? "timed out"
      : failure === "PARSE_ERROR"
        ? "returned a malformed response"
        : "failed to generate a response";
  return `${agentName} ${reason}. Please try again.`;
}

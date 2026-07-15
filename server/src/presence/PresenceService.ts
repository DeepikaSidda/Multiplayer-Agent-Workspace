/**
 * PresenceService — server-authoritative participant presence tracking.
 *
 * Backs the Presence Service component from the design document. Presence is
 * tracked entirely on the server: on join a participant is registered as
 * `active`; a graceful `leave` removes it from the active set immediately
 * (Requirement 2.2); unexpected disconnects are detected via heartbeat
 * ping/pong and reaped after a grace window shorter than 30 seconds
 * (Requirement 2.3). Agents are first-class participants in the presence set
 * (Requirement 4.2) and additionally carry a `processing` state while
 * generating a response (Requirement 5.3), which downstream UI renders with a
 * distinct visual marker (Requirement 2.4).
 *
 * The active-participant count reported to clients (Requirement 2.5) always
 * equals the number of participants that are currently active — i.e. every
 * tracked participant whose presence state is not `disconnected`. A
 * `processing` agent is still active and is therefore counted.
 *
 * Time is supplied through an injectable clock (and explicit `now` arguments on
 * the time-sensitive methods) so heartbeat reaping is deterministically
 * testable without relying on real timers.
 */

import type {
  ParticipantType,
  PresenceState,
  PresenceUpdatePayload,
  ParticipantCountUpdatePayload,
} from "@maw/shared";

/**
 * Grace window before an un-heartbeaten human session is reaped as
 * disconnected. Kept below the 30s ceiling of Requirement 2.3 so removal is
 * broadcast well within the deadline.
 */
export const DISCONNECT_GRACE_MS = 25_000;

/** Recommended heartbeat (ping/pong) interval for connected sessions. */
export const HEARTBEAT_INTERVAL_MS = 10_000;

/** Minimal identity needed to register a participant's presence. */
export interface PresenceParticipant {
  id: string;
  type: ParticipantType;
}

/** A public, read-only view of a tracked participant's presence. */
export interface PresenceEntry {
  id: string;
  type: ParticipantType;
  presenceState: PresenceState;
}

/**
 * The result of a presence-mutating operation: the presence updates to
 * broadcast and the resulting active count. `countChanged` lets the gateway
 * broadcast a `participantCountUpdate` only when the active count actually
 * changes (Requirement 2.5).
 */
export interface PresenceChange {
  /** Presence updates to broadcast (empty when nothing changed). */
  updates: PresenceUpdatePayload[];
  /** The active participant count after applying the change. */
  activeCount: number;
  /** Whether the active count changed as a result of this operation. */
  countChanged: boolean;
}

interface TrackedParticipant {
  id: string;
  type: ParticipantType;
  presenceState: PresenceState;
  /** Epoch ms of the last observed heartbeat (or (re)join). */
  lastHeartbeat: number;
}

export class PresenceService {
  private readonly participants = new Map<string, TrackedParticipant>();
  private readonly clock: () => number;

  /**
   * @param clock Injectable time source (epoch ms). Defaults to `Date.now`.
   *   Prefer passing explicit `now` values to the methods below in tests.
   */
  constructor(clock: () => number = Date.now) {
    this.clock = clock;
  }

  /**
   * Register a (re)joining participant as active. Idempotent: rejoining while
   * already active only refreshes the heartbeat and yields no presence update
   * (Requirement 1.5 / 2.1). Reactivating a previously disconnected or reaped
   * participant re-adds it to the active set.
   */
  join(participant: PresenceParticipant, now: number = this.clock()): PresenceChange {
    const existing = this.participants.get(participant.id);
    if (existing && existing.presenceState !== "disconnected") {
      // Already active (or processing) — a redundant rejoin. Refresh liveness
      // only; the active set is unchanged.
      existing.lastHeartbeat = now;
      return this.noChange();
    }

    this.participants.set(participant.id, {
      id: participant.id,
      type: participant.type,
      presenceState: "active",
      lastHeartbeat: now,
    });

    return this.change(this.presenceUpdate(participant.id, "active", participant.type), true);
  }

  /**
   * Gracefully remove a participant from the active set (Requirement 2.2). The
   * entry is retained in a `disconnected` state so a subsequent rejoin is
   * recognized and stale entries are not reaped twice. A no-op for unknown or
   * already-disconnected participants.
   */
  leave(participantId: string, _now: number = this.clock()): PresenceChange {
    const existing = this.participants.get(participantId);
    if (!existing || existing.presenceState === "disconnected") {
      return this.noChange();
    }

    existing.presenceState = "disconnected";
    return this.change(
      this.presenceUpdate(existing.id, "disconnected", existing.type),
      true,
    );
  }

  /**
   * Record a liveness heartbeat for a connected participant. Heartbeats keep a
   * session out of the disconnect-reaping window. A no-op for unknown or
   * already-disconnected participants.
   */
  heartbeat(participantId: string, now: number = this.clock()): void {
    const existing = this.participants.get(participantId);
    if (existing && existing.presenceState !== "disconnected") {
      existing.lastHeartbeat = now;
    }
  }

  /**
   * Mark an agent as `processing` while it generates a response
   * (Requirement 5.3). Only agents may enter the processing state. The
   * participant remains active, so the active count is unchanged.
   */
  markProcessing(agentId: string): PresenceChange {
    const existing = this.requireAgent(agentId, "markProcessing");
    if (existing.presenceState === "processing") {
      return this.noChange();
    }
    existing.presenceState = "processing";
    return this.change(
      this.presenceUpdate(existing.id, "processing", existing.type),
      false,
    );
  }

  /**
   * Revert an agent from `processing` back to `active` once generation
   * completes or fails (Requirement 5.3). Only agents may use this. The active
   * count is unchanged.
   */
  endProcessing(agentId: string): PresenceChange {
    const existing = this.requireAgent(agentId, "endProcessing");
    if (existing.presenceState === "active") {
      return this.noChange();
    }
    // A disconnected agent should not be silently reactivated by ending
    // processing; only transition from processing.
    if (existing.presenceState !== "processing") {
      return this.noChange();
    }
    existing.presenceState = "active";
    return this.change(
      this.presenceUpdate(existing.id, "active", existing.type),
      false,
    );
  }

  /**
   * Reap human sessions whose last heartbeat is older than the grace window,
   * marking them `disconnected` (Requirement 2.3). Agents have no session
   * heartbeat and are never reaped. Returns the presence updates for every
   * reaped participant and the resulting active count.
   */
  reapExpired(now: number = this.clock()): PresenceChange {
    const updates: PresenceUpdatePayload[] = [];
    for (const p of this.participants.values()) {
      if (p.type !== "human") continue;
      if (p.presenceState === "disconnected") continue;
      if (now - p.lastHeartbeat > DISCONNECT_GRACE_MS) {
        p.presenceState = "disconnected";
        updates.push(this.presenceUpdate(p.id, "disconnected", p.type));
      }
    }
    return {
      updates,
      activeCount: this.getActiveCount(),
      countChanged: updates.length > 0,
    };
  }

  /**
   * The set of currently active participants — every tracked participant whose
   * presence state is not `disconnected` (includes `processing` agents).
   */
  getActiveParticipants(): PresenceEntry[] {
    const active: PresenceEntry[] = [];
    for (const p of this.participants.values()) {
      if (p.presenceState !== "disconnected") {
        active.push({ id: p.id, type: p.type, presenceState: p.presenceState });
      }
    }
    return active;
  }

  /** The number of currently active participants (Requirement 2.5, 4.2). */
  getActiveCount(): number {
    let count = 0;
    for (const p of this.participants.values()) {
      if (p.presenceState !== "disconnected") count += 1;
    }
    return count;
  }

  /** The current presence state of a participant, or null if untracked. */
  getPresence(participantId: string): PresenceState | null {
    return this.participants.get(participantId)?.presenceState ?? null;
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private requireAgent(agentId: string, op: string): TrackedParticipant {
    const existing = this.participants.get(agentId);
    if (!existing) {
      throw new Error(`${op}: unknown participant ${agentId}`);
    }
    if (existing.type !== "agent") {
      throw new Error(`${op}: participant ${agentId} is not an agent`);
    }
    return existing;
  }

  private presenceUpdate(
    participantId: string,
    presenceState: PresenceState,
    participantType: ParticipantType,
  ): PresenceUpdatePayload {
    return { participantId, presenceState, participantType };
  }

  private change(update: PresenceUpdatePayload, countChanged: boolean): PresenceChange {
    return {
      updates: [update],
      activeCount: this.getActiveCount(),
      countChanged,
    };
  }

  private noChange(): PresenceChange {
    return { updates: [], activeCount: this.getActiveCount(), countChanged: false };
  }
}

/** Convenience factory for a participant-count update payload. */
export function participantCountUpdate(activeCount: number): ParticipantCountUpdatePayload {
  return { activeCount };
}

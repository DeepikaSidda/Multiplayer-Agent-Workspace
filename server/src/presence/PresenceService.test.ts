import { describe, it, expect } from "vitest";
import {
  PresenceService,
  participantCountUpdate,
  DISCONNECT_GRACE_MS,
} from "./index.js";

/**
 * A controllable clock so heartbeat reaping is deterministic (no real timers).
 */
function makeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("PresenceService", () => {
  describe("join", () => {
    it("registers a joining participant as active and reports the count", () => {
      const svc = new PresenceService(() => 1_000);
      const change = svc.join({ id: "h1", type: "human" });

      expect(change.updates).toEqual([
        { participantId: "h1", presenceState: "active", participantType: "human" },
      ]);
      expect(change.activeCount).toBe(1);
      expect(change.countChanged).toBe(true);
      expect(svc.getActiveCount()).toBe(1);
      expect(svc.getPresence("h1")).toBe("active");
    });

    it("is idempotent: rejoining while active yields no update and no count change", () => {
      const svc = new PresenceService(() => 1_000);
      svc.join({ id: "h1", type: "human" });
      const again = svc.join({ id: "h1", type: "human" });

      expect(again.updates).toEqual([]);
      expect(again.countChanged).toBe(false);
      expect(svc.getActiveCount()).toBe(1);
    });

    it("reactivates a previously disconnected participant", () => {
      const svc = new PresenceService(() => 1_000);
      svc.join({ id: "h1", type: "human" });
      svc.leave("h1");
      expect(svc.getActiveCount()).toBe(0);

      const rejoin = svc.join({ id: "h1", type: "human" });
      expect(rejoin.countChanged).toBe(true);
      expect(rejoin.activeCount).toBe(1);
      expect(svc.getPresence("h1")).toBe("active");
    });

    it("tracks agents as active participants (Requirement 4.2)", () => {
      const svc = new PresenceService(() => 1_000);
      const change = svc.join({ id: "a1", type: "agent" });
      expect(change.updates[0].participantType).toBe("agent");
      expect(svc.getActiveCount()).toBe(1);
    });
  });

  describe("leave", () => {
    it("removes a participant from the active set immediately (Requirement 2.2)", () => {
      const svc = new PresenceService(() => 1_000);
      svc.join({ id: "h1", type: "human" });
      svc.join({ id: "h2", type: "human" });

      const change = svc.leave("h1");
      expect(change.updates).toEqual([
        { participantId: "h1", presenceState: "disconnected", participantType: "human" },
      ]);
      expect(change.activeCount).toBe(1);
      expect(change.countChanged).toBe(true);
      expect(svc.getActiveParticipants().map((p) => p.id)).toEqual(["h2"]);
    });

    it("is a no-op for unknown or already-disconnected participants", () => {
      const svc = new PresenceService(() => 1_000);
      svc.join({ id: "h1", type: "human" });

      expect(svc.leave("nope").updates).toEqual([]);
      svc.leave("h1");
      const second = svc.leave("h1");
      expect(second.updates).toEqual([]);
      expect(second.countChanged).toBe(false);
    });
  });

  describe("processing state (agents)", () => {
    it("marks an agent processing without changing the active count (Requirement 5.3)", () => {
      const svc = new PresenceService(() => 1_000);
      svc.join({ id: "a1", type: "agent" });

      const change = svc.markProcessing("a1");
      expect(change.updates).toEqual([
        { participantId: "a1", presenceState: "processing", participantType: "agent" },
      ]);
      expect(change.countChanged).toBe(false);
      expect(svc.getActiveCount()).toBe(1);
      expect(svc.getPresence("a1")).toBe("processing");
    });

    it("reverts an agent from processing back to active", () => {
      const svc = new PresenceService(() => 1_000);
      svc.join({ id: "a1", type: "agent" });
      svc.markProcessing("a1");

      const change = svc.endProcessing("a1");
      expect(change.updates).toEqual([
        { participantId: "a1", presenceState: "active", participantType: "agent" },
      ]);
      expect(svc.getPresence("a1")).toBe("active");
    });

    it("counts a processing agent as active", () => {
      const svc = new PresenceService(() => 1_000);
      svc.join({ id: "a1", type: "agent" });
      svc.markProcessing("a1");
      expect(svc.getActiveCount()).toBe(1);
      expect(svc.getActiveParticipants()).toEqual([
        { id: "a1", type: "agent", presenceState: "processing" },
      ]);
    });

    it("rejects processing for a human participant", () => {
      const svc = new PresenceService(() => 1_000);
      svc.join({ id: "h1", type: "human" });
      expect(() => svc.markProcessing("h1")).toThrow(/not an agent/);
    });

    it("rejects processing for an unknown participant", () => {
      const svc = new PresenceService(() => 1_000);
      expect(() => svc.markProcessing("ghost")).toThrow(/unknown participant/);
    });

    it("does not reactivate a disconnected agent via endProcessing", () => {
      const svc = new PresenceService(() => 1_000);
      svc.join({ id: "a1", type: "agent" });
      svc.leave("a1");
      const change = svc.endProcessing("a1");
      expect(change.updates).toEqual([]);
      expect(svc.getPresence("a1")).toBe("disconnected");
    });
  });

  describe("heartbeat-based disconnect reaping (Requirement 2.3)", () => {
    it("reaps a human whose heartbeat is older than the grace window", () => {
      const clock = makeClock(0);
      const svc = new PresenceService(clock.now);
      svc.join({ id: "h1", type: "human" });

      // Just under the grace window: not reaped.
      clock.advance(DISCONNECT_GRACE_MS);
      expect(svc.reapExpired().updates).toEqual([]);
      expect(svc.getActiveCount()).toBe(1);

      // Past the grace window: reaped.
      clock.advance(1);
      const change = svc.reapExpired();
      expect(change.updates).toEqual([
        { participantId: "h1", presenceState: "disconnected", participantType: "human" },
      ]);
      expect(change.countChanged).toBe(true);
      expect(change.activeCount).toBe(0);
    });

    it("uses a grace window strictly under 30 seconds", () => {
      expect(DISCONNECT_GRACE_MS).toBeLessThan(30_000);
    });

    it("does not reap a participant kept alive by heartbeats", () => {
      const clock = makeClock(0);
      const svc = new PresenceService(clock.now);
      svc.join({ id: "h1", type: "human" });

      // Heartbeat repeatedly within the window; total elapsed exceeds grace.
      for (let i = 0; i < 5; i++) {
        clock.advance(DISCONNECT_GRACE_MS - 1);
        svc.heartbeat("h1");
      }
      clock.advance(1);
      expect(svc.reapExpired().updates).toEqual([]);
      expect(svc.getActiveCount()).toBe(1);
    });

    it("never reaps agents (they have no session heartbeat)", () => {
      const clock = makeClock(0);
      const svc = new PresenceService(clock.now);
      svc.join({ id: "a1", type: "agent" });

      clock.advance(DISCONNECT_GRACE_MS * 10);
      expect(svc.reapExpired().updates).toEqual([]);
      expect(svc.getActiveCount()).toBe(1);
    });

    it("reaps multiple expired humans in one pass and does not re-reap them", () => {
      const clock = makeClock(0);
      const svc = new PresenceService(clock.now);
      svc.join({ id: "h1", type: "human" });
      svc.join({ id: "h2", type: "human" });
      svc.join({ id: "h3", type: "human" });
      svc.heartbeat("h3", DISCONNECT_GRACE_MS); // keep h3 alive

      clock.advance(DISCONNECT_GRACE_MS + 1);
      const change = svc.reapExpired();
      expect(change.updates.map((u) => u.participantId).sort()).toEqual(["h1", "h2"]);
      expect(svc.getActiveCount()).toBe(1);

      // A second pass reaps nothing new (idempotent).
      const second = svc.reapExpired();
      expect(second.updates).toEqual([]);
      expect(second.countChanged).toBe(false);
    });
  });

  describe("active set / count consistency (Requirements 2.1, 2.2, 2.5, 4.2)", () => {
    it("keeps the reported count equal to the number of non-disconnected participants", () => {
      const clock = makeClock(0);
      const svc = new PresenceService(clock.now);

      svc.join({ id: "h1", type: "human" });
      svc.join({ id: "h2", type: "human" });
      svc.join({ id: "a1", type: "agent" });
      expect(svc.getActiveCount()).toBe(3);

      svc.markProcessing("a1"); // still active
      expect(svc.getActiveCount()).toBe(3);

      svc.leave("h1");
      expect(svc.getActiveCount()).toBe(2);
      expect(svc.getActiveParticipants().map((p) => p.id).sort()).toEqual(["a1", "h2"]);

      clock.advance(DISCONNECT_GRACE_MS + 1);
      svc.reapExpired(); // reaps h2 (no heartbeat), keeps agent
      expect(svc.getActiveCount()).toBe(1);
      expect(svc.getActiveParticipants().map((p) => p.id)).toEqual(["a1"]);
    });
  });

  describe("participantCountUpdate helper", () => {
    it("builds a count-update payload", () => {
      expect(participantCountUpdate(3)).toEqual({ activeCount: 3 });
    });
  });
});

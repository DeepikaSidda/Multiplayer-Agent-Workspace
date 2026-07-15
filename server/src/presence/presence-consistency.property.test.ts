import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { PresenceService } from "./index.js";
import type { PresenceState } from "@maw/shared";

/**
 * Property-based test for the Presence Service.
 *
 * Property 5 asserts that the presence set exposed by the service and the
 * active count it reports are always consistent with the set of participants
 * that are actually active (every tracked participant whose presence state is
 * not `disconnected`, including `processing` agents). We drive the service with
 * an arbitrary interleaving of joins, leaves, and agent processing transitions
 * over a small pool of participants (so operations genuinely collide on the
 * same ids) while maintaining an independent reference model of the expected
 * active set, and check the invariant after every operation.
 */

// A small fixed pool so joins/leaves/processing interleave on shared ids.
const HUMAN_IDS = ["h0", "h1", "h2"] as const;
const AGENT_IDS = ["a0", "a1"] as const;
const ALL_IDS = [...HUMAN_IDS, ...AGENT_IDS] as const;

type Id = (typeof ALL_IDS)[number];
type ParticipantType = "human" | "agent";

function typeOf(id: Id): ParticipantType {
  return id.startsWith("a") ? "agent" : "human";
}

type Op =
  | { kind: "join"; id: Id }
  | { kind: "leave"; id: Id }
  | { kind: "mark"; id: (typeof AGENT_IDS)[number] }
  | { kind: "end"; id: (typeof AGENT_IDS)[number] };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant("join" as const), id: fc.constantFrom(...ALL_IDS) }),
  fc.record({ kind: fc.constant("leave" as const), id: fc.constantFrom(...ALL_IDS) }),
  fc.record({ kind: fc.constant("mark" as const), id: fc.constantFrom(...AGENT_IDS) }),
  fc.record({ kind: fc.constant("end" as const), id: fc.constantFrom(...AGENT_IDS) }),
);

describe("PresenceService — Property 5 (presence/count consistency)", () => {
  // Feature: multiplayer-agent-workspace, Property 5: Presence and active count are consistent with the active set
  it("keeps the presence set and active count equal to the currently active participants", () => {
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 60 }), (ops) => {
        // Fixed clock: this property concerns joins/leaves/processing, not
        // heartbeat reaping, so time need not advance.
        const svc = new PresenceService(() => 1_000);

        // Reference model: id -> presence state for every tracked participant.
        const model = new Map<Id, PresenceState>();

        const applyAndCheck = () => {
          // Expected active set = tracked participants that are not disconnected.
          const expectedActive = new Map<Id, PresenceState>();
          for (const [id, state] of model) {
            if (state !== "disconnected") expectedActive.set(id, state);
          }

          // Count consistency (Requirement 2.5).
          expect(svc.getActiveCount()).toBe(expectedActive.size);

          // Presence-set consistency: exactly the expected ids, each carrying
          // the expected state and participant type (Requirements 2.1, 4.2).
          const actual = svc.getActiveParticipants();
          expect(actual.length).toBe(expectedActive.size);
          const actualIds = actual.map((p) => p.id).sort();
          expect(actualIds).toEqual([...expectedActive.keys()].sort());
          for (const entry of actual) {
            const id = entry.id as Id;
            expect(entry.presenceState).toBe(expectedActive.get(id));
            expect(entry.type).toBe(typeOf(id));
          }
          // getActiveCount must always agree with the reported set.
          expect(svc.getActiveCount()).toBe(actual.length);
        };

        // Initial state: nothing tracked, nobody active.
        applyAndCheck();

        for (const op of ops) {
          switch (op.kind) {
            case "join": {
              svc.join({ id: op.id, type: typeOf(op.id) });
              // Idempotent rejoin: a still-connected participant keeps its
              // current state (incl. a processing agent); only an untracked or
              // disconnected participant (re)enters as active.
              const current = model.get(op.id);
              if (current === undefined || current === "disconnected") {
                model.set(op.id, "active");
              }
              break;
            }
            case "leave": {
              svc.leave(op.id);
              if (model.has(op.id)) model.set(op.id, "disconnected");
              break;
            }
            case "mark": {
              // markProcessing is only valid for a currently-active agent;
              // guard so the service never throws (Requirement 2.2 semantics).
              if (model.get(op.id) === "active") {
                svc.markProcessing(op.id);
                model.set(op.id, "processing");
              }
              break;
            }
            case "end": {
              if (model.get(op.id) === "processing") {
                svc.endProcessing(op.id);
                model.set(op.id, "active");
              }
              break;
            }
          }
          applyAndCheck();
        }
      }),
      { numRuns: 200 },
    );
  });
});

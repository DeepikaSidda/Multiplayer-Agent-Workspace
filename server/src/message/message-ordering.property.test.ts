import { describe, it, expect } from "vitest";
import fc from "fast-check";

import type { Message, MessageKind, ParticipantType } from "@maw/shared";
import { orderMessages } from "./ordering.js";

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const senderTypeArb: fc.Arbitrary<ParticipantType> = fc.constantFrom(
  "human",
  "agent",
);
const kindArb: fc.Arbitrary<MessageKind> = fc.constantFrom(
  "chat",
  "agent",
  "error",
);

/**
 * A single message with a deliberately small `timestamp` range so ties are
 * frequent, forcing the `sequence` tiebreaker to matter. `sequence` also uses
 * a small range so the same `(timestamp, sequence)` pair can recur across
 * distinct messages (exercising the comparator's zero case).
 */
const messageArb: fc.Arbitrary<Message> = fc.record({
  id: fc.uuid(),
  workspaceId: fc.constant("ws-1"),
  senderId: fc.string({ minLength: 1, maxLength: 8 }),
  senderType: senderTypeArb,
  senderName: fc.string({ minLength: 1, maxLength: 8 }),
  content: fc.string({ minLength: 1, maxLength: 12 }),
  // Small range → many timestamp ties.
  timestamp: fc.integer({ min: 0, max: 5 }),
  // Small range → sequence ties possible too.
  sequence: fc.integer({ min: 0, max: 5 }),
  kind: kindArb,
});

const messagesArb: fc.Arbitrary<Message[]> = fc.array(messageArb, {
  minLength: 0,
  maxLength: 30,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Multiset key capturing a message's full identity for permutation checks. */
function bag(messages: readonly Message[]): string[] {
  return messages
    .map((m) => `${m.id}|${m.timestamp}|${m.sequence}`)
    .sort();
}

// ---------------------------------------------------------------------------
// Property 8: Message display order is total by (timestamp, sequence) (3.4)
// ---------------------------------------------------------------------------

// Feature: multiplayer-agent-workspace, Property 8: Message display order is total by (timestamp, sequence)
describe("orderMessages — Property 8: message display order is total by (timestamp, sequence)", () => {
  it("presents messages sorted by ascending timestamp, ties broken by ascending sequence", () => {
    // **Validates: Requirements 3.4**
    fc.assert(
      fc.property(messagesArb, (messages) => {
        const original = messages.map((m) => ({ ...m }));
        const ordered = orderMessages(messages);

        // (1) Total order: every adjacent pair is non-decreasing under the
        // (timestamp, sequence) lexicographic order.
        for (let i = 0; i + 1 < ordered.length; i++) {
          const a = ordered[i]!;
          const b = ordered[i + 1]!;
          const nonDecreasing =
            a.timestamp < b.timestamp ||
            (a.timestamp === b.timestamp && a.sequence <= b.sequence);
          expect(nonDecreasing).toBe(true);
        }

        // (2) Agreement with an independent reference sort over the same keys.
        const reference = [...messages].sort((a, b) =>
          a.timestamp !== b.timestamp
            ? a.timestamp - b.timestamp
            : a.sequence - b.sequence,
        );
        expect(ordered.map((m) => [m.timestamp, m.sequence])).toEqual(
          reference.map((m) => [m.timestamp, m.sequence]),
        );

        // (3) Permutation: the output is a reordering of the input — no
        // messages added, dropped, or duplicated.
        expect(bag(ordered)).toEqual(bag(messages));

        // (4) No mutation of the caller's array.
        expect(messages).toEqual(original);
      }),
      { numRuns: 300 },
    );
  });
});

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { MESSAGE_MIN_LENGTH, MESSAGE_MAX_LENGTH } from "@maw/shared";
import {
  InMemoryWorkspaceStore,
  type WorkspaceCreation,
} from "../store/index.js";
import { MessageService, type SenderInfo, type SenderResolver } from "./index.js";

// ---------------------------------------------------------------------------
// Property-based test for valid message append (Property 6).
//
// The MessageService owns the authoritative, committed Message_Log that every
// active participant reads (the server is the single ordering authority, so
// `getMessages` is exactly the view delivered to all active participants). This
// test exercises real validation, stamping, and persist-before-commit logic
// against the in-memory store with an injected clock and id generator.
// ---------------------------------------------------------------------------

const WS = "ws-1";

/** The workspace roster used to resolve sender identity. */
const PARTICIPANTS: Record<string, SenderInfo> = {
  "p-owner": { senderType: "human", senderName: "Owner" },
  "p-bob": { senderType: "human", senderName: "Bob" },
  "a-nova": { senderType: "agent", senderName: "Nova" },
};

const senderResolver: SenderResolver = (_workspaceId, senderId) => {
  const info = PARTICIPANTS[senderId];
  if (info === undefined) {
    throw new Error(`unknown sender: ${senderId}`);
  }
  return info;
};

function makeCreation(): WorkspaceCreation {
  return {
    workspace: {
      id: WS,
      joinReference: "join-abc",
      ownerId: "p-owner",
      artifactId: "art-1",
      createdAt: 1_000,
    },
    owner: {
      id: "p-owner",
      workspaceId: WS,
      type: "human",
      displayName: "Owner",
      joinedAt: 1_000,
      presenceState: "active",
    },
    artifact: {
      id: "art-1",
      workspaceId: WS,
      artifactType: "plan",
      content: "",
      lastEditorId: null,
      lastEditedAt: null,
      yjsState: new Uint8Array(),
    },
  };
}

/** A deterministic, monotonically-increasing id generator. */
function seqIds(): () => string {
  let n = 0;
  return () => `m-${n++}`;
}

// A guaranteed non-whitespace character so generated content always has at
// least one non-whitespace char.
const nonWhitespaceChar = fc.constantFrom(
  ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()",
);

// Valid content: >= 1 non-whitespace char, length within [MIN, MAX]. A
// non-whitespace core is prepended (surviving the length clamp) and the rest
// is arbitrary text (which may itself contain whitespace).
const validContentArb = fc
  .tuple(nonWhitespaceChar, fc.string({ maxLength: MESSAGE_MAX_LENGTH - 1 }))
  .map(([core, rest]) => (core + rest).slice(0, MESSAGE_MAX_LENGTH));

// A single valid submission: who sent it, its content, and the millisecond
// clock value observed when it is stamped.
const submissionArb = fc.record({
  senderId: fc.constantFrom(...Object.keys(PARTICIPANTS)),
  content: validContentArb,
  // Arbitrary integer millisecond timestamps (millisecond precision).
  timestamp: fc.integer({ min: 0, max: 4_102_444_800_000 }),
});

// Feature: multiplayer-agent-workspace, Property 6: Valid messages are appended with identity and millisecond timestamp
describe("Property 6: Valid messages are appended with identity and millisecond timestamp", () => {
  it("appends exactly one identity-stamped, ms-timestamped entry per valid message, visible to all active participants", async () => {
    // **Validates: Requirements 3.1, 3.3, 3.5**
    await fc.assert(
      fc.asyncProperty(
        fc.array(submissionArb, { minLength: 1, maxLength: 30 }),
        async (submissions) => {
          const store = new InMemoryWorkspaceStore();
          await store.createWorkspace(makeCreation());

          // Injected clock returns the i-th submission's timestamp on the
          // i-th (valid) submit, which calls now() exactly once.
          let clockIndex = 0;
          const now = () => submissions[Math.min(clockIndex++, submissions.length - 1)]!.timestamp;

          const service = new MessageService(store, senderResolver, {
            now,
            generateId: seqIds(),
          });

          let appended = 0;
          for (const submission of submissions) {
            const before = service.getMessages(WS).length;
            const result = await service.submit(
              WS,
              submission.senderId,
              submission.content,
            );

            // A valid message is accepted.
            expect(result.ok).toBe(true);
            if (!result.ok) return false;
            const message = result.message;

            // Exactly one new entry is appended to the log.
            const after = service.getMessages(WS).length;
            expect(after).toBe(before + 1);

            // The appended entry carries the sender's identity.
            const expected = PARTICIPANTS[submission.senderId]!;
            expect(message.senderId).toBe(submission.senderId);
            expect(message.senderType).toBe(expected.senderType);
            expect(message.senderName).toBe(expected.senderName);
            expect(message.content).toBe(submission.content);

            // Millisecond-precision timestamp equal to the observed clock.
            expect(message.timestamp).toBe(submission.timestamp);
            expect(Number.isInteger(message.timestamp)).toBe(true);

            // The content satisfies the validity bounds it was accepted under.
            expect(message.content.length).toBeGreaterThanOrEqual(
              MESSAGE_MIN_LENGTH,
            );
            expect(message.content.length).toBeLessThanOrEqual(
              MESSAGE_MAX_LENGTH,
            );
            expect(message.content.trim().length).toBeGreaterThan(0);

            // Delivered to all active participants: the committed log every
            // participant reads now contains this exact message.
            const inLog = service.getMessages(WS).some(
              (m) => m.id === message.id && m.content === message.content,
            );
            expect(inLog).toBe(true);

            appended += 1;
          }

          // Append/delivery completeness: the running log length equals the
          // number of successful submits, and every submission is present.
          const finalLog = service.getMessages(WS);
          expect(finalLog.length).toBe(appended);
          expect(finalLog.length).toBe(submissions.length);

          return true;
        },
      ),
      { numRuns: 100 },
    );
  });
});

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { MESSAGE_MAX_LENGTH } from "@maw/shared";
import {
  InMemoryWorkspaceStore,
  type WorkspaceCreation,
} from "../store/index.js";
import { MessageService, type SenderInfo, type SenderResolver } from "./index.js";

// ---------------------------------------------------------------------------
// Property-based test for invalid message rejection (Property 7).
//
// Content is invalid when it is empty (EMPTY), whitespace-only (WHITESPACE_ONLY),
// or longer than MESSAGE_MAX_LENGTH characters (TOO_LONG). The MessageService
// must reject such content, leave the committed Message_Log unchanged, and
// return a rejection reason. Valid submissions are interleaved so the property
// also proves that rejections never disturb an already non-empty log.
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

const REJECTION_REASONS = new Set(["EMPTY", "WHITESPACE_ONLY", "TOO_LONG"]);

// A guaranteed non-whitespace character.
const nonWhitespaceChar = fc.constantFrom(
  ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()",
);

// Whitespace characters that String.prototype.trim() strips.
const whitespaceChar = fc.constantFrom(" ", "\t", "\n", "\r", "\f", "\v");

// --- Invalid content generators, one per rejection category ---------------

// (a) Empty content -> EMPTY.
const emptyContentArb = fc.constant("");

// (b) Whitespace-only content (length within the limit) -> WHITESPACE_ONLY.
const whitespaceContentArb = fc
  .array(whitespaceChar, { minLength: 1, maxLength: MESSAGE_MAX_LENGTH })
  .map((chars) => chars.join(""));

// (c) Over-length content -> TOO_LONG. Include non-whitespace characters so the
// content is rejected purely for its length (not for being whitespace-only).
const tooLongContentArb = fc
  .array(nonWhitespaceChar, {
    minLength: MESSAGE_MAX_LENGTH + 1,
    maxLength: MESSAGE_MAX_LENGTH + 500,
  })
  .map((chars) => chars.join(""));

const invalidContentArb = fc.oneof(
  emptyContentArb,
  whitespaceContentArb,
  tooLongContentArb,
);

// Valid content: >= 1 non-whitespace char, length within [1, MAX].
const validContentArb = fc
  .tuple(nonWhitespaceChar, fc.string({ maxLength: MESSAGE_MAX_LENGTH - 1 }))
  .map(([core, rest]) => (core + rest).slice(0, MESSAGE_MAX_LENGTH));

// A submission is either a valid message (advances the log) or an invalid one
// (must be rejected without changing the log).
const submissionArb = fc.oneof(
  fc.record({
    valid: fc.constant(true),
    senderId: fc.constantFrom(...Object.keys(PARTICIPANTS)),
    content: validContentArb,
  }),
  fc.record({
    valid: fc.constant(false),
    senderId: fc.constantFrom(...Object.keys(PARTICIPANTS)),
    content: invalidContentArb,
  }),
);

// Feature: multiplayer-agent-workspace, Property 7: Invalid messages are rejected
describe("Property 7: Invalid messages are rejected", () => {
  it("rejects empty, whitespace-only, and over-length content, leaving the log unchanged and returning a rejection reason", async () => {
    // **Validates: Requirements 3.2**
    await fc.assert(
      fc.asyncProperty(
        fc.array(submissionArb, { minLength: 1, maxLength: 40 }),
        async (submissions) => {
          const store = new InMemoryWorkspaceStore();
          await store.createWorkspace(makeCreation());
          const service = new MessageService(store, senderResolver, {
            now: () => 100,
            generateId: seqIds(),
          });

          // Track the number of committed (valid) messages so we can assert the
          // log length equals exactly the count of accepted messages.
          let committed = 0;

          for (const submission of submissions) {
            const logBefore = service.getMessages(WS);
            const result = await service.submit(
              WS,
              submission.senderId,
              submission.content,
            );

            if (submission.valid) {
              // Valid content is accepted and grows the log by exactly one.
              expect(result.ok).toBe(true);
              committed += 1;
              expect(service.getMessages(WS).length).toBe(committed);
            } else {
              // Invalid content is rejected with a rejection reason...
              expect(result.ok).toBe(false);
              if (result.ok) return false;
              expect(REJECTION_REASONS.has(result.reason)).toBe(true);

              // ...and the committed log is left completely unchanged.
              const logAfter = service.getMessages(WS);
              expect(logAfter.length).toBe(committed);
              expect(logAfter).toEqual(logBefore);

              // Nothing was persisted for the rejected submission either.
              expect((await store.loadMessages(WS)).length).toBe(committed);
            }
          }

          // The final log holds exactly the accepted messages — no rejected
          // content ever leaked into it.
          expect(service.getMessages(WS).length).toBe(committed);
          return true;
        },
      ),
      { numRuns: 100 },
    );
  });
});

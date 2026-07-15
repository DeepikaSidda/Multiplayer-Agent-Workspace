import { describe, it, expect } from "vitest";
import fc from "fast-check";
import * as Y from "yjs";
import type { ArtifactSnapshot, Workspace } from "@maw/shared";
import {
  InMemoryWorkspaceStore,
  FailureInjectingWorkspaceStore,
  type WorkspaceCreation,
} from "./index.js";
import { MessageService, type SenderResolver } from "../message/index.js";
import { ArtifactService, ARTIFACT_TEXT_KEY } from "../artifact/index.js";

/**
 * Property test for transactional persistence failure (Property 21).
 *
 * Per the design's testing strategy, persistence properties use an in-memory
 * `WorkspaceStore` plus the failure-injecting decorator. This drives an
 * arbitrary interleaving of message submissions and artifact edits — each
 * flagged to either succeed or have its durable persist fail — against a shared
 * `MessageService` + `ArtifactService` backed by the same failure-injecting
 * store. A reference model tracks only the *committed* (last-persisted) state:
 * the message log and the artifact content advance solely on successful ops.
 *
 * The property asserts that a persist failure is transactional: the operation
 * is rejected with the expected save error, no committed state changes (so
 * nothing broadcastable is produced), and the last successfully persisted state
 * is retained — verified against both the service's in-memory view and the
 * durable store on every step.
 */

const WS_ID = "ws-txn";
const ARTIFACT_ID = "art-txn";

/** A local Yjs client used to generate genuine incremental updates. */
class Client {
  readonly doc: Y.Doc;
  constructor(seed?: Uint8Array) {
    this.doc = new Y.Doc();
    if (seed && seed.length > 0) Y.applyUpdate(this.doc, seed);
  }
  private get text(): Y.Text {
    return this.doc.getText(ARTIFACT_TEXT_KEY);
  }
  /** Append text and return the full encoded state as the update to send. */
  append(str: string): Uint8Array {
    this.text.insert(this.text.length, str);
    return Y.encodeStateAsUpdate(this.doc);
  }
  /** The current CRDT state (used to fork throwaway clients for failed edits). */
  state(): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc);
  }
}

const humanSender: SenderResolver = () => ({
  senderType: "human",
  senderName: "Owner",
});

function emptyArtifact(): ArtifactSnapshot {
  return {
    id: ARTIFACT_ID,
    workspaceId: WS_ID,
    artifactType: "plan",
    content: "",
    lastEditorId: null,
    lastEditedAt: null,
    yjsState: Y.encodeStateAsUpdate(new Y.Doc()),
  };
}

function makeCreation(): WorkspaceCreation {
  const workspace: Workspace = {
    id: WS_ID,
    joinReference: "join-txn",
    ownerId: "p-owner",
    artifactId: ARTIFACT_ID,
    createdAt: 1_000,
  };
  return {
    workspace,
    owner: {
      id: "p-owner",
      workspaceId: WS_ID,
      type: "human",
      displayName: "Owner",
      joinedAt: 1_000,
      presenceState: "active",
    },
    artifact: emptyArtifact(),
  };
}

/** An operation in the interleaving: a message submit or an artifact edit. */
type Op =
  | { kind: "msg"; fail: boolean; content: string }
  | { kind: "art"; fail: boolean; text: string };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constant<"msg">("msg"),
    fail: fc.boolean(),
    // Prefix with a non-whitespace char so the content is always valid
    // (>=1 non-whitespace, well under the 4000-char limit): this isolates the
    // property to persistence failure, not content validation.
    content: fc.string({ maxLength: 40 }).map((s) => `m${s}`),
  }),
  fc.record({
    kind: fc.constant<"art">("art"),
    fail: fc.boolean(),
    text: fc.string({ minLength: 1, maxLength: 40 }),
  }),
);

describe("transactional persistence failure (Property 21)", () => {
  // Feature: multiplayer-agent-workspace, Property 21: Persistence failure is transactional
  // Validates: Requirements 8.2, 8.4
  it("rejects a failed message/artifact persist, retains last persisted state, and never commits the change", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(opArb, { minLength: 1, maxLength: 40 }),
        async (ops) => {
          const inner = new InMemoryWorkspaceStore();
          await inner.createWorkspace(makeCreation());
          const store = new FailureInjectingWorkspaceStore(inner);

          let clock = 0;
          const messages = new MessageService(store, humanSender, {
            now: () => ++clock,
            generateId: (() => {
              let n = 0;
              return () => `msg-${n++}`;
            })(),
          });
          const artifacts = new ArtifactService(store, { now: () => ++clock });
          await artifacts.ensureLoaded(WS_ID);

          // Reference model of the last successfully persisted state. Only
          // successful ops advance it; a failed persist must leave it untouched.
          const committedMessages: string[] = [];
          let committedContent = "";
          // Canonical Yjs client kept in sync with the authoritative doc; it
          // only advances on a successful edit.
          const canonical = new Client();

          for (const op of ops) {
            if (op.kind === "msg") {
              if (op.fail) {
                store.failOn("appendMessage");
                const result = await messages.submit(WS_ID, "p-owner", op.content);
                store.clearFailure("appendMessage");
                // Rejected with a save error; nothing committed/broadcastable.
                expect(result).toEqual({ ok: false, reason: "SAVE_FAILED" });
              } else {
                const result = await messages.submit(WS_ID, "p-owner", op.content);
                expect(result.ok).toBe(true);
                committedMessages.push(op.content);
              }
            } else {
              if (op.fail) {
                // Fork a throwaway client so the failed edit is never folded
                // into the canonical (committed) client state.
                const fork = new Client(canonical.state());
                const update = fork.append(op.text);
                store.failOn("saveArtifactSnapshot");
                const result = await artifacts.applyUpdate(WS_ID, update, "p-owner");
                store.clearFailure("saveArtifactSnapshot");
                // Rejected with a save error; artifact reverts to last persisted.
                expect(result).toEqual({ ok: false, reason: "PERSIST_FAILED" });
              } else {
                const update = canonical.append(op.text);
                const result = await artifacts.applyUpdate(WS_ID, update, "p-owner");
                expect(result.ok).toBe(true);
                committedContent += op.text;
              }
            }

            // After every op the committed state equals the model, from both
            // the in-memory service view and the durable store.
            expect(messages.getMessages(WS_ID).map((m) => m.content)).toEqual(
              committedMessages,
            );
            expect((await inner.loadMessages(WS_ID)).map((m) => m.content)).toEqual(
              committedMessages,
            );
            expect(artifacts.getContent(WS_ID)).toBe(committedContent);
            expect((await inner.loadArtifact(WS_ID))?.content).toBe(
              committedContent,
            );
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

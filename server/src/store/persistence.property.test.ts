import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type {
  ArtifactSnapshot,
  ArtifactType,
  Message,
  MessageKind,
  ParticipantType,
  Workspace,
} from "@maw/shared";
import {
  InMemoryWorkspaceStore,
  SqliteWorkspaceStore,
  type WorkspaceCreation,
  type WorkspaceStore,
} from "./index.js";

/**
 * Property test for the persistence round-trip.
 *
 * Uses the in-memory store (per the design's testing strategy for persistence
 * properties) and additionally exercises the SQLite store so the round-trip is
 * validated across both `WorkspaceStore` implementations within a single
 * property. Each generated run gets a fresh store, so fixed ids are safe.
 */

const WS_ID = "ws-roundtrip";
const ARTIFACT_ID = "art-roundtrip";

const ARTIFACT_TYPES: ArtifactType[] = [
  "plan",
  "PRD",
  "issue",
  "workflow",
  "pitch",
  "checklist",
];

/** A generated message before an id/sequence are assigned. */
interface DraftMessage {
  timestamp: number;
  content: string;
  senderId: string;
  senderType: ParticipantType;
  senderName: string;
  kind: MessageKind;
}

const draftMessageArb: fc.Arbitrary<DraftMessage> = fc.record({
  // Wide timestamp range with intentional collisions so ties must be broken
  // by the monotonic `sequence`.
  timestamp: fc.integer({ min: 0, max: 5_000 }),
  content: fc.string({ maxLength: 200 }),
  senderId: fc.constantFrom("p-owner", "p-2", "a-1"),
  senderType: fc.constantFrom<ParticipantType>("human", "agent"),
  senderName: fc.string({ maxLength: 24 }),
  kind: fc.constantFrom<MessageKind>("chat", "agent", "error"),
});

/**
 * A full persisted workspace state: an artifact snapshot (content + yjsState)
 * plus a message log with unique ids and unique, monotonic sequence numbers.
 */
const persistedStateArb = fc
  .record({
    artifactType: fc.constantFrom(...ARTIFACT_TYPES),
    artifactContent: fc.string({ maxLength: 1_000 }),
    yjsState: fc.uint8Array({ maxLength: 64 }),
    lastEditorId: fc.option(fc.constantFrom("p-owner", "a-1"), { nil: null }),
    lastEditedAt: fc.option(fc.integer({ min: 0, max: 5_000 }), { nil: null }),
    drafts: fc.array(draftMessageArb, { maxLength: 40 }),
    // Shuffle the append order independently of the intended sort order so
    // loadMessages must rely on sorting, not insertion order.
    appendOrder: fc.array(fc.nat(), { maxLength: 40 }),
  })
  .map((s) => {
    // Assign a unique id and a unique, strictly-increasing sequence per message
    // (sequence is the per-workspace tiebreaker; uniqueness makes the target
    // order deterministic).
    const messages: Message[] = s.drafts.map((d, i) => ({
      id: `m-${i}`,
      workspaceId: WS_ID,
      senderId: d.senderId,
      senderType: d.senderType,
      senderName: d.senderName,
      content: d.content,
      timestamp: d.timestamp,
      sequence: i,
      kind: d.kind,
    }));

    const artifact: ArtifactSnapshot = {
      id: ARTIFACT_ID,
      workspaceId: WS_ID,
      artifactType: s.artifactType,
      content: s.artifactContent,
      lastEditorId: s.lastEditorId,
      lastEditedAt: s.lastEditedAt,
      yjsState: s.yjsState,
    };

    // A distinct append order: rotate the messages by a generated offset.
    const appendOrder =
      messages.length === 0
        ? []
        : rotate(messages, (s.appendOrder[0] ?? 0) % messages.length);

    return { messages, artifact, appendOrder };
  });

function rotate<T>(arr: readonly T[], by: number): T[] {
  const n = arr.length;
  if (n === 0) return [];
  const k = ((by % n) + n) % n;
  return [...arr.slice(k), ...arr.slice(0, k)];
}

/** The target total order: ascending timestamp, ties broken by ascending sequence. */
function expectedOrder(messages: readonly Message[]): Message[] {
  return [...messages].sort((a, b) =>
    a.timestamp !== b.timestamp
      ? a.timestamp - b.timestamp
      : a.sequence - b.sequence,
  );
}

function makeCreation(): WorkspaceCreation {
  const workspace: Workspace = {
    id: WS_ID,
    joinReference: "join-roundtrip",
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
    artifact: {
      id: ARTIFACT_ID,
      workspaceId: WS_ID,
      artifactType: "plan",
      content: "",
      lastEditorId: null,
      lastEditedAt: null,
      yjsState: new Uint8Array(),
    },
  };
}

function makeStore(kind: "memory" | "sqlite"): {
  store: WorkspaceStore;
  close: () => void;
} {
  if (kind === "sqlite") {
    const store = new SqliteWorkspaceStore(":memory:");
    return { store, close: () => store.close() };
  }
  return { store: new InMemoryWorkspaceStore(), close: () => {} };
}

describe("persistence round-trip (Property 20)", () => {
  // Feature: multiplayer-agent-workspace, Property 20: Persistence round-trip restores full state
  // Validates: Requirements 8.1, 8.3, 8.5
  it("rejoining restores identical artifact content and the full message log in (timestamp, sequence) order", async () => {
    await fc.assert(
      fc.asyncProperty(
        persistedStateArb,
        fc.constantFrom<"memory" | "sqlite">("memory", "sqlite"),
        async (state, kind) => {
          const { store, close } = makeStore(kind);
          try {
            // Persist a full workspace state: create the workspace, save the
            // final artifact snapshot, and durably append every message.
            await store.createWorkspace(makeCreation());
            await store.saveArtifactSnapshot(state.artifact);
            for (const m of state.appendOrder) {
              await store.appendMessage(m);
            }

            // Rejoin: reload the persisted state.
            const loadedArtifact = await store.loadArtifact(WS_ID);
            const loadedMessages = await store.loadMessages(WS_ID);

            // Artifact content (and metadata + CRDT bytes) restored identically.
            expect(loadedArtifact).not.toBeNull();
            expect(loadedArtifact!.content).toBe(state.artifact.content);
            expect(loadedArtifact!.artifactType).toBe(
              state.artifact.artifactType,
            );
            expect(loadedArtifact!.lastEditorId).toBe(
              state.artifact.lastEditorId,
            );
            expect(loadedArtifact!.lastEditedAt).toBe(
              state.artifact.lastEditedAt,
            );
            expect(Array.from(loadedArtifact!.yjsState)).toEqual(
              Array.from(state.artifact.yjsState),
            );

            // The complete message log is restored in (timestamp, sequence) order.
            expect(loadedMessages).toEqual(expectedOrder(state.messages));
          } finally {
            close();
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

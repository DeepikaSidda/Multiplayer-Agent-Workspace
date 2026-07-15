import { describe, it, expect } from "vitest";
import fc from "fast-check";
import * as Y from "yjs";
import type {
  ArtifactType,
  Message,
  MessageKind,
  ParticipantType,
  WorkspaceSnapshotPayload,
} from "@maw/shared";
import { InMemoryWorkspaceStore } from "../store/index.js";
import { WorkspaceService } from "../workspace/WorkspaceService.js";
import { RoomManager } from "../room/RoomManager.js";
import { ARTIFACT_TEXT_KEY } from "../artifact/ArtifactService.js";
import { WebSocketGateway } from "./WebSocketGateway.js";
import { FakeConnection } from "./Connection.js";

/**
 * Property test for the join snapshot (task 11.2).
 *
 * The gateway delivers a single `workspaceSnapshot` on join carrying the
 * current artifact content plus the complete message log. This property drives
 * the gateway against real services (WorkspaceService + RoomManager +
 * InMemoryWorkspaceStore) with no mocks: an arbitrary workspace state is
 * materialized durably (a consistent artifact snapshot and a message log with
 * genuine `timestamp` collisions appended out of order), then a fresh
 * connection joins and the captured snapshot is checked against the current
 * artifact content and an independent `(timestamp, sequence)` ordering.
 */

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
  // A deliberately narrow timestamp range so many messages collide on
  // `timestamp` and the append `sequence` must break the tie.
  timestamp: fc.integer({ min: 0, max: 50 }),
  content: fc.string({ maxLength: 200 }),
  senderId: fc.constantFrom("p-owner", "p-2", "a-1"),
  senderType: fc.constantFrom<ParticipantType>("human", "agent"),
  senderName: fc.string({ maxLength: 24 }),
  kind: fc.constantFrom<MessageKind>("chat", "agent", "error"),
});

/** An arbitrary durable workspace state: artifact content + a message log. */
const stateArb = fc.record({
  artifactType: fc.constantFrom(...ARTIFACT_TYPES),
  artifactContent: fc.string({ maxLength: 500 }),
  drafts: fc.array(draftMessageArb, { maxLength: 30 }),
  // Rotation offset so messages are appended in an order distinct from the
  // target sort order — the snapshot must sort, not echo insertion order.
  rotateBy: fc.nat(),
});

/** Rotate `arr` left by `by` positions (stable for `by >= 0`). */
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

/** Encode a Y.Doc whose text field holds `content` (content + yjsState stay consistent). */
function encodeArtifactState(content: string): Uint8Array {
  const doc = new Y.Doc();
  const text = doc.getText(ARTIFACT_TEXT_KEY);
  if (content.length > 0) text.insert(0, content);
  const state = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return state;
}

/** The single snapshot payload delivered to a connection. */
function snapshotOf(conn: FakeConnection): WorkspaceSnapshotPayload {
  const snaps = conn.ofType<{ payload: WorkspaceSnapshotPayload }>(
    "workspaceSnapshot",
  );
  expect(snaps.length).toBe(1);
  return snaps[0]!.payload;
}

describe("WebSocketGateway — join snapshot (Property 4)", () => {
  // Feature: multiplayer-agent-workspace, Property 4: Join snapshot reflects current state
  // Validates: Requirements 1.7, 8.5
  it("delivers the current artifact content and the full message log in (timestamp, sequence) order", async () => {
    await fc.assert(
      fc.asyncProperty(stateArb, async (state) => {
        // Fresh services + gateway per run so fixed workspace state is safe.
        const store = new InMemoryWorkspaceStore();
        const workspaceService = new WorkspaceService(store);
        const roomManager = new RoomManager(store);
        const gateway = new WebSocketGateway({
          workspaceService,
          roomManager,
          store,
        });

        const created = await workspaceService.createWorkspace({
          ownerDisplayName: "Owner",
          artifactType: state.artifactType,
        });
        if (!created.ok) throw new Error("failed to create workspace");
        const { workspace } = created;

        // Overwrite the initial (empty) artifact with a consistent snapshot:
        // the persisted `content` matches the encoded `yjsState`, so the
        // authoritative content warmed on join equals `artifactContent`.
        await store.saveArtifactSnapshot({
          id: workspace.artifactId,
          workspaceId: workspace.id,
          artifactType: state.artifactType,
          content: state.artifactContent,
          lastEditorId: null,
          lastEditedAt: null,
          yjsState: encodeArtifactState(state.artifactContent),
        });

        // Assign a unique, strictly-increasing sequence per message (the
        // per-workspace tiebreaker), then append in a rotated order so the
        // durable insertion order differs from the target sort order.
        const messages: Message[] = state.drafts.map((d, i) => ({
          id: `m-${i}`,
          workspaceId: workspace.id,
          senderId: d.senderId,
          senderType: d.senderType,
          senderName: d.senderName,
          content: d.content,
          timestamp: d.timestamp,
          sequence: i,
          kind: d.kind,
        }));
        for (const m of rotate(messages, state.rotateBy)) {
          await store.appendMessage(m);
        }

        // A brand-new connection joins and receives the snapshot.
        const conn = new FakeConnection();
        gateway.handleConnection(conn);
        await conn.receive({
          type: "join",
          workspaceId: "",
          payload: {
            joinReference: workspace.joinReference,
            displayName: "Joiner",
          },
        });

        const snap = snapshotOf(conn);

        // (1) The snapshot describes the workspace being joined.
        expect(snap.workspace.id).toBe(workspace.id);

        // (2) The artifact reflects the current authoritative content + type.
        expect(snap.artifact.artifactType).toBe(state.artifactType);
        expect(snap.artifact.content).toBe(state.artifactContent);

        // (3) The message log is complete and ordered by (timestamp, sequence).
        expect(snap.messages).toEqual(expectedOrder(messages));

        // (4) The participant roster reflects the current durable roster
        //     (owner + the joining human, no duplicates).
        const roster = await store.loadParticipants(workspace.id);
        expect(new Set(snap.participants.map((p) => p.id))).toEqual(
          new Set(roster.map((p) => p.id)),
        );
        expect(snap.participants.some((p) => p.id === workspace.ownerId)).toBe(
          true,
        );
      }),
      { numRuns: 100 },
    );
  });
});

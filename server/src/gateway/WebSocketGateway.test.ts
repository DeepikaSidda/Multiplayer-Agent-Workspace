import { describe, it, expect, beforeEach } from "vitest";
import * as Y from "yjs";
import type {
  AgentAddedPayload,
  AgentRemovedPayload,
  ArtifactUpdateBroadcastPayload,
  ErrorPayload,
  ExportReadyPayload,
  MessageAppendedPayload,
  MessageRejectedPayload,
  ParticipantCountUpdatePayload,
  PresenceUpdatePayload,
  WorkspaceSnapshotPayload,
} from "@maw/shared";
import { InMemoryWorkspaceStore } from "../store/index.js";
import { WorkspaceService } from "../workspace/WorkspaceService.js";
import { ARTIFACT_TEXT_KEY } from "../artifact/ArtifactService.js";
import { RoomManager } from "../room/RoomManager.js";
import type {
  AgentGenerationInput,
  AgentGenerationResult,
  BedrockAgentService,
} from "../agent/index.js";
import { WebSocketGateway } from "./WebSocketGateway.js";
import { FakeConnection } from "./Connection.js";
import { bytesToBase64 } from "./codec.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** A mock agent service whose response is scripted per test. */
class MockAgentService implements BedrockAgentService {
  result: AgentGenerationResult = { ok: true, responseText: "On it." };
  calls: AgentGenerationInput[] = [];

  async generate(input: AgentGenerationInput): Promise<AgentGenerationResult> {
    this.calls.push(input);
    return this.result;
  }
}

interface Harness {
  store: InMemoryWorkspaceStore;
  workspaceService: WorkspaceService;
  roomManager: RoomManager;
  gateway: WebSocketGateway;
  agentService: MockAgentService;
  workspaceId: string;
  joinReference: string;
}

async function makeHarness(): Promise<Harness> {
  const store = new InMemoryWorkspaceStore();
  const workspaceService = new WorkspaceService(store);
  const agentService = new MockAgentService();
  const roomManager = new RoomManager(store, { agentService });
  const gateway = new WebSocketGateway({ workspaceService, roomManager, store });

  const created = await workspaceService.createWorkspace({
    ownerDisplayName: "Owner",
    artifactType: "plan",
  });
  if (!created.ok) throw new Error("failed to create workspace");

  return {
    store,
    workspaceService,
    roomManager,
    gateway,
    agentService,
    workspaceId: created.workspace.id,
    joinReference: created.workspace.joinReference,
  };
}

/** Connect a fake connection and join the workspace, returning both. */
async function connectAndJoin(
  h: Harness,
  displayName: string,
): Promise<FakeConnection> {
  const conn = new FakeConnection();
  h.gateway.handleConnection(conn);
  await conn.receive({
    type: "join",
    workspaceId: "",
    payload: { joinReference: h.joinReference, displayName },
  });
  return conn;
}

/** The single snapshot payload delivered to a connection. */
function snapshotOf(conn: FakeConnection): WorkspaceSnapshotPayload {
  const snaps = conn.ofType<{ payload: WorkspaceSnapshotPayload }>(
    "workspaceSnapshot",
  );
  expect(snaps.length).toBe(1);
  return snaps[0]!.payload;
}

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});

// ---------------------------------------------------------------------------
// Malformed envelopes (design: untrusted input)
// ---------------------------------------------------------------------------

describe("WebSocketGateway — envelope validation", () => {
  it("drops invalid JSON with a MALFORMED_EVENT error and no state change", async () => {
    const conn = new FakeConnection();
    h.gateway.handleConnection(conn);
    await conn.receiveRaw("{not json");

    const errors = conn.ofType<{ payload: ErrorPayload }>("error");
    expect(errors.length).toBe(1);
    expect(errors[0]!.payload.code).toBe("MALFORMED_EVENT");
  });

  it("drops an unknown event type", async () => {
    const conn = new FakeConnection();
    h.gateway.handleConnection(conn);
    await conn.receive({ type: "nope", workspaceId: "x", payload: {} });

    const errors = conn.ofType<{ payload: ErrorPayload }>("error");
    expect(errors[0]!.payload.code).toBe("MALFORMED_EVENT");
  });

  it("drops a known type with a payload of the wrong shape", async () => {
    const conn = new FakeConnection();
    h.gateway.handleConnection(conn);
    // sendMessage requires a string `content`.
    await conn.receive({
      type: "sendMessage",
      workspaceId: "x",
      payload: { content: 42 },
    });

    const errors = conn.ofType<{ payload: ErrorPayload }>("error");
    expect(errors[0]!.payload.code).toBe("MALFORMED_EVENT");
  });
});

// ---------------------------------------------------------------------------
// join -> snapshot + presence
// ---------------------------------------------------------------------------

describe("WebSocketGateway — join", () => {
  it("returns WORKSPACE_NOT_FOUND for an unknown join reference", async () => {
    const conn = new FakeConnection();
    h.gateway.handleConnection(conn);
    await conn.receive({
      type: "join",
      workspaceId: "",
      payload: { joinReference: "does-not-exist", displayName: "Ann" },
    });

    const errors = conn.ofType<{ payload: ErrorPayload }>("error");
    expect(errors[0]!.payload.code).toBe("WORKSPACE_NOT_FOUND");
    expect(conn.ofType("workspaceSnapshot").length).toBe(0);
  });

  it("sends a workspaceSnapshot with participants, artifact content, and ordered messages", async () => {
    // Seed a couple of messages out of (timestamp, sequence) order in the store.
    await h.store.appendMessage({
      id: "m2",
      workspaceId: h.workspaceId,
      senderId: "s1",
      senderType: "human",
      senderName: "A",
      content: "second",
      timestamp: 200,
      sequence: 1,
      kind: "chat",
    });
    await h.store.appendMessage({
      id: "m1",
      workspaceId: h.workspaceId,
      senderId: "s1",
      senderType: "human",
      senderName: "A",
      content: "first",
      timestamp: 100,
      sequence: 0,
      kind: "chat",
    });

    const conn = await connectAndJoin(h, "Ann");
    const snap = snapshotOf(conn);

    expect(snap.workspace.id).toBe(h.workspaceId);
    // Owner + the joining human are present in the roster.
    expect(snap.participants.length).toBeGreaterThanOrEqual(2);
    expect(snap.artifact.artifactType).toBe("plan");
    expect(snap.artifact.content).toBe("");
    // Messages are ordered by (timestamp, sequence).
    expect(snap.messages.map((m) => m.content)).toEqual(["first", "second"]);
  });

  it("broadcasts presenceUpdate to existing peers and a participantCountUpdate", async () => {
    const first = await connectAndJoin(h, "Ann");
    const second = await connectAndJoin(h, "Bob");

    // The first client sees Bob's presenceUpdate + a count update.
    const presence = first.ofType<{ payload: PresenceUpdatePayload }>(
      "presenceUpdate",
    );
    expect(presence.length).toBeGreaterThanOrEqual(1);
    expect(presence.some((p) => p.payload.presenceState === "active")).toBe(true);

    const counts = first.ofType<{ payload: ParticipantCountUpdatePayload }>(
      "participantCountUpdate",
    );
    expect(counts.length).toBeGreaterThanOrEqual(1);
    expect(counts[counts.length - 1]!.payload.activeCount).toBe(2);

    // The joining client does not receive its own presenceUpdate.
    expect(second.ofType("presenceUpdate").length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// sendMessage
// ---------------------------------------------------------------------------

describe("WebSocketGateway — sendMessage", () => {
  it("broadcasts messageAppended to all clients on a valid message", async () => {
    const ann = await connectAndJoin(h, "Ann");
    const bob = await connectAndJoin(h, "Bob");

    await ann.receive({
      type: "sendMessage",
      workspaceId: h.workspaceId,
      payload: { content: "hello team" },
    });

    for (const conn of [ann, bob]) {
      const appended = conn.ofType<{ payload: MessageAppendedPayload }>(
        "messageAppended",
      );
      expect(appended.length).toBe(1);
      expect(appended[0]!.payload.message.content).toBe("hello team");
    }
  });

  it("rejects an empty message to the sender only", async () => {
    const ann = await connectAndJoin(h, "Ann");
    const bob = await connectAndJoin(h, "Bob");

    await ann.receive({
      type: "sendMessage",
      workspaceId: h.workspaceId,
      payload: { content: "   " },
    });

    const rejected = ann.ofType<{ payload: MessageRejectedPayload }>(
      "messageRejected",
    );
    expect(rejected.length).toBe(1);
    expect(rejected[0]!.payload.reason).toBe("WHITESPACE_ONLY");
    expect(bob.ofType("messageAppended").length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// artifactUpdate
// ---------------------------------------------------------------------------

/** Build a base64 Yjs update that inserts `text` into a fresh doc's text field. */
function makeArtifactUpdate(text: string): string {
  const doc = new Y.Doc();
  const before = Y.encodeStateVector(doc);
  doc.getText(ARTIFACT_TEXT_KEY).insert(0, text);
  const update = Y.encodeStateAsUpdate(doc, before);
  doc.destroy();
  return bytesToBase64(update);
}

describe("WebSocketGateway — artifactUpdate", () => {
  it("applies an update and broadcasts it to peers with a base64 round-trip", async () => {
    const ann = await connectAndJoin(h, "Ann");
    const bob = await connectAndJoin(h, "Bob");

    const yjsUpdate = makeArtifactUpdate("Hello CRDT");
    await ann.receive({
      type: "artifactUpdate",
      workspaceId: h.workspaceId,
      payload: { yjsUpdate },
    });

    // The peer (Bob) receives the broadcast; the sender (Ann) does not.
    const peer = bob.ofType<{ payload: ArtifactUpdateBroadcastPayload }>(
      "artifactUpdate",
    );
    expect(peer.length).toBe(1);
    expect(ann.ofType("artifactUpdate").length).toBe(0);

    // Applying the broadcast update to a fresh doc reproduces the text —
    // confirming the base64 payload round-trips the CRDT bytes.
    const roundTrip = new Y.Doc();
    Y.applyUpdate(
      roundTrip,
      new Uint8Array(Buffer.from(peer[0]!.payload.yjsUpdate, "base64")),
    );
    expect(roundTrip.getText(ARTIFACT_TEXT_KEY).toString()).toBe("Hello CRDT");
    expect(h.roomManager.artifacts.getContent(h.workspaceId)).toBe("Hello CRDT");
  });

  it("rejects a malformed (non-base64) update to the sender", async () => {
    const ann = await connectAndJoin(h, "Ann");
    await ann.receive({
      type: "artifactUpdate",
      workspaceId: h.workspaceId,
      payload: { yjsUpdate: "!!!not base64!!!" },
    });

    const errors = ann.ofType<{ payload: ErrorPayload }>("error");
    expect(errors.some((e) => e.payload.code === "MALFORMED_EVENT")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// addAgent / removeAgent
// ---------------------------------------------------------------------------

describe("WebSocketGateway — agent roster", () => {
  it("broadcasts agentAdded + presence, then agentRemoved on removal", async () => {
    const ann = await connectAndJoin(h, "Ann");

    await ann.receive({
      type: "addAgent",
      workspaceId: h.workspaceId,
      payload: { displayName: "Nova" },
    });

    const added = ann.ofType<{ payload: AgentAddedPayload }>("agentAdded");
    expect(added.length).toBe(1);
    const agentId = added[0]!.payload.participant.id;
    expect(added[0]!.payload.participant.type).toBe("agent");

    await ann.receive({
      type: "removeAgent",
      workspaceId: h.workspaceId,
      payload: { agentId },
    });
    const removed = ann.ofType<{ payload: AgentRemovedPayload }>("agentRemoved");
    expect(removed.length).toBe(1);
    expect(removed[0]!.payload.agentId).toBe(agentId);
  });

  it("returns AGENT_NOT_FOUND when removing an unknown agent", async () => {
    const ann = await connectAndJoin(h, "Ann");
    await ann.receive({
      type: "removeAgent",
      workspaceId: h.workspaceId,
      payload: { agentId: "ghost" },
    });
    const errors = ann.ofType<{ payload: ErrorPayload }>("error");
    expect(errors.some((e) => e.payload.code === "AGENT_NOT_FOUND")).toBe(true);
  });

  it("returns AGENT_LIMIT_REACHED once five agents are present", async () => {
    const ann = await connectAndJoin(h, "Ann");
    for (let i = 0; i < 5; i += 1) {
      await ann.receive({
        type: "addAgent",
        workspaceId: h.workspaceId,
        payload: { displayName: `Agent${i}` },
      });
    }
    await ann.receive({
      type: "addAgent",
      workspaceId: h.workspaceId,
      payload: { displayName: "Overflow" },
    });

    const errors = ann.ofType<{ payload: ErrorPayload }>("error");
    expect(errors.some((e) => e.payload.code === "AGENT_LIMIT_REACHED")).toBe(
      true,
    );
    expect(ann.ofType("agentAdded").length).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Agent response flow (mocked Bedrock)
// ---------------------------------------------------------------------------

describe("WebSocketGateway — agent response on mention", () => {
  it("broadcasts processing presence, the agent message, and the proposed edit", async () => {
    const ann = await connectAndJoin(h, "Ann");
    await ann.receive({
      type: "addAgent",
      workspaceId: h.workspaceId,
      payload: { displayName: "Nova" },
    });

    h.agentService.result = {
      ok: true,
      responseText: "Here is a draft.",
      proposedArtifact: "# Draft\n\nContent",
    };

    await ann.receive({
      type: "sendMessage",
      workspaceId: h.workspaceId,
      payload: { content: "@Nova please draft the plan" },
    });
    await h.gateway.idle();

    // The agent was invoked with the complete context.
    expect(h.agentService.calls.length).toBe(1);

    // The human message + the agent message were both appended/broadcast.
    const appended = ann.ofType<{ payload: MessageAppendedPayload }>(
      "messageAppended",
    );
    expect(appended.some((m) => m.payload.message.senderType === "agent")).toBe(
      true,
    );

    // The proposed artifact edit was broadcast.
    expect(ann.ofType("artifactUpdate").length).toBeGreaterThanOrEqual(1);
    expect(h.roomManager.artifacts.getContent(h.workspaceId)).toBe(
      "# Draft\n\nContent",
    );

    // Processing presence was broadcast during generation, then reverted.
    const presence = ann.ofType<{ payload: PresenceUpdatePayload }>(
      "presenceUpdate",
    );
    expect(presence.some((p) => p.payload.presenceState === "processing")).toBe(
      true,
    );
  });

  it("does not trigger the agent when no agent is mentioned", async () => {
    const ann = await connectAndJoin(h, "Ann");
    await ann.receive({
      type: "addAgent",
      workspaceId: h.workspaceId,
      payload: { displayName: "Nova" },
    });

    await ann.receive({
      type: "sendMessage",
      workspaceId: h.workspaceId,
      payload: { content: "no mentions here" },
    });
    await h.gateway.idle();

    expect(h.agentService.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

describe("WebSocketGateway — export", () => {
  it("returns EXPORT_EMPTY for an empty artifact", async () => {
    const ann = await connectAndJoin(h, "Ann");
    await ann.receive({
      type: "export",
      workspaceId: h.workspaceId,
      payload: {},
    });

    const errors = ann.ofType<{ payload: ErrorPayload }>("error");
    expect(errors.some((e) => e.payload.code === "EXPORT_EMPTY")).toBe(true);
  });

  it("returns exportReady containing the artifact content once edited", async () => {
    const ann = await connectAndJoin(h, "Ann");
    await ann.receive({
      type: "artifactUpdate",
      workspaceId: h.workspaceId,
      payload: { yjsUpdate: makeArtifactUpdate("Ship it") },
    });

    await ann.receive({
      type: "export",
      workspaceId: h.workspaceId,
      payload: {},
    });

    const ready = ann.ofType<{ payload: ExportReadyPayload }>("exportReady");
    expect(ready.length).toBe(1);
    expect(ready[0]!.payload.markdown).toContain("Ship it");
    expect(ready[0]!.payload.filename).toContain(".md");
  });
});

// ---------------------------------------------------------------------------
// Heartbeat / disconnect
// ---------------------------------------------------------------------------

describe("WebSocketGateway — heartbeat", () => {
  it("pings live sessions and reaps a session that misses its pong", async () => {
    const ann = await connectAndJoin(h, "Ann");
    const bob = await connectAndJoin(h, "Bob");

    // First sweep: both are alive -> pinged, liveness cleared.
    h.gateway.runHeartbeatSweep();
    expect(ann.pingCount).toBe(1);
    expect(bob.pingCount).toBe(1);

    // Only Ann replies with a pong before the next sweep.
    ann.pong();

    // Second sweep: Bob missed its pong -> reaped (presence disconnected).
    h.gateway.runHeartbeatSweep();

    const presence = ann.ofType<{ payload: PresenceUpdatePayload }>(
      "presenceUpdate",
    );
    expect(
      presence.some((p) => p.payload.presenceState === "disconnected"),
    ).toBe(true);
    // Ann remains and is pinged again.
    expect(ann.pingCount).toBe(2);
  });
});

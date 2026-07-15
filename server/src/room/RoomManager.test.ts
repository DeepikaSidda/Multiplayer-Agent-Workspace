import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import {
  AGENT_MODEL_ID,
  MAX_AGENTS_PER_WORKSPACE,
  type ArtifactSnapshot,
  type Participant,
  type PresenceState,
  type Workspace,
} from "@maw/shared";
import { InMemoryWorkspaceStore } from "../store/index.js";
import type {
  AgentGenerationInput,
  AgentGenerationResult,
  BedrockAgentService,
} from "../agent/index.js";
import { ARTIFACT_TEXT_KEY } from "../artifact/index.js";
import { RoomManager } from "./index.js";

/** A deterministic, incrementing id generator for stable assertions. */
function makeIds(prefix = "id"): () => string {
  let n = 0;
  return () => `${prefix}-${n++}`;
}

/** Encode an empty artifact Y.Doc state (mirrors WorkspaceService). */
function emptyArtifactState(): Uint8Array {
  const doc = new Y.Doc();
  doc.getText("content");
  const state = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return state;
}

/** Seed a workspace (with owner + empty artifact) directly into the store. */
async function seedWorkspace(
  store: InMemoryWorkspaceStore,
  workspaceId: string,
  ownerId: string,
): Promise<{ workspace: Workspace; owner: Participant }> {
  const workspace: Workspace = {
    id: workspaceId,
    joinReference: `${workspaceId}-ref`,
    ownerId,
    artifactId: `${workspaceId}-artifact`,
    createdAt: 1_000,
  };
  const owner: Participant = {
    id: ownerId,
    workspaceId,
    type: "human",
    displayName: "Owner",
    joinedAt: 1_000,
    presenceState: "active",
  };
  const artifact: ArtifactSnapshot = {
    id: workspace.artifactId,
    workspaceId,
    artifactType: "plan",
    content: "",
    lastEditorId: null,
    lastEditedAt: null,
    yjsState: emptyArtifactState(),
  };
  await store.createWorkspace({ workspace, owner, artifact });
  return { workspace, owner };
}

/** A RoomManager over an in-memory store with a human already registered. */
async function setupRoom(): Promise<{
  store: InMemoryWorkspaceStore;
  rm: RoomManager;
  workspaceId: string;
  ownerId: string;
}> {
  const store = new InMemoryWorkspaceStore();
  const workspaceId = "ws-1";
  const ownerId = "owner-1";
  await seedWorkspace(store, workspaceId, ownerId);

  const rm = new RoomManager(store, { now: () => 2_000, newId: makeIds("agent") });
  await rm.ensureRoom(workspaceId);
  await rm.registerHuman(workspaceId, {
    id: ownerId,
    workspaceId,
    type: "human",
    displayName: "Owner",
    joinedAt: 1_000,
    presenceState: "active",
  });
  return { store, rm, workspaceId, ownerId };
}

describe("RoomManager", () => {
  describe("addAgent", () => {
    it("adds an agent participant with modelId and marks it active", async () => {
      const { rm, workspaceId } = await setupRoom();

      const result = await rm.addAgent(workspaceId, {
        displayName: "Nova",
        persona: "helpful",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.participant.type).toBe("agent");
      expect(result.participant.displayName).toBe("Nova");
      expect(result.participant.persona).toBe("helpful");
      expect(result.participant.modelId).toBe(AGENT_MODEL_ID);

      // Roster and presence reflect the new agent.
      expect(rm.countAgents(workspaceId)).toBe(1);
      expect(rm.getParticipant(workspaceId, result.participant.id)?.type).toBe(
        "agent",
      );
      expect(result.presence.updates[0]?.participantType).toBe("agent");
      expect(rm.getActiveCount(workspaceId)).toBe(2); // owner + agent
    });

    it("caps agents at MAX_AGENTS_PER_WORKSPACE and rejects the overflow", async () => {
      const { rm, workspaceId } = await setupRoom();

      for (let i = 0; i < MAX_AGENTS_PER_WORKSPACE; i++) {
        const r = await rm.addAgent(workspaceId, { displayName: `A${i}` });
        expect(r.ok).toBe(true);
      }
      expect(rm.countAgents(workspaceId)).toBe(MAX_AGENTS_PER_WORKSPACE);

      // The 6th add is rejected and adds nothing.
      const overflow = await rm.addAgent(workspaceId, { displayName: "TooMany" });
      expect(overflow).toEqual({ ok: false, error: "AGENT_LIMIT_REACHED" });
      expect(rm.countAgents(workspaceId)).toBe(MAX_AGENTS_PER_WORKSPACE);
    });

    it("serializes concurrent adds so the cap is never exceeded", async () => {
      const { rm, workspaceId } = await setupRoom();

      // Fire many adds concurrently; the per-room lock must serialize them.
      const results = await Promise.all(
        Array.from({ length: MAX_AGENTS_PER_WORKSPACE + 5 }, (_, i) =>
          rm.addAgent(workspaceId, { displayName: `C${i}` }),
        ),
      );

      const accepted = results.filter((r) => r.ok);
      const rejected = results.filter((r) => !r.ok);
      expect(accepted).toHaveLength(MAX_AGENTS_PER_WORKSPACE);
      expect(rejected).toHaveLength(5);
      expect(rm.countAgents(workspaceId)).toBe(MAX_AGENTS_PER_WORKSPACE);
      for (const r of rejected) {
        expect(r).toEqual({ ok: false, error: "AGENT_LIMIT_REACHED" });
      }
    });
  });

  describe("removeAgent", () => {
    it("add/remove round-trip restores the roster and agent count", async () => {
      const { rm, workspaceId } = await setupRoom();
      const before = rm.getRoster(workspaceId).map((p) => p.id).sort();

      const added = await rm.addAgent(workspaceId, { displayName: "Nova" });
      expect(added.ok).toBe(true);
      if (!added.ok) return;
      expect(rm.countAgents(workspaceId)).toBe(1);

      const removed = await rm.removeAgent(workspaceId, added.participant.id);
      expect(removed.ok).toBe(true);
      if (!removed.ok) return;
      expect(removed.agentId).toBe(added.participant.id);

      expect(rm.countAgents(workspaceId)).toBe(0);
      expect(rm.getRoster(workspaceId).map((p) => p.id).sort()).toEqual(before);
    });

    it("rejects removing a non-participant with AGENT_NOT_FOUND and leaves the roster unchanged", async () => {
      const { rm, workspaceId } = await setupRoom();
      const before = rm.getRoster(workspaceId).map((p) => p.id).sort();

      const result = await rm.removeAgent(workspaceId, "ghost-agent");
      expect(result).toEqual({ ok: false, error: "AGENT_NOT_FOUND" });
      expect(rm.getRoster(workspaceId).map((p) => p.id).sort()).toEqual(before);
    });

    it("rejects removing a human as AGENT_NOT_FOUND (only agents are removable)", async () => {
      const { rm, workspaceId, ownerId } = await setupRoom();

      const result = await rm.removeAgent(workspaceId, ownerId);
      expect(result).toEqual({ ok: false, error: "AGENT_NOT_FOUND" });
      expect(rm.getParticipant(workspaceId, ownerId)?.type).toBe("human");
    });
  });

  describe("resolveSender", () => {
    it("resolves a registered participant's identity from the roster", async () => {
      const { rm, workspaceId, ownerId } = await setupRoom();
      const added = await rm.addAgent(workspaceId, { displayName: "Nova" });
      expect(added.ok).toBe(true);
      if (!added.ok) return;

      expect(rm.resolveSender(workspaceId, ownerId)).toEqual({
        senderType: "human",
        senderName: "Owner",
      });
      expect(rm.resolveSender(workspaceId, added.participant.id)).toEqual({
        senderType: "agent",
        senderName: "Nova",
      });
    });

    it("throws for an unknown sender", async () => {
      const { rm, workspaceId } = await setupRoom();
      expect(() => rm.resolveSender(workspaceId, "nobody")).toThrow(
        /not a participant/,
      );
    });
  });

  describe("serialized message submission", () => {
    it("submits a message through the room using the roster-backed resolver", async () => {
      const { rm, workspaceId, ownerId } = await setupRoom();

      const result = await rm.submitMessage(workspaceId, ownerId, "hello team");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.message.senderName).toBe("Owner");
      expect(result.message.senderType).toBe("human");
      expect(result.message.content).toBe("hello team");
      expect(rm.messages.getMessages(workspaceId)).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Agent response orchestration (task 10.2)
// ---------------------------------------------------------------------------

/** A minimal mock BedrockAgentService driven by a supplied handler (no AWS). */
function mockAgentService(
  handler: (input: AgentGenerationInput) => Promise<AgentGenerationResult> | AgentGenerationResult,
): BedrockAgentService {
  return { generate: (input) => Promise.resolve(handler(input)) };
}

/** Fork a Y.Doc synced to the workspace's currently persisted CRDT state. */
async function syncedDoc(
  store: InMemoryWorkspaceStore,
  workspaceId: string,
): Promise<Y.Doc> {
  const snapshot = await store.loadArtifact(workspaceId);
  const doc = new Y.Doc();
  if (snapshot && snapshot.yjsState.length > 0) {
    Y.applyUpdate(doc, snapshot.yjsState);
  }
  return doc;
}

/**
 * Build a RoomManager wired with a mock agent service, an owner (human) already
 * registered, and one agent added. Returns handles for the tests.
 */
async function setupAgentRoom(agentService: BedrockAgentService): Promise<{
  store: InMemoryWorkspaceStore;
  rm: RoomManager;
  workspaceId: string;
  ownerId: string;
  agentId: string;
}> {
  const store = new InMemoryWorkspaceStore();
  const workspaceId = "ws-1";
  const ownerId = "owner-1";
  await seedWorkspace(store, workspaceId, ownerId);

  const rm = new RoomManager(store, {
    now: () => 2_000,
    newId: makeIds("agent"),
    agentService,
  });
  await rm.ensureRoom(workspaceId);
  await rm.registerHuman(workspaceId, {
    id: ownerId,
    workspaceId,
    type: "human",
    displayName: "Owner",
    joinedAt: 1_000,
    presenceState: "active",
  });

  const added = await rm.addAgent(workspaceId, { displayName: "Nova" });
  if (!added.ok) throw new Error("failed to add agent");
  return { store, rm, workspaceId, ownerId, agentId: added.participant.id };
}

describe("RoomManager.triggerAgentResponse", () => {
  it("appends exactly one agent message and shows processing during generation, reverting after", async () => {
    let presenceDuringGen: PresenceState | null = null;
    // Assigned before generate() is invoked (generation runs after setup).
    let rmRef!: RoomManager;
    let agentIdRef = "";
    let workspaceIdRef = "";

    const agentService = mockAgentService(() => {
      presenceDuringGen =
        rmRef.getPresence(workspaceIdRef)?.getPresence(agentIdRef) ?? null;
      return { ok: true, responseText: "Here is my take on the plan." };
    });

    const { rm, workspaceId, ownerId, agentId } =
      await setupAgentRoom(agentService);
    rmRef = rm;
    agentIdRef = agentId;
    workspaceIdRef = workspaceId;

    // A human message that names the agent triggers the response.
    await rm.submitMessage(workspaceId, ownerId, "@Nova what do you think?");
    const beforeCount = rm.messages.getMessages(workspaceId).length;

    let processingBroadcast: PresenceState | undefined;
    const result = await rm.triggerAgentResponse(workspaceId, agentId, {
      onProcessing: (change) => {
        processingBroadcast = change.updates[0]?.presenceState;
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe("success");

    // Presence was "processing" during generation and broadcast as such.
    expect(presenceDuringGen).toBe("processing");
    expect(processingBroadcast).toBe("processing");
    // ...and reverts to "active" afterward.
    expect(rm.getPresence(workspaceId)?.getPresence(agentId)).toBe("active");
    expect(result.idlePresence.updates[0]?.presenceState).toBe("active");

    // Exactly one agent-attributed message was appended.
    const messages = rm.messages.getMessages(workspaceId);
    expect(messages.length).toBe(beforeCount + 1);
    const agentMessages = messages.filter((m) => m.senderId === agentId);
    expect(agentMessages).toHaveLength(1);
    expect(agentMessages[0]?.kind).toBe("agent");
    expect(agentMessages[0]?.senderName).toBe("Nova");
    expect(agentMessages[0]?.content).toBe("Here is my take on the plan.");
    expect(result.message?.id).toBe(agentMessages[0]?.id);

    // No artifact edit was proposed.
    expect(result.artifact).toBeUndefined();
  });

  it("applies a proposed artifact edit tagged to the agent", async () => {
    const proposed = "# Plan\n\n1. Ship the MVP\n2. Celebrate";
    const agentService = mockAgentService(() => ({
      ok: true,
      responseText: "I drafted the plan.",
      proposedArtifact: proposed,
    }));

    const { rm, store, workspaceId, ownerId, agentId } =
      await setupAgentRoom(agentService);

    await rm.submitMessage(workspaceId, ownerId, "@Nova draft the plan");
    const result = await rm.triggerAgentResponse(workspaceId, agentId);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe("success");

    // The artifact now holds the proposed content, attributed to the agent.
    expect(rm.artifacts.getContent(workspaceId)).toBe(proposed);
    expect(rm.artifacts.getLastEditor(workspaceId).editorId).toBe(agentId);

    // The broadcastable edit is returned and applies to a synced peer doc.
    expect(result.artifact).toBeDefined();
    expect(result.artifact?.lastEditorId).toBe(agentId);
    const peer = await syncedDoc(store, workspaceId);
    Y.applyUpdate(peer, result.artifact!.yjsUpdate);
    expect(peer.getText(ARTIFACT_TEXT_KEY).toString()).toBe(proposed);

    // The persisted snapshot reflects the applied content.
    expect((await store.loadArtifact(workspaceId))?.content).toBe(proposed);
  });

  it("on failure appends an error message and preserves a concurrent human edit, reverting presence", async () => {
    let rmRef!: RoomManager;
    let ownerIdRef = "";
    let workspaceIdRef = "";
    let storeRef!: InMemoryWorkspaceStore;

    // During generation (lock not held), a human concurrently edits the artifact;
    // then generation fails. The human edit must survive the agent rollback.
    const agentService = mockAgentService(async () => {
      const doc = await syncedDoc(storeRef, workspaceIdRef);
      const text = doc.getText(ARTIFACT_TEXT_KEY);
      text.insert(text.length, " HUMAN");
      await rmRef.applyArtifactUpdate(
        workspaceIdRef,
        Y.encodeStateAsUpdate(doc),
        ownerIdRef,
      );
      return { ok: false, failure: "MODEL_ERROR" };
    });

    const { rm, store, workspaceId, ownerId, agentId } =
      await setupAgentRoom(agentService);
    rmRef = rm;
    ownerIdRef = ownerId;
    workspaceIdRef = workspaceId;
    storeRef = store;

    // Establish base artifact content committed by the human before generation.
    const base = new Y.Doc();
    base.getText(ARTIFACT_TEXT_KEY).insert(0, "BASE");
    await rm.applyArtifactUpdate(
      workspaceId,
      Y.encodeStateAsUpdate(base),
      ownerId,
    );
    expect(rm.artifacts.getContent(workspaceId)).toBe("BASE");

    await rm.submitMessage(workspaceId, ownerId, "@Nova help");
    const result = await rm.triggerAgentResponse(workspaceId, agentId);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe("failure");
    expect(result.failure).toBe("MODEL_ERROR");

    // Exactly one agent-attributed error message was appended.
    const messages = rm.messages.getMessages(workspaceId);
    const agentMessages = messages.filter((m) => m.senderId === agentId);
    expect(agentMessages).toHaveLength(1);
    expect(agentMessages[0]?.kind).toBe("error");
    expect(result.message?.kind).toBe("error");

    // The concurrent human edit is preserved; nothing the agent did survives
    // (it proposed no edit), and the pre-generation content remains.
    const content = rm.artifacts.getContent(workspaceId);
    expect(content).toContain("BASE");
    expect(content).toContain("HUMAN");

    // Presence reverted to active.
    expect(rm.getPresence(workspaceId)?.getPresence(agentId)).toBe("active");
    expect(result.idlePresence.updates[0]?.presenceState).toBe("active");
  });

  it("returns AGENT_NOT_FOUND for a non-agent id and leaves state untouched", async () => {
    const agentService = mockAgentService(() => ({
      ok: true,
      responseText: "should not run",
    }));
    const { rm, workspaceId, ownerId } = await setupAgentRoom(agentService);

    // The owner is a human, not an agent.
    const result = await rm.triggerAgentResponse(workspaceId, ownerId);
    expect(result).toEqual({ ok: false, error: "AGENT_NOT_FOUND" });
  });
});

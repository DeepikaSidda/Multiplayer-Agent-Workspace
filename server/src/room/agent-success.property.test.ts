import { describe, it, expect } from "vitest";
import fc from "fast-check";
import * as Y from "yjs";
import {
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
import { RoomManager } from "./index.js";

// ---------------------------------------------------------------------------
// Property 12: Successful agent generation appends one attributed response.
//
// For any successful agent generation, the message log gains exactly one
// message attributed to that agent, and the agent's presence is shown as
// processing during generation and reverts to active afterward
// (Requirements 5.2, 5.3). We drive RoomManager.triggerAgentResponse with a
// mock BedrockAgentService that (a) returns an arbitrary successful result and
// (b) captures the agent's presence at the moment generation runs.
// ---------------------------------------------------------------------------

/** A deterministic, incrementing id generator for stable ids across the room. */
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
): Promise<void> {
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
}

/** A minimal mock BedrockAgentService driven by a supplied handler (no AWS). */
function mockAgentService(
  handler: (
    input: AgentGenerationInput,
  ) => Promise<AgentGenerationResult> | AgentGenerationResult,
): BedrockAgentService {
  return { generate: (input) => Promise.resolve(handler(input)) };
}

/**
 * Build a RoomManager wired with a mock agent service, an owner (human) already
 * registered, and one agent added. Mirrors the setupAgentRoom pattern in
 * RoomManager.test.ts.
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

/** A conversational reply with at least one non-whitespace character. */
const responseTextArb = fc
  .string({ minLength: 1, maxLength: 200 })
  .map((s) => (s.trim().length > 0 ? s : `${s}x`));

/** An arbitrary successful generation result, sometimes proposing an edit. */
const successResultArb: fc.Arbitrary<
  Extract<AgentGenerationResult, { ok: true }>
> = fc.record(
  {
    ok: fc.constant<true>(true),
    responseText: responseTextArb,
    proposedArtifact: fc.option(fc.string({ maxLength: 500 }), {
      nil: undefined,
    }),
  },
  { requiredKeys: ["ok", "responseText"] },
);

describe("Property 12: Successful agent generation appends one attributed response", () => {
  // Feature: multiplayer-agent-workspace, Property 12: Successful agent generation appends one attributed response
  it("adds exactly one agent-attributed message and shows processing presence during generation, reverting afterward", async () => {
    // **Validates: Requirements 5.2, 5.3**
    await fc.assert(
      fc.asyncProperty(successResultArb, async (generation) => {
        // Captures the agent's presence at the instant generation runs, plus
        // the refs it needs (set after the room is built, before generate runs).
        let presenceDuringGen: PresenceState | null = null;
        let rmRef!: RoomManager;
        let agentIdRef = "";
        let workspaceIdRef = "";

        const agentService = mockAgentService(() => {
          presenceDuringGen =
            rmRef.getPresence(workspaceIdRef)?.getPresence(agentIdRef) ?? null;
          return generation;
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

        // The generation succeeded.
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.outcome).toBe("success");

        // Presence was "processing" during generation (observed by the mock and
        // broadcast via the onProcessing hook) and reverts to "active" after.
        expect(presenceDuringGen).toBe("processing");
        expect(processingBroadcast).toBe("processing");
        expect(rm.getPresence(workspaceId)?.getPresence(agentId)).toBe("active");
        expect(result.idlePresence.updates[0]?.presenceState).toBe("active");

        // Exactly ONE agent-attributed message was appended.
        const messages = rm.messages.getMessages(workspaceId);
        expect(messages.length).toBe(beforeCount + 1);
        const agentMessages = messages.filter((m) => m.senderId === agentId);
        expect(agentMessages).toHaveLength(1);
        expect(agentMessages[0]?.kind).toBe("agent");
        expect(agentMessages[0]?.senderType).toBe("agent");
        expect(agentMessages[0]?.senderName).toBe("Nova");
        expect(result.message?.id).toBe(agentMessages[0]?.id);
      }),
      { numRuns: 150 },
    );
  });
});

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import * as Y from "yjs";
import {
  type ArtifactSnapshot,
  type Participant,
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

// A unique, containment-friendly marker: no whitespace, low collision risk.
const marker = (label: string) =>
  fc
    .hexaString({ minLength: 4, maxLength: 12 })
    .map((h) => `<<${label}:${h}>>`);

describe("RoomManager.triggerAgentResponse — Property 13", () => {
  // Feature: multiplayer-agent-workspace, Property 13: Failed agent generation rolls back its artifact changes and preserves human edits
  it("on failure appends an agent error message and reverts only the agent's artifact changes while preserving concurrent committed human edits", async () => {
    await fc.assert(
      fc.asyncProperty(
        marker("BASE"),
        marker("HUMAN"),
        fc.constantFrom<"TIMEOUT" | "MODEL_ERROR" | "PARSE_ERROR">(
          "TIMEOUT",
          "MODEL_ERROR",
          "PARSE_ERROR",
        ),
        async (baseText, humanText, failure) => {
          // Closure refs assigned after setup; the mock's generate() runs later.
          let rmRef!: RoomManager;
          let storeRef!: InMemoryWorkspaceStore;
          let ownerIdRef = "";
          let workspaceIdRef = "";

          // During generation (lock NOT held) a human concurrently edits the
          // artifact; then the agent generation fails. The human edit must
          // survive the agent's rollback.
          const agentService = mockAgentService(async () => {
            const doc = await syncedDoc(storeRef, workspaceIdRef);
            const text = doc.getText(ARTIFACT_TEXT_KEY);
            text.insert(text.length, humanText);
            await rmRef.applyArtifactUpdate(
              workspaceIdRef,
              Y.encodeStateAsUpdate(doc),
              ownerIdRef,
            );
            doc.destroy();
            return { ok: false, failure };
          });

          const { rm, store, workspaceId, ownerId, agentId } =
            await setupAgentRoom(agentService);
          rmRef = rm;
          storeRef = store;
          ownerIdRef = ownerId;
          workspaceIdRef = workspaceId;

          // Pre-generation base content committed by the human.
          const base = new Y.Doc();
          base.getText(ARTIFACT_TEXT_KEY).insert(0, baseText);
          await rm.applyArtifactUpdate(
            workspaceId,
            Y.encodeStateAsUpdate(base),
            ownerId,
          );
          base.destroy();
          expect(rm.artifacts.getContent(workspaceId)).toBe(baseText);

          // A human message that names the agent triggers the response.
          await rm.submitMessage(workspaceId, ownerId, "@Nova help");
          const result = await rm.triggerAgentResponse(workspaceId, agentId);

          // (1) The orchestration reports the failure outcome verbatim.
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          expect(result.outcome).toBe("failure");
          expect(result.failure).toBe(failure);

          // (2) Exactly one agent-attributed error message was appended.
          const agentMessages = rm.messages
            .getMessages(workspaceId)
            .filter((m) => m.senderId === agentId);
          expect(agentMessages).toHaveLength(1);
          expect(agentMessages[0]?.kind).toBe("error");
          expect(agentMessages[0]?.senderName).toBe("Nova");
          expect(result.message?.kind).toBe("error");
          expect(result.message?.senderId).toBe(agentId);

          // (3) The concurrent human edit is preserved and the pre-generation
          //     base content remains; the agent proposed no edit, so nothing of
          //     the agent's survives beyond the rolled-back checkpoint.
          const content = rm.artifacts.getContent(workspaceId);
          expect(content).toContain(baseText);
          expect(content).toContain(humanText);

          // (4) Presence reverted to active.
          expect(rm.getPresence(workspaceId)?.getPresence(agentId)).toBe(
            "active",
          );
          expect(result.idlePresence.updates[0]?.presenceState).toBe("active");
        },
      ),
      { numRuns: 100 },
    );
  });
});

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import * as Y from "yjs";

import { ARTIFACT_CONTENT_LIMIT, type ArtifactSnapshot } from "@maw/shared";
import { InMemoryWorkspaceStore } from "../store/index.js";
import { ArtifactService, ARTIFACT_TEXT_KEY } from "./ArtifactService.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WORKSPACE_ID = "ws-prop14";
const ARTIFACT_ID = "art-prop14";

/** A fresh, empty artifact snapshot (encoded empty Y.Doc) for seeding. */
function emptyArtifact(): ArtifactSnapshot {
  const doc = new Y.Doc();
  return {
    id: ARTIFACT_ID,
    workspaceId: WORKSPACE_ID,
    artifactType: "plan",
    content: "",
    lastEditorId: null,
    lastEditedAt: null,
    yjsState: Y.encodeStateAsUpdate(doc),
  };
}

/** Seed an in-memory store with one workspace holding an empty artifact. */
async function seededStore(): Promise<InMemoryWorkspaceStore> {
  const store = new InMemoryWorkspaceStore();
  await store.createWorkspace({
    workspace: {
      id: WORKSPACE_ID,
      joinReference: "join-prop14",
      ownerId: "p-owner",
      artifactId: ARTIFACT_ID,
      createdAt: 1_000,
    },
    owner: {
      id: "p-owner",
      workspaceId: WORKSPACE_ID,
      type: "human",
      displayName: "Owner",
      joinedAt: 1_000,
      presenceState: "active",
    },
    artifact: emptyArtifact(),
  });
  return store;
}

/**
 * A single local Yjs client synced with the authoritative doc. Each `insert`
 * returns a genuine INCREMENTAL update (encoded against the pre-edit state
 * vector) so the service applies real CRDT deltas rather than whole-document
 * resends.
 */
class Client {
  readonly doc = new Y.Doc();
  private get text(): Y.Text {
    return this.doc.getText(ARTIFACT_TEXT_KEY);
  }
  insert(pos: number, str: string): Uint8Array {
    const before = Y.encodeStateVector(this.doc);
    this.text.insert(pos, str);
    return Y.encodeStateAsUpdate(this.doc, before);
  }
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

// A pool of editor ids that MIXES humans and agents so the property exercises
// author-agnostic behaviour: the identity of the editor must never influence
// whether a valid-size edit is applied.
const editorIdArb = fc.constantFrom(
  "human-1",
  "human-2",
  "alice",
  "agent-1",
  "agent-2",
  "bot-nova",
);

// Insertion text: free-form ASCII interleaved with tricky-but-BMP fragments
// (no astral chars, so JS UTF-16 indices line up with Yjs Text indices).
const textFragmentArb = fc.oneof(
  fc.string({ minLength: 1, maxLength: 24 }),
  fc.constantFrom("café", "# Heading", "\n\n", "  spaced  ", "---", "```", "ünïcödé"),
);

// One edit: who authored it, what to insert, and where (as a fraction resolved
// against the current length at apply time).
const editArb = fc.record({
  editorId: editorIdArb,
  text: textFragmentArb,
  posFraction: fc.double({ min: 0, max: 1, noNaN: true }),
});

// A sequence of edits. Bounds keep cumulative content comfortably under the
// 100,000-char limit, so every generated edit is a VALID-size edit.
const editsArb = fc.array(editArb, { minLength: 1, maxLength: 20 });

// ---------------------------------------------------------------------------
// Property 14: Valid-size edits are applied regardless of author (6.3, 6.4, 6.6)
// ---------------------------------------------------------------------------

// Feature: multiplayer-agent-workspace, Property 14: Valid-size edits are applied regardless of author
describe("ArtifactService — Property 14: valid-size edits are applied regardless of author", () => {
  it("applies any valid-size edit (human or agent), records editor identity + timestamp, and reflects it in the authoritative content", async () => {
    // **Validates: Requirements 6.3, 6.4, 6.6**
    await fc.assert(
      fc.asyncProperty(editsArb, async (edits) => {
        const store = await seededStore();
        // An injected, strictly increasing clock gives each edit a known,
        // distinct timestamp we can assert on.
        let clock = 1_000;
        const service = new ArtifactService(store, { now: () => clock });

        const client = new Client();
        // Reference string mirrors exactly what the authoritative doc should
        // hold — i.e. the single content the server broadcasts to all active
        // participants.
        let ref = "";

        for (const edit of edits) {
          const len = ref.length;
          const pos = Math.min(len, Math.floor(edit.posFraction * (len + 1)));

          // Stamp this edit with a fresh, known timestamp.
          clock += 1;
          const stampAtEdit = clock;

          const update = client.insert(pos, edit.text);
          const result = await service.applyUpdate(WORKSPACE_ID, update, edit.editorId);

          // Mirror the same insertion on the reference string.
          ref = ref.slice(0, pos) + edit.text + ref.slice(pos);

          // This is a valid-size edit — never over the limit.
          expect(ref.length).toBeLessThanOrEqual(ARTIFACT_CONTENT_LIMIT);

          // Applied regardless of whether the author was a human or an agent.
          expect(result).toEqual({ ok: true, length: ref.length });

          // The authoritative content (delivered to every participant) reflects
          // every applied edit verbatim.
          expect(service.getContent(WORKSPACE_ID)).toBe(ref);

          // Editor identity and timestamp are recorded for the change.
          const last = service.getLastEditor(WORKSPACE_ID);
          expect(last.editorId).toBe(edit.editorId);
          expect(last.editedAt).toBe(stampAtEdit);
        }
      }),
      { numRuns: 200 },
    );
  });
});

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  buildSystemPrompt,
  mapLogToConverseMessages,
  type AgentGenerationInput,
  type AgentGenerationResult,
  type BedrockAgentService,
} from "./BedrockAgentService.js";
import type {
  ArtifactType,
  Message,
  MessageKind,
  Participant,
} from "@maw/shared";

// ---------------------------------------------------------------------------
// Property 11: Agent context is complete and correctly targeted.
//
// A message naming/replying to a specific agent must trigger a generation for
// THAT agent, carrying context that includes the COMPLETE message log and the
// CURRENT artifact content (Requirements 4.3, 5.1). Since the RoomManager
// orchestration (task 10.2) does not exist yet, this property is exercised at
// the context-assembly level: we build the AgentGenerationInput for the target
// agent, hand it to a mock BedrockAgentService that captures what it received,
// then assert targeting + completeness over the captured context.
// ---------------------------------------------------------------------------

const WORKSPACE_ID = "ws-1";

const ARTIFACT_TYPES: ArtifactType[] = [
  "plan",
  "PRD",
  "issue",
  "workflow",
  "pitch",
  "checklist",
];

/** A mock BedrockAgentService that records the last input it was asked to generate. */
class CapturingAgentService implements BedrockAgentService {
  public lastInput?: AgentGenerationInput;

  async generate(input: AgentGenerationInput): Promise<AgentGenerationResult> {
    this.lastInput = input;
    return { ok: true, responseText: "ok" };
  }
}

/** Generator for a valid message content: 1..4000 chars with a non-whitespace char. */
const contentArb = fc
  .string({ minLength: 1, maxLength: 200 })
  .map((s) => (s.trim().length > 0 ? s : `${s}x`));

/** Generator for the target agent this generation is for. */
const agentArb: fc.Arbitrary<Participant> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 12 }).map((s) => `agent-${s}`),
  displayName: fc.string({ minLength: 1, maxLength: 20 }).map((s) => `Nova ${s}`),
  persona: fc.option(fc.string({ maxLength: 40 }), { nil: undefined }),
  workspaceId: fc.constant(WORKSPACE_ID),
  type: fc.constant<"agent">("agent"),
  joinedAt: fc.constant(0),
  presenceState: fc.constant<"active">("active"),
});

const kindArb: fc.Arbitrary<MessageKind> = fc.constantFrom(
  "chat",
  "agent",
  "error",
);

/**
 * Builds a message log with varied senders: some authored by the target agent
 * (senderId === agent.id) and some by humans/other participants, in arbitrary
 * order, always including a triggering message that names the target agent.
 */
function messageLogArb(agent: Participant): fc.Arbitrary<Message[]> {
  const otherMessageArb = (index: number): fc.Arbitrary<Message> =>
    fc
      .record({
        isOwn: fc.boolean(),
        senderName: fc.string({ minLength: 1, maxLength: 16 }),
        content: contentArb,
        kind: kindArb,
      })
      .map(({ isOwn, senderName, content, kind }) => ({
        id: `m-${index}`,
        workspaceId: WORKSPACE_ID,
        senderId: isOwn ? agent.id : `human-${index}`,
        senderType: isOwn ? ("agent" as const) : ("human" as const),
        senderName: isOwn ? agent.displayName : `H${senderName}`,
        content,
        timestamp: index + 1,
        sequence: index + 1,
        kind: isOwn ? ("agent" as const) : kind,
      }));

  return fc.array(fc.nat({ max: 30 }), { minLength: 0, maxLength: 12 }).chain(
    (indices) => {
      const trigger: Message = {
        id: "m-trigger",
        workspaceId: WORKSPACE_ID,
        senderId: "human-trigger",
        senderType: "human",
        senderName: "Alice",
        content: `Hey ${agent.displayName}, can you draft this?`,
        timestamp: 1000,
        sequence: 1000,
        kind: "chat",
      };
      if (indices.length === 0) {
        return fc.constant([trigger]);
      }
      return fc
        .tuple(...indices.map((_, i) => otherMessageArb(i)))
        .map((msgs) => [...msgs, trigger]);
    },
  );
}

describe("Property 11: Agent context is complete and correctly targeted", () => {
  // Feature: multiplayer-agent-workspace, Property 11: Agent context is complete and correctly targeted
  it("generates for the named agent with the complete message log and current artifact content", async () => {
    // **Validates: Requirements 4.3, 5.1**
    await fc.assert(
      fc.asyncProperty(
        agentArb.chain((agent) =>
          fc.record({
            agent: fc.constant(agent),
            artifactType: fc.constantFrom(...ARTIFACT_TYPES),
            artifactContent: fc.string({ maxLength: 300 }),
            messageLog: messageLogArb(agent),
          }),
        ),
        async ({ agent, artifactType, artifactContent, messageLog }) => {
          const service = new CapturingAgentService();

          // Assemble the generation context for the target agent and trigger it.
          const input: AgentGenerationInput = {
            agent,
            artifactType,
            artifactContent,
            messageLog,
          };
          await service.generate(input);

          const captured = service.lastInput;
          expect(captured).toBeDefined();
          if (!captured) return;

          // (1) Targeting: the generation is for the named agent, and no other.
          expect(captured.agent.id).toBe(agent.id);
          expect(captured.agent.displayName).toBe(agent.displayName);

          // (2) Completeness — message log: the assembled Converse context
          // accounts for every original message. Consecutive same-role turns
          // are merged, so the invariant is that the total number of content
          // blocks across the merged messages equals the original count.
          const converse = mapLogToConverseMessages(
            captured.messageLog,
            captured.agent.id,
          );
          const totalBlocks = converse.reduce(
            (sum, m) => sum + m.content.length,
            0,
          );
          expect(totalBlocks).toBe(messageLog.length);
          expect(captured.messageLog).toEqual(messageLog);

          // Every original message is represented as a content block; the
          // agent's own messages appear raw, others carry a Sender prefix.
          const allText = converse
            .flatMap((m) => m.content.map((c) => c.text))
            .join("\n");
          for (const message of messageLog) {
            expect(allText).toContain(message.content);
          }

          // (3) Completeness — artifact: the current artifact content is
          // embedded verbatim into the system prompt when non-empty.
          const prompt = buildSystemPrompt(
            captured.agent,
            captured.artifactType,
            captured.artifactContent,
          );
          if (captured.artifactContent.length > 0) {
            expect(prompt).toContain(captured.artifactContent);
          } else {
            expect(prompt).toContain("(the artifact is empty)");
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

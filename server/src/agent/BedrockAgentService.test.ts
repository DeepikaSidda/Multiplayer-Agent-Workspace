import { describe, it, expect, vi } from "vitest";
import type { ConverseStreamCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import { AGENT_MODEL_ID, type Message, type Participant } from "@maw/shared";
import {
  BedrockAgentServiceImpl,
  buildSystemPrompt,
  mapLogToConverseMessages,
  parseArtifactBlock,
  type ConverseStreamClient,
} from "./BedrockAgentService.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WORKSPACE_ID = "ws-1";

function agent(overrides: Partial<Participant> = {}): Participant {
  return {
    id: "agent-1",
    workspaceId: WORKSPACE_ID,
    type: "agent",
    displayName: "Nova",
    joinedAt: 1_000,
    presenceState: "active",
    modelId: AGENT_MODEL_ID,
    ...overrides,
  };
}

function msg(overrides: Partial<Message>): Message {
  return {
    id: "m",
    workspaceId: WORKSPACE_ID,
    senderId: "human-1",
    senderType: "human",
    senderName: "Alice",
    content: "hello",
    timestamp: 1,
    sequence: 1,
    kind: "chat",
    ...overrides,
  };
}

/**
 * Builds a fake ConverseStream client whose stream yields the given text
 * fragments as `contentBlockDelta` events, plus a couple of non-text events
 * (messageStart/messageStop) that must be ignored.
 */
function fakeClient(
  fragments: string[],
  opts: { captureCommand?: (input: unknown) => void; noStream?: boolean } = {},
): ConverseStreamClient {
  return {
    async send(command): Promise<ConverseStreamCommandOutput> {
      opts.captureCommand?.((command as { input: unknown }).input);

      if (opts.noStream) {
        return {} as ConverseStreamCommandOutput;
      }

      async function* stream() {
        yield { messageStart: { role: "assistant" as const } };
        for (const text of fragments) {
          yield { contentBlockDelta: { delta: { text }, contentBlockIndex: 0 } };
        }
        yield { messageStop: { stopReason: "end_turn" as const } };
      }

      return { stream: stream() } as unknown as ConverseStreamCommandOutput;
    },
  };
}

/** A client whose send() rejects, to exercise the MODEL_ERROR path. */
function throwingClient(error: unknown): ConverseStreamClient {
  return {
    async send(): Promise<ConverseStreamCommandOutput> {
      throw error;
    },
  };
}

/**
 * A client whose stream never yields — it stalls forever, and only settles
 * (rejecting with an AbortError) once the injected abort signal fires. This
 * lets a tiny injected timeout drive the TIMEOUT path deterministically.
 */
function stallingClient(): ConverseStreamClient {
  return {
    async send(_command, options): Promise<ConverseStreamCommandOutput> {
      async function* stream() {
        yield { messageStart: { role: "assistant" as const } };
        // Never yield another event; resolve only when aborted.
        await new Promise<void>((resolve) => {
          const signal = options?.abortSignal;
          if (signal?.aborted) {
            resolve();
            return;
          }
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        // Nothing more is yielded; the generate() race resolves via abort.
      }

      return { stream: stream() } as unknown as ConverseStreamCommandOutput;
    },
  };
}

// ---------------------------------------------------------------------------
// buildSystemPrompt
// ---------------------------------------------------------------------------

describe("buildSystemPrompt", () => {
  it("frames the agent as a named teammate for the artifact type", () => {
    const prompt = buildSystemPrompt(agent(), "PRD", "");
    expect(prompt).toContain("You are Nova");
    expect(prompt).toContain('type "PRD"');
  });

  it("embeds the current artifact content", () => {
    const prompt = buildSystemPrompt(agent(), "plan", "# Roadmap\n- ship it");
    expect(prompt).toContain("# Roadmap\n- ship it");
  });

  it("shows an empty-artifact placeholder when content is empty", () => {
    const prompt = buildSystemPrompt(agent(), "plan", "");
    expect(prompt).toContain("(the artifact is empty)");
  });

  it("includes the persona when present", () => {
    const prompt = buildSystemPrompt(
      agent({ persona: "a terse product manager" }),
      "plan",
      "",
    );
    expect(prompt).toContain("a terse product manager");
  });

  it("instructs the agent to optionally emit a single fenced artifact block", () => {
    const prompt = buildSystemPrompt(agent(), "plan", "");
    expect(prompt).toContain("```artifact");
  });
});

// ---------------------------------------------------------------------------
// mapLogToConverseMessages
// ---------------------------------------------------------------------------

describe("mapLogToConverseMessages", () => {
  it("maps the agent's own messages to assistant and others to user", () => {
    const log: Message[] = [
      msg({ senderId: "human-1", senderName: "Alice", content: "hi Nova" }),
      msg({ senderId: "agent-1", senderName: "Nova", content: "hi Alice", kind: "agent" }),
    ];

    const result = mapLogToConverseMessages(log, "agent-1");

    expect(result).toEqual([
      { role: "user", content: [{ text: "Sender: Alice\nhi Nova" }] },
      { role: "assistant", content: [{ text: "hi Alice" }] },
    ]);
  });

  it("prefixes non-agent content with the sender name and leaves agent content raw", () => {
    const log: Message[] = [
      msg({ senderId: "agent-1", senderName: "Nova", content: "raw agent text" }),
    ];
    const [own] = mapLogToConverseMessages(log, "agent-1");
    expect(own.content[0].text).toBe("raw agent text");

    const [other] = mapLogToConverseMessages(
      [msg({ senderId: "human-9", senderName: "Bob", content: "yo" })],
      "agent-1",
    );
    expect(other.content[0].text).toBe("Sender: Bob\nyo");
  });

  it("merges consecutive same-role messages into one message with joined blocks", () => {
    const log: Message[] = [
      msg({ senderId: "human-1", senderName: "Alice", content: "first" }),
      msg({ senderId: "human-2", senderName: "Bob", content: "second" }),
      msg({ senderId: "agent-1", senderName: "Nova", content: "reply" }),
      msg({ senderId: "human-1", senderName: "Alice", content: "third" }),
    ];

    const result = mapLogToConverseMessages(log, "agent-1");

    expect(result).toEqual([
      {
        role: "user",
        content: [
          { text: "Sender: Alice\nfirst" },
          { text: "Sender: Bob\nsecond" },
        ],
      },
      { role: "assistant", content: [{ text: "reply" }] },
      { role: "user", content: [{ text: "Sender: Alice\nthird" }] },
    ]);
  });

  it("returns an empty array for an empty log", () => {
    expect(mapLogToConverseMessages([], "agent-1")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseArtifactBlock
// ---------------------------------------------------------------------------

describe("parseArtifactBlock", () => {
  it("returns the full text and no artifact when there is no fenced block", () => {
    const result = parseArtifactBlock("just a normal reply");
    expect(result).toEqual({ ok: true, responseText: "just a normal reply" });
  });

  it("extracts the artifact body and the surrounding reply text", () => {
    const text = [
      "Here is my proposal.",
      "```artifact",
      "# Plan",
      "- step one",
      "```",
      "Let me know what you think.",
    ].join("\n");

    const result = parseArtifactBlock(text);

    expect(result).toEqual({
      ok: true,
      responseText: "Here is my proposal.\nLet me know what you think.",
      proposedArtifact: "# Plan\n- step one",
    });
  });

  it("signals PARSE_ERROR for an opening fence with no closing fence", () => {
    const text = "Here you go\n```artifact\n# Plan\n- unterminated";
    expect(parseArtifactBlock(text)).toEqual({ ok: false, failure: "PARSE_ERROR" });
  });

  it("handles an artifact block with no surrounding text", () => {
    const result = parseArtifactBlock("```artifact\ncontent only\n```");
    expect(result).toEqual({
      ok: true,
      responseText: "",
      proposedArtifact: "content only",
    });
  });
});

// ---------------------------------------------------------------------------
// generate (via fake ConverseStream)
// ---------------------------------------------------------------------------

describe("BedrockAgentServiceImpl.generate", () => {
  const input = {
    agent: agent(),
    artifactType: "plan" as const,
    artifactContent: "existing content",
    messageLog: [msg({ content: "Nova, draft a plan" })],
  };

  it("accumulates contentBlockDelta text into responseText", async () => {
    const service = new BedrockAgentServiceImpl(
      fakeClient(["Hello", ", ", "team!"]),
    );

    const result = await service.generate(input);

    expect(result).toEqual({ ok: true, responseText: "Hello, team!" });
  });

  it("parses a fenced artifact block from the streamed text", async () => {
    const service = new BedrockAgentServiceImpl(
      fakeClient(["Proposal:\n", "```artifact\n", "# New Plan\n", "```\n", "done"]),
    );

    const result = await service.generate(input);

    expect(result).toEqual({
      ok: true,
      responseText: "Proposal:\ndone",
      proposedArtifact: "# New Plan",
    });
  });

  it("sends a ConverseStreamCommand for Nova Pro with system, messages, and inferenceConfig", async () => {
    let captured: any;
    const service = new BedrockAgentServiceImpl(
      fakeClient(["ok"], { captureCommand: (i) => (captured = i) }),
    );

    await service.generate(input);

    expect(captured.modelId).toBe(AGENT_MODEL_ID);
    expect(captured.inferenceConfig).toEqual({
      maxTokens: 1024,
      temperature: 0.7,
      topP: 0.9,
    });
    expect(captured.system[0].text).toContain("You are Nova");
    // The triggering human message is mapped to a user turn with a Sender prefix.
    expect(captured.messages[0].role).toBe("user");
    expect(captured.messages[0].content[0].text).toContain("Sender: Alice");
  });

  it("returns MODEL_ERROR when the client throws", async () => {
    const service = new BedrockAgentServiceImpl(throwingClient(new Error("boom")));
    const result = await service.generate(input);
    expect(result).toEqual({ ok: false, failure: "MODEL_ERROR" });
  });

  it("returns MODEL_ERROR when the response has no stream", async () => {
    const service = new BedrockAgentServiceImpl(fakeClient([], { noStream: true }));
    const result = await service.generate(input);
    expect(result).toEqual({ ok: false, failure: "MODEL_ERROR" });
  });

  it("returns PARSE_ERROR when the streamed text has a malformed artifact block", async () => {
    const service = new BedrockAgentServiceImpl(
      fakeClient(["reply\n", "```artifact\n", "# unterminated plan"]),
    );
    const result = await service.generate(input);
    expect(result).toEqual({ ok: false, failure: "PARSE_ERROR" });
  });
});

// ---------------------------------------------------------------------------
// generate — timeout & failure handling (task 9.2, Requirements 5.4/5.5)
// ---------------------------------------------------------------------------

describe("BedrockAgentServiceImpl.generate — timeout & failure handling", () => {
  const input = {
    agent: agent(),
    artifactType: "plan" as const,
    artifactContent: "existing content",
    messageLog: [msg({ content: "Nova, draft a plan" })],
  };

  it("returns TIMEOUT when the stream stalls past the injected deadline", async () => {
    // Tiny per-call timeout + a stream that never yields → deterministic abort.
    const service = new BedrockAgentServiceImpl(stallingClient());

    const start = Date.now();
    const result = await service.generate(input, { timeoutMs: 10 });

    expect(result).toEqual({ ok: false, failure: "TIMEOUT" });
    // Sanity: it resolved via the deadline, not by hanging for the real 60s.
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("honors a constructor-configured timeout for the TIMEOUT path", async () => {
    const service = new BedrockAgentServiceImpl(stallingClient(), undefined, 10);
    const result = await service.generate(input);
    expect(result).toEqual({ ok: false, failure: "TIMEOUT" });
  });

  it("maps an SDK/model error to MODEL_ERROR", async () => {
    const service = new BedrockAgentServiceImpl(
      throwingClient(new Error("bedrock exploded")),
    );
    const result = await service.generate(input, { timeoutMs: 1000 });
    expect(result).toEqual({ ok: false, failure: "MODEL_ERROR" });
  });

  it("maps a malformed artifact block to PARSE_ERROR", async () => {
    const service = new BedrockAgentServiceImpl(
      fakeClient(["intro\n", "```artifact\n", "# never closed"]),
    );
    const result = await service.generate(input, { timeoutMs: 1000 });
    expect(result).toEqual({ ok: false, failure: "PARSE_ERROR" });
  });

  it("clears the timeout timer on the success path", async () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    try {
      const service = new BedrockAgentServiceImpl(fakeClient(["all good"]));
      const result = await service.generate(input, { timeoutMs: 1000 });

      expect(result).toEqual({ ok: true, responseText: "all good" });
      expect(clearSpy).toHaveBeenCalled();
    } finally {
      clearSpy.mockRestore();
    }
  });
});

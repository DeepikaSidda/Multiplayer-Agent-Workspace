/**
 * Bedrock Agent Service — assembles workspace context and invokes Amazon Nova
 * Pro (`amazon.nova-pro-v1:0`) via the Bedrock Runtime ConverseStream API so an
 * Agent_Participant can respond as a teammate (Requirements 4.3, 5.1, 5.2).
 *
 * Responsibilities implemented here (task 9.1):
 * - {@link buildSystemPrompt}: frame Nova Pro as a named teammate collaborating
 *   on an artifact of a given {@link ArtifactType}, embedding the current
 *   artifact content and instructing it to optionally emit a single fenced
 *   ```` ```artifact ... ``` ```` block with the full proposed artifact.
 * - {@link mapLogToConverseMessages}: map the workspace {@link Message} log into
 *   Converse `messages` — the agent's own past messages become `assistant`
 *   turns, everyone else becomes `user` turns prefixed with `Sender: <name>` so
 *   the model can attribute speakers. Consecutive same-role messages are merged
 *   into one Converse message (Converse expects alternating roles).
 * - {@link parseArtifactBlock}: split the accumulated model text into the
 *   conversational `responseText` and an optional `proposedArtifact` extracted
 *   from the fenced artifact block; signal `PARSE_ERROR` for a malformed block.
 * - {@link BedrockAgentServiceImpl.generate}: issue a `ConverseStreamCommand`
 *   with `inferenceConfig`, accumulate `contentBlockDelta` text, then parse the
 *   optional artifact block into `proposedArtifact`.
 *
 * Timeout + failure handling (task 9.2, Requirements 5.4/5.5):
 * - `generate` wraps the stream in a 60s (`AGENT_TIMEOUT_MS`) `AbortController`.
 *   When the deadline elapses the request is aborted and the generation is
 *   terminated and treated as a failed response, returning `TIMEOUT`. The
 *   consume loop is raced against the abort so a stream that stalls mid-flight
 *   (never yields, or yields too slowly) is still terminated deterministically.
 * - SDK/model errors (a rejected `send`, a stream that errors, or a response
 *   with no stream) map to `MODEL_ERROR`; a malformed artifact block maps to
 *   `PARSE_ERROR`. Every path clears the timeout timer and detaches abort
 *   listeners so no timers or listeners leak.
 * - The timeout duration is injectable (constructor default, overridable per
 *   call via {@link GenerateOptions.timeoutMs}) so tests exercise the timeout
 *   deterministically with a tiny deadline instead of a real 60s wait.
 *
 * The Bedrock client is injected via the constructor so tests can supply a fake
 * that returns a fake ConverseStream async-iterable — no live AWS calls.
 */

import {
  ConverseStreamCommand,
  type ConverseStreamCommandOutput,
} from "@aws-sdk/client-bedrock-runtime";
import {
  AGENT_MODEL_ID,
  AGENT_TIMEOUT_MS,
  type ArtifactType,
  type Message,
  type Participant,
} from "@maw/shared";

/**
 * The design's `BedrockAgentService` interface: turn assembled workspace
 * context into a single agent response (plus an optional proposed artifact).
 */
export interface BedrockAgentService {
  generate(input: AgentGenerationInput): Promise<AgentGenerationResult>;
}

/** Context assembled for a single agent generation. */
export interface AgentGenerationInput {
  /** The agent identity + persona this generation is for. */
  agent: Participant;
  /** The artifact type the team is collaborating on. */
  artifactType: ArtifactType;
  /** The current artifact content, embedded verbatim into the system prompt. */
  artifactContent: string;
  /** The complete message log used as conversation context. */
  messageLog: Message[];
}

/**
 * Result of an agent generation.
 * - success: the conversational `responseText` and an optional
 *   `proposedArtifact` (the full artifact content the agent proposes).
 * - failure: a structured reason — `TIMEOUT` (task 9.2), `MODEL_ERROR`
 *   (SDK/model failure), or `PARSE_ERROR` (malformed artifact block).
 */
export type AgentGenerationResult =
  | { ok: true; responseText: string; proposedArtifact?: string }
  | { ok: false; failure: "TIMEOUT" | "MODEL_ERROR" | "PARSE_ERROR" };

/** Converse roles used by the ConverseStream API. */
export type ConverseRole = "user" | "assistant";

/**
 * A minimal Converse message. Structurally compatible with the AWS SDK's
 * `Message` (a `ContentBlock` may carry only a `text` field), so an array of
 * these can be passed straight to `ConverseStreamCommand`.
 */
export interface ConverseMessage {
  role: ConverseRole;
  content: { text: string }[];
}

/**
 * The slice of `BedrockRuntimeClient` this service depends on. Injecting this
 * narrow interface (rather than the concrete client) lets tests pass a fake
 * that returns a fake ConverseStream, and keeps 9.2's timeout wiring simple.
 */
export interface ConverseStreamClient {
  send(
    command: ConverseStreamCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<ConverseStreamCommandOutput>;
}

/** Inference configuration for Nova Pro (see design.md). */
export const AGENT_INFERENCE_CONFIG = {
  maxTokens: 1024,
  temperature: 0.7,
  topP: 0.9,
} as const;

/** Opening/closing fences for the proposed-artifact block. */
const ARTIFACT_FENCE_OPEN = "```artifact";
const FENCE_CLOSE = "```";

/**
 * Builds the system prompt framing Nova Pro as a named teammate collaborating
 * on an artifact of the given type, embedding the current artifact content and
 * instructing it to optionally emit a single fenced artifact block.
 */
export function buildSystemPrompt(
  agent: Participant,
  artifactType: ArtifactType,
  artifactContent: string,
): string {
  const persona = agent.persona?.trim()
    ? `\nYour persona: ${agent.persona.trim()}`
    : "";
  const currentArtifact =
    artifactContent.length > 0 ? artifactContent : "(the artifact is empty)";

  return [
    `You are ${agent.displayName}, an AI teammate collaborating with humans (and possibly other AI teammates) in a shared workspace.`,
    `Together the team is co-authoring a shared artifact of type "${artifactType}".${persona}`,
    "",
    "You can see the full conversation and the current artifact content. Contribute like a real teammate: be concise, build on what others have said, and move the work forward.",
    "",
    "Current artifact content:",
    "<artifact>",
    currentArtifact,
    "</artifact>",
    "",
    "First, write a SHORT chat reply: 1-2 plain sentences for the conversation. Do NOT write label words like 'CHAT REPLY' or 'ARTIFACT'. Do NOT put document content, headings, or lists in this reply.",
    "",
    "Then, ONLY if the user asked you to write or change the shared document, append exactly ONE fenced block containing the COMPLETE updated document. The block MUST start with a line that is exactly ```artifact and end with a line that is exactly ``` — like this:",
    "```artifact",
    "Introduction",
    "This is the full updated document in plain text.",
    "```",
    "Rules for the block: put the ENTIRE document inside it (not a diff), write it in PLAIN TEXT (no #, *, -, backticks, tables, or bold/italic), and do NOT repeat that content in your chat reply.",
    "If the user is only chatting or asking a question (for example 'say hi' or 'what do you think'), reply with just the 1-2 sentences and DO NOT output any ```artifact block.",
    "When you do write the document, include only what the user asked for; don't tack on unrelated earlier sections unless asked to keep them.",
  ].join("\n");
}

/**
 * Maps the workspace message log into Converse messages:
 * - a message authored by `agentId` becomes an `assistant` turn carrying the
 *   raw content;
 * - every other message becomes a `user` turn whose text is prefixed with
 *   `Sender: <name>` so the model can attribute speakers.
 *
 * Consecutive messages that map to the same role are merged into a single
 * Converse message with one content block per original message, satisfying
 * Converse's alternating-role expectation while preserving each utterance.
 */
export function mapLogToConverseMessages(
  messageLog: Message[],
  agentId: string,
): ConverseMessage[] {
  const merged: ConverseMessage[] = [];

  for (const message of messageLog) {
    const isOwn = message.senderId === agentId;
    const role: ConverseRole = isOwn ? "assistant" : "user";
    const text = isOwn
      ? message.content
      : `Sender: ${message.senderName}\n${message.content}`;

    const last = merged[merged.length - 1];
    if (last && last.role === role) {
      last.content.push({ text });
    } else {
      merged.push({ role, content: [{ text }] });
    }
  }

  return merged;
}

/** Result of splitting model output into reply text + optional proposed artifact. */
export type ParseArtifactResult =
  | { ok: true; responseText: string; proposedArtifact?: string }
  | { ok: false; failure: "PARSE_ERROR" };

/**
 * Extracts an optional fenced ```` ```artifact ... ``` ```` block from the
 * accumulated model text.
 *
 * - No opening fence: the whole text is `responseText`, no `proposedArtifact`.
 * - A well-formed block: `proposedArtifact` is the block's inner content and
 *   `responseText` is the surrounding text (with the block removed, trimmed).
 * - An opening fence with no closing fence (malformed): `PARSE_ERROR`.
 */
/**
 * Strip stray section labels the model may echo (e.g. a leading "CHAT REPLY:"
 * or a trailing "ARTIFACT" heading) so the chat reply reads cleanly.
 */
function stripReplyLabels(text: string): string {
  return text
    .replace(/^\s*chat\s*reply\s*[:\-]?\s*/i, "")
    .replace(/\n?\s*artifact\s*:?\s*$/i, "")
    .trim();
}

export function parseArtifactBlock(text: string): ParseArtifactResult {
  const openIndex = text.indexOf(ARTIFACT_FENCE_OPEN);
  if (openIndex === -1) {
    return { ok: true, responseText: stripReplyLabels(text.trim()) };
  }

  // Inner content starts after the opening fence and its trailing newline.
  const afterOpen = openIndex + ARTIFACT_FENCE_OPEN.length;
  const bodyStart = text[afterOpen] === "\n" ? afterOpen + 1 : afterOpen;

  const closeIndex = text.indexOf(FENCE_CLOSE, bodyStart);
  if (closeIndex === -1) {
    // Opening fence but never closed — malformed artifact block.
    return { ok: false, failure: "PARSE_ERROR" };
  }

  // Drop the single newline that precedes the closing fence, if present.
  const bodyEnd =
    closeIndex > bodyStart && text[closeIndex - 1] === "\n"
      ? closeIndex - 1
      : closeIndex;
  const proposedArtifact = text.slice(bodyStart, bodyEnd);

  // Join the text before/after the removed block, trimming each side so the
  // block's removal doesn't leave a doubled blank line between them.
  const before = text.slice(0, openIndex).trim();
  const after = text.slice(closeIndex + FENCE_CLOSE.length).trim();
  const responseText = stripReplyLabels(
    [before, after].filter((s) => s.length > 0).join("\n"),
  );

  return { ok: true, responseText, proposedArtifact };
}

/** Options controlling a single {@link BedrockAgentServiceImpl.generate} call. */
export interface GenerateOptions {
  /**
   * Optional caller-provided abort signal, combined with the internal timeout
   * signal. When either aborts, the generation is terminated and treated as a
   * failed response (`TIMEOUT`).
   */
  abortSignal?: AbortSignal;
  /**
   * Per-call override for the generation timeout in milliseconds. Defaults to
   * the service's configured timeout (constructor value, itself defaulting to
   * {@link AGENT_TIMEOUT_MS}). Primarily a testing seam so the timeout path can
   * be exercised deterministically without a real 60s wait.
   */
  timeoutMs?: number;
}

/**
 * ConverseStream-backed {@link BedrockAgentService}. The Bedrock client is
 * injected so tests can supply a fake returning a fake ConverseStream.
 */
export class BedrockAgentServiceImpl implements BedrockAgentService {
  constructor(
    private readonly client: ConverseStreamClient,
    private readonly modelId: string = AGENT_MODEL_ID,
    private readonly timeoutMs: number = AGENT_TIMEOUT_MS,
  ) {}

  async generate(
    input: AgentGenerationInput,
    options: GenerateOptions = {},
  ): Promise<AgentGenerationResult> {
    const system = [
      {
        text: buildSystemPrompt(
          input.agent,
          input.artifactType,
          input.artifactContent,
        ),
      },
    ];
    const messages = mapLogToConverseMessages(input.messageLog, input.agent.id);

    const command = new ConverseStreamCommand({
      modelId: this.modelId,
      system,
      messages,
      inferenceConfig: { ...AGENT_INFERENCE_CONFIG },
    });

    // Internal deadline: abort the request when the timeout elapses so a slow
    // or stalled generation is terminated and treated as a failed response
    // (Requirement 5.5). Combine it with any caller-provided signal.
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
    const combined = combineSignals([
      options.abortSignal,
      timeoutController.signal,
    ]);

    let accumulated = "";
    try {
      const signal = combined.signal;

      // Consume the stream. Kept as a promise so it can be raced against the
      // abort: a stream that stalls (never yields) still terminates on timeout.
      const consume = async (): Promise<{ noStream: boolean }> => {
        const response = await this.client.send(command, {
          abortSignal: signal,
        });

        const stream = response.stream;
        if (!stream) {
          // A ConverseStream response with no stream is a model-side failure.
          return { noStream: true };
        }

        for await (const event of stream) {
          if (signal.aborted) throw makeAbortError();
          const delta = event.contentBlockDelta?.delta;
          if (delta && typeof delta.text === "string") {
            accumulated += delta.text;
          }
        }
        return { noStream: false };
      };

      // Rejects as soon as the combined signal aborts (timeout or caller).
      const abortPromise = new Promise<never>((_, reject) => {
        if (signal.aborted) {
          reject(makeAbortError());
          return;
        }
        signal.addEventListener("abort", () => reject(makeAbortError()), {
          once: true,
        });
      });

      const consumePromise = consume();
      // Swallow a late rejection if the abort wins the race, so the still
      // in-flight consume never surfaces as an unhandled rejection.
      consumePromise.catch(() => {});

      const outcome = await Promise.race([consumePromise, abortPromise]);
      if (outcome.noStream) {
        return { ok: false, failure: "MODEL_ERROR" };
      }
    } catch (error) {
      // An abort (timeout deadline or caller) terminates the generation and is
      // treated as a failed response; everything else is an SDK/model error.
      if (isAbortError(error, signalsOf(options.abortSignal, timeoutController))) {
        return { ok: false, failure: "TIMEOUT" };
      }
      return { ok: false, failure: "MODEL_ERROR" };
    } finally {
      clearTimeout(timer);
      combined.cleanup();
    }

    const parsed = parseArtifactBlock(accumulated);
    if (!parsed.ok) {
      return { ok: false, failure: "PARSE_ERROR" };
    }

    return parsed.proposedArtifact !== undefined
      ? {
          ok: true,
          responseText: parsed.responseText,
          proposedArtifact: parsed.proposedArtifact,
        }
      : { ok: true, responseText: parsed.responseText };
  }
}

/**
 * Combines several optional {@link AbortSignal}s into one: the returned signal
 * aborts as soon as any source aborts. `cleanup` detaches the listeners so no
 * references leak once the operation settles.
 */
function combineSignals(
  sources: (AbortSignal | undefined)[],
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const present = sources.filter((s): s is AbortSignal => s !== undefined);
  const onAbort = () => controller.abort();

  for (const source of present) {
    if (source.aborted) {
      controller.abort();
      break;
    }
    source.addEventListener("abort", onAbort, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      for (const source of present) {
        source.removeEventListener("abort", onAbort);
      }
    },
  };
}

/** Collects the signals that indicate this generation was aborted. */
function signalsOf(
  callerSignal: AbortSignal | undefined,
  timeoutController: AbortController,
): (AbortSignal | undefined)[] {
  return [callerSignal, timeoutController.signal];
}

/** Builds an `AbortError`-shaped error, matching the SDK's abort behavior. */
function makeAbortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

/** True when an error looks like an abort (either a signal aborted or AbortError). */
function isAbortError(
  error: unknown,
  signals: (AbortSignal | undefined)[],
): boolean {
  if (signals.some((s) => s?.aborted)) return true;
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

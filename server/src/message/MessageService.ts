/**
 * The Message Service — validation, stamping, ordered logging, and
 * persist-before-broadcast for the workspace Message_Log.
 *
 * Responsibilities (Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 8.1, 8.2):
 *  - Validate message content: reject empty, whitespace-only, and over-length
 *    content with a specific reason before any state changes (3.2).
 *  - Stamp valid messages with a millisecond `timestamp` and a monotonic
 *    per-workspace `sequence` tiebreaker (3.1, 3.4).
 *  - Persist the stamped message durably BEFORE adding it to in-memory state
 *    ("persist-before-broadcast"): only a successfully persisted message is
 *    committed to the log and returned for broadcast (8.1).
 *  - On a persistence failure, reject the append, exclude the message from the
 *    log, and leave committed state (including the sequence counter) untouched
 *    so nothing is broadcast (8.2).
 *
 * The service owns the authoritative in-memory tail of the log per workspace
 * and the per-workspace sequence counter. It resolves sender identity through
 * an injected {@link SenderResolver} so it does not need to own the participant
 * roster (that belongs to the Room Manager). The clock and id generator are
 * injectable for deterministic tests.
 */

import { randomUUID } from "node:crypto";
import {
  MESSAGE_MAX_LENGTH,
  type Message,
  type MessageKind,
  type MessageRejectionReason,
  type ParticipantType,
} from "@maw/shared";
import type { WorkspaceStore } from "../store/index.js";
import { orderMessages } from "./ordering.js";

/**
 * Why a submitted message was rejected. Extends the shared validation reasons
 * ({@link MessageRejectionReason}) with `SAVE_FAILED`, returned when durable
 * persistence of an otherwise-valid message fails (Requirement 8.2).
 */
export type MessageRejection = MessageRejectionReason | "SAVE_FAILED";

/** Identity of a message sender, resolved from the workspace roster. */
export interface SenderInfo {
  senderType: ParticipantType;
  senderName: string;
  /**
   * Optional explicit message classification. Defaults to `"agent"` for agent
   * senders and `"chat"` for human senders.
   */
  kind?: MessageKind;
}

/**
 * Resolves a sender id to its identity within a workspace. The caller (Room
 * Manager) guarantees the sender is a current participant before submitting.
 */
export type SenderResolver = (
  workspaceId: string,
  senderId: string,
) => SenderInfo;

/** Result of {@link MessageService.submit}. */
export type SubmitResult =
  | { ok: true; message: Message }
  | { ok: false; reason: MessageRejection };

/** Injectable collaborators for deterministic testing. */
export interface MessageServiceOptions {
  /** Millisecond clock; defaults to `Date.now`. */
  now?: () => number;
  /** Message id generator; defaults to `crypto.randomUUID`. */
  generateId?: () => string;
}

/** Per-call options for {@link MessageService.submit}. */
export interface SubmitOptions {
  /**
   * Explicit message classification, overriding the sender-derived default.
   * Used by the agent orchestration flow to append an agent-attributed `error`
   * message on a failed/timed-out generation (Requirement 5.4).
   */
  kind?: MessageKind;
}

/**
 * Validate message content against the length/non-whitespace rules.
 *
 * Returns a rejection reason, or `null` when the content is valid. Content is
 * valid when it has at least one non-whitespace character and its length is at
 * most {@link MESSAGE_MAX_LENGTH}. When multiple conditions apply, the reason
 * is chosen in this order: `EMPTY` (length 0), then `TOO_LONG` (over the
 * limit), then `WHITESPACE_ONLY` (has characters but none non-whitespace).
 */
export function validateMessageContent(
  content: string,
): MessageRejectionReason | null {
  if (content.length === 0) {
    return "EMPTY";
  }
  if (content.length > MESSAGE_MAX_LENGTH) {
    return "TOO_LONG";
  }
  if (content.trim().length === 0) {
    return "WHITESPACE_ONLY";
  }
  return null;
}

export class MessageService {
  private readonly now: () => number;
  private readonly generateId: () => string;

  /** Committed, persisted message tail per workspace (append order). */
  private readonly logs = new Map<string, Message[]>();
  /** Next `sequence` to assign per workspace (monotonic, gapless). */
  private readonly nextSequence = new Map<string, number>();

  constructor(
    private readonly store: WorkspaceStore,
    private readonly resolveSender: SenderResolver,
    options: MessageServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.generateId = options.generateId ?? randomUUID;
  }

  /**
   * Validate, stamp, persist, and commit a message.
   *
   * On invalid content, returns a rejection without touching any state. On
   * valid content, stamps `timestamp` + `sequence`, persists durably, and only
   * then commits to the in-memory log and returns the stamped message. If
   * persistence throws, the message is excluded from the log, the sequence
   * counter is not advanced, and a `SAVE_FAILED` rejection is returned.
   */
  async submit(
    workspaceId: string,
    senderId: string,
    content: string,
    options: SubmitOptions = {},
  ): Promise<SubmitResult> {
    const invalid = validateMessageContent(content);
    if (invalid !== null) {
      return { ok: false, reason: invalid };
    }

    const sender = this.resolveSender(workspaceId, senderId);
    // Reserve — but do not yet commit — the next sequence value. It is only
    // advanced after a successful persist so a failed append leaves committed
    // state (and thus the counter) untouched (Requirement 8.2).
    const sequence = this.nextSequence.get(workspaceId) ?? 0;

    const message: Message = {
      id: this.generateId(),
      workspaceId,
      senderId,
      senderType: sender.senderType,
      senderName: sender.senderName,
      content,
      timestamp: this.now(),
      sequence,
      kind:
        options.kind ??
        sender.kind ??
        (sender.senderType === "agent" ? "agent" : "chat"),
    };

    // Persist BEFORE adding to in-memory state (persist-before-broadcast).
    try {
      await this.store.appendMessage(message);
    } catch {
      return { ok: false, reason: "SAVE_FAILED" };
    }

    // Commit: advance the sequence counter and append to the in-memory log.
    this.nextSequence.set(workspaceId, sequence + 1);
    const log = this.logs.get(workspaceId);
    if (log === undefined) {
      this.logs.set(workspaceId, [message]);
    } else {
      log.push(message);
    }

    return { ok: true, message };
  }

  /**
   * Seed the in-memory log and the per-workspace sequence counter from durably
   * persisted messages when a room is (re)loaded — e.g. after a server restart.
   *
   * The sequence counter is authoritative for the `MSG#<sequence>` storage key,
   * so it MUST continue past the highest persisted sequence; otherwise new
   * messages would reuse existing sequence values and overwrite prior messages.
   * The counter is never lowered.
   */
  hydrate(workspaceId: string, messages: Message[]): void {
    const maxSequence = messages.reduce(
      (max, m) => (m.sequence > max ? m.sequence : max),
      -1,
    );
    const current = this.nextSequence.get(workspaceId) ?? 0;
    this.nextSequence.set(workspaceId, Math.max(current, maxSequence + 1));
    if (!this.logs.has(workspaceId)) {
      this.logs.set(workspaceId, [...orderMessages(messages)]);
    }
  }

  /**
   * The committed message log for a workspace, ordered by ascending
   * `(timestamp, sequence)` (Requirement 3.4). Returns a defensive copy.
   */
  getMessages(workspaceId: string): Message[] {
    return orderMessages(this.logs.get(workspaceId) ?? []);
  }
}

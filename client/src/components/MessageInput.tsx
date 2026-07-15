/**
 * MessageInput — the message composer with client-side validation feedback.
 *
 * Requirements:
 *  - 3.1/3.2: mirror the server's content rule on the client so the user gets
 *    immediate feedback. Content must contain at least one non-whitespace
 *    character and be at most `MESSAGE_MAX_LENGTH` characters. Empty or
 *    whitespace-only content disables the send action with a hint; over-length
 *    content shows an error and blocks sending. Valid content is sent via
 *    `connection.sendMessage`.
 *  - 8.2: the server may still reject an accepted message (e.g. persistence
 *    failure) after client validation passes. Such server-side rejections are
 *    surfaced through `rejection` and cleared on the next successful send.
 *
 * Client-side validation is feedback only; the server remains the authority.
 */

import { useState } from "react";
import { MESSAGE_MAX_LENGTH, type MessageRejectionReason } from "@maw/shared";
import type { WorkspaceConnection } from "../WorkspaceConnection.js";

export interface MessageInputProps {
  connection: WorkspaceConnection;
  /** A server-side rejection to surface to the sender, if any. */
  rejection?: MessageRejectionReason | null;
  /** Invoked when the composer sends, so callers can clear stale rejections. */
  onClearRejection?: () => void;
  /**
   * Optional controlled value. When provided (with {@link onValueChange}) the
   * composer is controlled by the parent, letting sibling controls — such as an
   * agent "mention" affordance — inject text (e.g. `@Nova `) into the draft
   * (Requirement 5.1). When omitted the composer manages its own state.
   */
  value?: string;
  /** Change handler for the controlled value. Required for controlled mode. */
  onValueChange?: (value: string) => void;
}

/** Human-readable copy for a server-side rejection reason. */
function rejectionMessage(reason: MessageRejectionReason): string {
  switch (reason) {
    case "EMPTY":
      return "Message was empty and not sent.";
    case "WHITESPACE_ONLY":
      return "Message contained only whitespace and was not sent.";
    case "TOO_LONG":
      return `Message exceeded ${MESSAGE_MAX_LENGTH} characters and was not sent.`;
    default:
      return "Message was not accepted.";
  }
}

export function MessageInput({
  connection,
  rejection,
  onClearRejection,
  value: controlledValue,
  onValueChange,
}: MessageInputProps) {
  const [internalValue, setInternalValue] = useState("");
  const isControlled = controlledValue !== undefined;
  const value = isControlled ? controlledValue : internalValue;
  const setValue = (next: string) => {
    if (isControlled) onValueChange?.(next);
    else setInternalValue(next);
  };

  const trimmedLength = value.trim().length;
  const isEmpty = trimmedLength === 0;
  const isTooLong = value.length > MESSAGE_MAX_LENGTH;
  const canSend = !isEmpty && !isTooLong;

  // Local, immediate validation feedback (distinct from a server rejection).
  const validationHint = isTooLong
    ? `Message is ${value.length}/${MESSAGE_MAX_LENGTH} characters — too long to send.`
    : isEmpty
      ? "Enter a message to send."
      : null;

  const handleSubmit = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    if (!canSend) return;
    connection.sendMessage(value);
    setValue("");
    onClearRejection?.();
  };

  return (
    <form className="message-input" onSubmit={handleSubmit} aria-label="Send a message">
      <textarea
        className="message-input-field"
        aria-label="Message"
        data-testid="message-input"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        rows={2}
      />
      <div className="message-input-footer">
        <span
          className={`message-input-counter${isTooLong ? " message-input-counter-over" : ""}`}
          data-testid="message-counter"
        >
          {value.length}/{MESSAGE_MAX_LENGTH}
        </span>
        <button type="submit" disabled={!canSend} data-testid="message-send">
          Send
        </button>
      </div>
      {validationHint && (
        <p className="message-input-hint" role="note" data-testid="message-validation">
          {validationHint}
        </p>
      )}
      {rejection && (
        <p className="message-input-error" role="alert" data-testid="message-rejection">
          {rejectionMessage(rejection)}
        </p>
      )}
    </form>
  );
}

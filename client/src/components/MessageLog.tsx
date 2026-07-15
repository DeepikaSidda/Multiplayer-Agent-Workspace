/**
 * MessageLog — the ordered, attributed chat transcript.
 *
 * Requirements:
 *  - 3.4: display messages ordered by ascending `timestamp`, breaking ties by
 *    ascending `sequence` (a total order). The server already delivers them in
 *    this order, but the component sorts defensively so display order is
 *    correct regardless of arrival order.
 *  - 3.5: show the sender identity for every message.
 *  - 3.6: render Agent_Participant messages with a visual treatment distinct
 *    from Human_Participant messages. Agent-authored entries (agent responses
 *    and agent error notices) get a distinct `data-author`, CSS class, and a
 *    role badge.
 */

import type { Message } from "@maw/shared";

export interface MessageLogProps {
  messages: Message[];
}

/** Total order over the log: ascending timestamp, then ascending sequence. */
function byTimestampThenSequence(a: Message, b: Message): number {
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
  return a.sequence - b.sequence;
}

/** An entry is agent-authored when its sender is an agent or it is agent output. */
function isAgentAuthored(message: Message): boolean {
  return (
    message.senderType === "agent" ||
    message.kind === "agent" ||
    message.kind === "error"
  );
}

export function MessageLog({ messages }: MessageLogProps) {
  const ordered = [...messages].sort(byTimestampThenSequence);

  return (
    <ol className="message-log" aria-label="Message log">
      {ordered.map((message) => {
        const agentAuthored = isAgentAuthored(message);
        const author = agentAuthored ? "agent" : "human";
        const isError = message.kind === "error";
        return (
          <li
            key={message.id}
            className={`message message-${author}${isError ? " message-error" : ""}`}
            data-author={author}
            data-sender-type={message.senderType}
            data-message-kind={message.kind}
          >
            <span className="message-sender">
              {message.senderName}
              {agentAuthored && (
                <span className="message-badge" aria-label="AI agent">
                  {isError ? "⚠ agent" : "🤖 agent"}
                </span>
              )}
            </span>
            <span className="message-content">{message.content}</span>
          </li>
        );
      })}
    </ol>
  );
}

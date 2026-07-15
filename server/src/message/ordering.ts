/**
 * Total ordering for the workspace Message_Log.
 *
 * Messages are totally ordered by ascending `timestamp` (millisecond
 * precision), with ties broken by ascending append `sequence` — the monotonic
 * per-workspace counter. This is the single source of truth for how the log is
 * presented to participants (Requirement 3.4) and how it is restored on rejoin
 * (Requirement 8.5).
 */

import type { Message } from "@maw/shared";

/**
 * Comparator for two messages implementing ascending `(timestamp, sequence)`
 * order. Suitable for `Array.prototype.sort`.
 */
export function compareMessages(a: Message, b: Message): number {
  if (a.timestamp !== b.timestamp) {
    return a.timestamp - b.timestamp;
  }
  return a.sequence - b.sequence;
}

/**
 * Return a new array of messages ordered by ascending `(timestamp, sequence)`.
 *
 * The input array is not mutated; a shallow copy is sorted and returned so
 * callers can safely pass shared state.
 */
export function orderMessages(messages: readonly Message[]): Message[] {
  return [...messages].sort(compareMessages);
}

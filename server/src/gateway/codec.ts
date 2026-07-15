/**
 * Wire codec helpers for the WebSocket gateway.
 *
 * The event contract transmits binary CRDT data (Yjs updates / encoded state)
 * as base64 strings so the `{ type, workspaceId, payload }` envelopes stay
 * JSON-serializable ({@link ArtifactUpdatePayload.yjsUpdate},
 * {@link ArtifactState.yjsState}). These helpers are the single place that
 * converts between the on-the-wire `Base64` strings and the `Uint8Array` bytes
 * the {@link ArtifactService} operates on.
 */

/** Encode raw bytes as a base64 string for the wire. */
export function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/**
 * Decode a base64 string from the wire back into bytes.
 *
 * `Buffer.from(_, "base64")` is lenient and never throws, so callers that must
 * reject malformed input should first validate with {@link isBase64}.
 */
export function base64ToBytes(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, "base64"));
}

/**
 * True when `value` is a syntactically valid base64 string (standard alphabet,
 * correct padding). The empty string is valid (it decodes to zero bytes).
 * Used to reject malformed `artifactUpdate` payloads before decoding.
 */
export function isBase64(value: string): boolean {
  if (value.length === 0) return true;
  if (value.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/]*={0,2}$/.test(value);
}

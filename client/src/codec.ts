/**
 * Browser-friendly wire codec helpers for the client transport.
 *
 * The WebSocket event contract transmits binary CRDT data (Yjs updates /
 * encoded `Y.Doc` state) as base64 strings so the `{ type, workspaceId,
 * payload }` envelopes stay JSON-serializable ({@link ArtifactUpdatePayload.yjsUpdate},
 * {@link ArtifactState.yjsState}). These helpers mirror the server gateway's
 * `codec.ts` semantics (standard base64 alphabet, lenient decode) but use the
 * browser-native `btoa`/`atob` (also available in Node) instead of `Buffer`, so
 * encoded Yjs bytes round-trip byte-for-byte between client and server.
 */

/** Encode raw bytes as a standard-alphabet base64 string for the wire. */
export function bytesToBase64(bytes: Uint8Array): string {
  // Build a binary string one char per byte, then base64-encode it. Chunking
  // keeps the intermediate string cheap and avoids call-stack limits from
  // spreading a large array into String.fromCharCode.
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

/**
 * Decode a base64 string from the wire back into bytes.
 *
 * `atob` is lenient about some inputs, so callers that must reject malformed
 * input should first validate with {@link isBase64}.
 */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * True when `value` is a syntactically valid base64 string (standard alphabet,
 * correct padding). The empty string is valid (it decodes to zero bytes). This
 * matches the server gateway's `isBase64` so both ends agree on what a
 * well-formed `yjsUpdate` looks like.
 */
export function isBase64(value: string): boolean {
  if (value.length === 0) return true;
  if (value.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/]*={0,2}$/.test(value);
}

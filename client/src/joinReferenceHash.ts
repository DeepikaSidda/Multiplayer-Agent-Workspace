/**
 * Parse a workspace join reference from a URL hash.
 *
 * The fragment marker is not part of the reference. Percent-encoded hashes are
 * decoded before surrounding whitespace is removed. Invalid encoding and
 * hashes that normalize to an empty string are intentionally ignored.
 */
export function parseJoinReferenceHash(hash: string): string | null {
  const encodedReference = hash.startsWith("#") ? hash.slice(1) : hash;

  let decodedReference: string;
  try {
    decodedReference = decodeURIComponent(encodedReference);
  } catch {
    return null;
  }

  const normalizedReference = decodedReference.trim();
  return normalizedReference.length > 0 ? normalizedReference : null;
}

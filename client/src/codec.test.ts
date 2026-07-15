/**
 * Tests for the client wire codec (task 13.1).
 *
 * Correct byte-for-byte base64 round-tripping is the foundation of Yjs sync:
 * encoded CRDT updates must survive the client<->server wire unchanged. The
 * property test asserts the round-trip over arbitrary byte arrays; the example
 * tests pin the base64 alphabet and validity checks that must agree with the
 * server gateway's `codec.ts`.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { base64ToBytes, bytesToBase64, isBase64 } from "./codec.js";

describe("codec", () => {
  it("round-trips arbitrary bytes through base64", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 4096 }), (bytes) => {
        const decoded = base64ToBytes(bytesToBase64(bytes));
        expect(Array.from(decoded)).toEqual(Array.from(bytes));
      }),
      { numRuns: 200 },
    );
  });

  it("encodes empty input to an empty string and back", () => {
    expect(bytesToBase64(new Uint8Array())).toBe("");
    expect(base64ToBytes("")).toEqual(new Uint8Array());
  });

  it("accepts well-formed base64 and rejects malformed input", () => {
    expect(isBase64("")).toBe(true);
    expect(isBase64(bytesToBase64(new Uint8Array([1, 2, 3])))).toBe(true);
    expect(isBase64("abc")).toBe(false); // length not a multiple of 4
    expect(isBase64("****")).toBe(false); // invalid alphabet
  });
});

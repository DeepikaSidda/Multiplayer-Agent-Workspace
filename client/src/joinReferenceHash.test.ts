import { describe, expect, it } from "vitest";
import { parseJoinReferenceHash } from "./joinReferenceHash.js";

describe("parseJoinReferenceHash", () => {
  it("parses a plain join reference", () => {
    expect(parseJoinReferenceHash("#workspace-123")).toBe("workspace-123");
  });

  it("decodes a percent-encoded join reference", () => {
    expect(parseJoinReferenceHash("#team%2Falpha%20room")).toBe("team/alpha room");
  });

  it("trims whitespace after decoding", () => {
    expect(parseJoinReferenceHash("#%20%20shared-ref%09%20")).toBe("shared-ref");
  });

  it.each(["", "#", "#%20%09%20"])(
    "treats empty hash %j as no invite reference",
    (hash) => {
      expect(parseJoinReferenceHash(hash)).toBeNull();
    },
  );

  it.each(["#%", "#%2", "#%E0%A4%A"])(
    "treats malformed hash %j as no invite reference",
    (hash) => {
      expect(parseJoinReferenceHash(hash)).toBeNull();
    },
  );
});
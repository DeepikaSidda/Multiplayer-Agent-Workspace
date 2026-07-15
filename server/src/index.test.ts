import { describe, it, expect } from "vitest";
import { serverVersion } from "./index.js";

describe("server scaffold", () => {
  it("exposes a version string", () => {
    expect(serverVersion()).toBe("0.1.0");
  });
});

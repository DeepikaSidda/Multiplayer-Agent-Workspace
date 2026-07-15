import { describe, it, expect } from "vitest";
import {
  MESSAGE_MIN_LENGTH,
  MESSAGE_MAX_LENGTH,
  ARTIFACT_CONTENT_LIMIT,
  MAX_AGENTS_PER_WORKSPACE,
  AGENT_TIMEOUT_MS,
  DEFAULT_ARTIFACT_TYPE,
  VALID_ARTIFACT_TYPES,
  isArtifactType,
  type ArtifactType,
  type ClientToServerEvent,
  type ServerToClientEvent,
} from "@maw/shared";

describe("shared domain constants", () => {
  it("defines message length bounds of 1..4000", () => {
    expect(MESSAGE_MIN_LENGTH).toBe(1);
    expect(MESSAGE_MAX_LENGTH).toBe(4000);
  });

  it("defines the artifact content limit and agent capacity", () => {
    expect(ARTIFACT_CONTENT_LIMIT).toBe(100000);
    expect(MAX_AGENTS_PER_WORKSPACE).toBe(5);
  });

  it("defines a 60s agent timeout", () => {
    expect(AGENT_TIMEOUT_MS).toBe(60000);
  });

  it("defaults the artifact type to plan", () => {
    expect(DEFAULT_ARTIFACT_TYPE).toBe("plan");
  });

  it("enumerates exactly the six valid artifact types", () => {
    const expected: ArtifactType[] = [
      "plan",
      "PRD",
      "issue",
      "workflow",
      "pitch",
      "checklist",
    ];
    expect(VALID_ARTIFACT_TYPES.size).toBe(expected.length);
    for (const t of expected) {
      expect(VALID_ARTIFACT_TYPES.has(t)).toBe(true);
    }
  });
});

describe("isArtifactType guard", () => {
  it("accepts valid artifact types", () => {
    expect(isArtifactType("PRD")).toBe(true);
    expect(isArtifactType("plan")).toBe(true);
  });

  it("rejects invalid or non-string values", () => {
    expect(isArtifactType("spec")).toBe(false);
    expect(isArtifactType("")).toBe(false);
    expect(isArtifactType(undefined)).toBe(false);
    expect(isArtifactType(42)).toBe(false);
  });
});

describe("WebSocket event envelope", () => {
  it("types a client -> server event with { type, workspaceId, payload }", () => {
    const evt: ClientToServerEvent = {
      type: "sendMessage",
      workspaceId: "ws-1",
      payload: { content: "hello" },
    };
    expect(evt.type).toBe("sendMessage");
    expect(evt.workspaceId).toBe("ws-1");
    expect(evt.payload.content).toBe("hello");
  });

  it("types a server -> client event with { type, workspaceId, payload }", () => {
    const evt: ServerToClientEvent = {
      type: "error",
      workspaceId: "ws-1",
      payload: { code: "WORKSPACE_NOT_FOUND", message: "not found" },
    };
    expect(evt.type).toBe("error");
    expect(evt.payload.code).toBe("WORKSPACE_NOT_FOUND");
  });
});

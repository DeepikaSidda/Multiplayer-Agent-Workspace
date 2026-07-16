import { describe, it, expect } from "vitest";
import { MESSAGE_MAX_LENGTH, type Message } from "@maw/shared";
import {
  InMemoryWorkspaceStore,
  FailureInjectingWorkspaceStore,
  type WorkspaceCreation,
} from "../store/index.js";
import {
  MessageService,
  validateMessageContent,
  type SenderInfo,
  type SenderResolver,
} from "./index.js";
import { compareMessages, orderMessages } from "./ordering.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WS = "ws-1";

function makeCreation(): WorkspaceCreation {
  return {
    workspace: {
      id: WS,
      joinReference: "join-abc",
      ownerId: "p-owner",
      artifactId: "art-1",
      createdAt: 1_000,
    },
    owner: {
      id: "p-owner",
      workspaceId: WS,
      type: "human",
      displayName: "Owner",
      joinedAt: 1_000,
      presenceState: "active",
    },
    artifact: {
      id: "art-1",
      workspaceId: WS,
      artifactType: "plan",
      content: "",
      lastEditorId: null,
      lastEditedAt: null,
      yjsState: new Uint8Array(),
    },
  };
}

const humanSender: SenderResolver = () => ({
  senderType: "human",
  senderName: "Owner",
});

/** A clock that returns preset values in sequence, then repeats the last. */
function fakeClock(values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)]!;
}

/** A deterministic, monotonically-increasing id generator. */
function seqIds(): () => string {
  let n = 0;
  return () => `m-${n++}`;
}

async function makeService(
  resolver: SenderResolver = humanSender,
  clock?: () => number,
) {
  const store = new InMemoryWorkspaceStore();
  await store.createWorkspace(makeCreation());
  const service = new MessageService(store, resolver, {
    now: clock ?? fakeClock([100]),
    generateId: seqIds(),
  });
  return { store, service };
}

function makeMessage(over: Partial<Message> = {}): Message {
  return {
    id: "m-x",
    workspaceId: WS,
    senderId: "p-owner",
    senderType: "human",
    senderName: "Owner",
    content: "hi",
    timestamp: 100,
    sequence: 0,
    kind: "chat",
    ...over,
  };
}

// ---------------------------------------------------------------------------
// validateMessageContent
// ---------------------------------------------------------------------------

describe("validateMessageContent", () => {
  it("accepts content with at least one non-whitespace char within the limit", () => {
    expect(validateMessageContent("hello")).toBeNull();
    expect(validateMessageContent("  a  ")).toBeNull();
    expect(validateMessageContent("x")).toBeNull();
    expect(validateMessageContent("a".repeat(MESSAGE_MAX_LENGTH))).toBeNull();
  });

  it("rejects empty content as EMPTY", () => {
    expect(validateMessageContent("")).toBe("EMPTY");
  });

  it("rejects whitespace-only content as WHITESPACE_ONLY", () => {
    expect(validateMessageContent("   ")).toBe("WHITESPACE_ONLY");
    expect(validateMessageContent("\t\n ")).toBe("WHITESPACE_ONLY");
  });

  it("rejects content over the max length as TOO_LONG", () => {
    expect(validateMessageContent("a".repeat(MESSAGE_MAX_LENGTH + 1))).toBe(
      "TOO_LONG",
    );
  });

  it("prefers TOO_LONG over WHITESPACE_ONLY for over-length whitespace", () => {
    expect(validateMessageContent(" ".repeat(MESSAGE_MAX_LENGTH + 1))).toBe(
      "TOO_LONG",
    );
  });
});

// ---------------------------------------------------------------------------
// submit — validation rejections
// ---------------------------------------------------------------------------

describe("MessageService.submit validation", () => {
  it("rejects empty content and does not append or advance sequence", async () => {
    const { store, service } = await makeService();
    const result = await service.submit(WS, "p-owner", "");
    expect(result).toEqual({ ok: false, reason: "EMPTY" });
    expect(await store.loadMessages(WS)).toEqual([]);
    expect(service.getMessages(WS)).toEqual([]);
  });

  it("rejects whitespace-only content", async () => {
    const { store, service } = await makeService();
    const result = await service.submit(WS, "p-owner", "   \t");
    expect(result).toEqual({ ok: false, reason: "WHITESPACE_ONLY" });
    expect(await store.loadMessages(WS)).toEqual([]);
  });

  it("rejects over-length content", async () => {
    const { store, service } = await makeService();
    const result = await service.submit(
      WS,
      "p-owner",
      "a".repeat(MESSAGE_MAX_LENGTH + 1),
    );
    expect(result).toEqual({ ok: false, reason: "TOO_LONG" });
    expect(await store.loadMessages(WS)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// submit — stamping and persistence
// ---------------------------------------------------------------------------

describe("MessageService.submit stamping", () => {
  it("stamps a millisecond timestamp and sender identity on a valid message", async () => {
    const { store, service } = await makeService(humanSender, fakeClock([1_234]));
    const result = await service.submit(WS, "p-owner", "hello team");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.message.content).toBe("hello team");
    expect(result.message.timestamp).toBe(1_234);
    expect(result.message.sequence).toBe(0);
    expect(result.message.senderId).toBe("p-owner");
    expect(result.message.senderType).toBe("human");
    expect(result.message.senderName).toBe("Owner");
    expect(result.message.kind).toBe("chat");

    // Persisted durably before being returned.
    expect(await store.loadMessages(WS)).toEqual([result.message]);
  });

  it("classifies agent senders with kind 'agent'", async () => {
    const agentSender: SenderResolver = () => ({
      senderType: "agent",
      senderName: "Nova",
    });
    const { service } = await makeService(agentSender);
    const result = await service.submit(WS, "a-1", "on it");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message.senderType).toBe("agent");
    expect(result.message.kind).toBe("agent");
  });

  it("honors an explicit kind from the resolver", async () => {
    const errorSender: SenderResolver = (): SenderInfo => ({
      senderType: "agent",
      senderName: "Nova",
      kind: "error",
    });
    const { service } = await makeService(errorSender);
    const result = await service.submit(WS, "a-1", "generation failed");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message.kind).toBe("error");
  });

  it("assigns monotonic, gapless per-workspace sequence numbers", async () => {
    const { service } = await makeService(humanSender, fakeClock([10, 10, 10]));
    const r0 = await service.submit(WS, "p-owner", "one");
    const r1 = await service.submit(WS, "p-owner", "two");
    const r2 = await service.submit(WS, "p-owner", "three");
    expect(r0.ok && r0.message.sequence).toBe(0);
    expect(r1.ok && r1.message.sequence).toBe(1);
    expect(r2.ok && r2.message.sequence).toBe(2);
  });

  it("maintains an independent sequence counter per workspace", async () => {
    const store = new InMemoryWorkspaceStore();
    await store.createWorkspace(makeCreation());
    await store.createWorkspace({
      ...makeCreation(),
      workspace: {
        id: "ws-2",
        joinReference: "join-2",
        ownerId: "p-owner",
        artifactId: "art-2",
        createdAt: 1_000,
      },
      artifact: {
        id: "art-2",
        workspaceId: "ws-2",
        artifactType: "plan",
        content: "",
        lastEditorId: null,
        lastEditedAt: null,
        yjsState: new Uint8Array(),
      },
    });
    const service = new MessageService(store, humanSender, {
      now: fakeClock([1]),
      generateId: seqIds(),
    });

    const a = await service.submit(WS, "p-owner", "ws1-first");
    const b = await service.submit("ws-2", "p-owner", "ws2-first");
    expect(a.ok && a.message.sequence).toBe(0);
    expect(b.ok && b.message.sequence).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// submit — persistence failure (persist-before-broadcast, transactional)
// ---------------------------------------------------------------------------

describe("MessageService.submit persistence failure", () => {
  it("returns SAVE_FAILED and excludes the message from the log", async () => {
    const inner = new InMemoryWorkspaceStore();
    await inner.createWorkspace(makeCreation());
    const store = new FailureInjectingWorkspaceStore(inner);
    const service = new MessageService(store, humanSender, {
      now: fakeClock([100]),
      generateId: seqIds(),
    });

    store.failOn("appendMessage");
    const result = await service.submit(WS, "p-owner", "should not persist");
    expect(result).toEqual({ ok: false, reason: "SAVE_FAILED" });

    // Nothing persisted and nothing in the in-memory log.
    expect(await inner.loadMessages(WS)).toEqual([]);
    expect(service.getMessages(WS)).toEqual([]);
  });

  it("does not advance the sequence counter on a persistence failure", async () => {
    const inner = new InMemoryWorkspaceStore();
    await inner.createWorkspace(makeCreation());
    const store = new FailureInjectingWorkspaceStore(inner);
    const service = new MessageService(store, humanSender, {
      now: fakeClock([100]),
      generateId: seqIds(),
    });

    // First append fails once.
    store.failOnce("appendMessage", 1);
    const failed = await service.submit(WS, "p-owner", "fails");
    expect(failed).toEqual({ ok: false, reason: "SAVE_FAILED" });

    // The next successful append reuses sequence 0 (no gap, not incremented).
    const ok = await service.submit(WS, "p-owner", "succeeds");
    expect(ok.ok && ok.message.sequence).toBe(0);
    expect((await inner.loadMessages(WS)).map((m) => m.content)).toEqual([
      "succeeds",
    ]);
  });
});

// ---------------------------------------------------------------------------
// getMessages / ordering helper
// ---------------------------------------------------------------------------

describe("message ordering", () => {
  it("compareMessages orders by ascending (timestamp, sequence)", () => {
    expect(
      compareMessages(
        makeMessage({ timestamp: 100, sequence: 1 }),
        makeMessage({ timestamp: 100, sequence: 2 }),
      ),
    ).toBeLessThan(0);
    expect(
      compareMessages(
        makeMessage({ timestamp: 200, sequence: 0 }),
        makeMessage({ timestamp: 100, sequence: 9 }),
      ),
    ).toBeGreaterThan(0);
    expect(
      compareMessages(
        makeMessage({ timestamp: 100, sequence: 5 }),
        makeMessage({ timestamp: 100, sequence: 5 }),
      ),
    ).toBe(0);
  });

  it("orderMessages sorts by (timestamp, sequence) without mutating input", () => {
    const input = [
      makeMessage({ id: "b", timestamp: 100, sequence: 2 }),
      makeMessage({ id: "a", timestamp: 100, sequence: 1 }),
      makeMessage({ id: "c", timestamp: 50, sequence: 9 }),
    ];
    const sorted = orderMessages(input);
    expect(sorted.map((m) => m.id)).toEqual(["c", "a", "b"]);
    // Input order preserved.
    expect(input.map((m) => m.id)).toEqual(["b", "a", "c"]);
  });

  it("getMessages returns the committed log in (timestamp, sequence) order", async () => {
    // Timestamps decrease across appends so ordering must rely on the sort,
    // not append order.
    const { service } = await makeService(humanSender, fakeClock([300, 200, 100]));
    await service.submit(WS, "p-owner", "third-by-time");
    await service.submit(WS, "p-owner", "second-by-time");
    await service.submit(WS, "p-owner", "first-by-time");

    expect(service.getMessages(WS).map((m) => m.content)).toEqual([
      "first-by-time",
      "second-by-time",
      "third-by-time",
    ]);
  });
});

// ---------------------------------------------------------------------------
// hydrate — restore the sequence counter after a restart
// ---------------------------------------------------------------------------

describe("MessageService.hydrate", () => {
  it("continues past the highest persisted sequence so it never overwrites history", async () => {
    // New message gets a later timestamp so it also orders last.
    const { service } = await makeService(humanSender, fakeClock([200]));

    // Simulate a restart: seed from three persisted messages (sequences 0..2).
    const persisted: Message[] = [
      makeMessage({ id: "m-a", sequence: 0, timestamp: 100 }),
      makeMessage({ id: "m-b", sequence: 1, timestamp: 101 }),
      makeMessage({ id: "m-c", sequence: 2, timestamp: 102 }),
    ];
    service.hydrate(WS, persisted);

    // The next submitted message must get sequence 3, not 0.
    const result = await service.submit(WS, "p-owner", "next line");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message.sequence).toBe(3);
    }

    // The restored log plus the new message are all present and ordered.
    const log = service.getMessages(WS);
    expect(log.map((m) => m.sequence)).toEqual([0, 1, 2, 3]);
  });

  it("never lowers an already-advanced counter", async () => {
    const { service } = await makeService();
    await service.submit(WS, "p-owner", "first"); // sequence 0 -> next is 1
    // Hydrating with an empty/older set must not reset the counter.
    service.hydrate(WS, []);
    const result = await service.submit(WS, "p-owner", "second");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.message.sequence).toBe(1);
  });
});

/**
 * Unit tests for {@link WorkspaceConnection} (task 13.1).
 *
 * The transport is exercised with an injected fake socket + fake factory, so
 * these tests run with no real network or browser. They cover: sending `join`
 * on open (Requirement 1.4), rendering a `workspaceSnapshot` (Requirements 1.7,
 * 8.5), applying/emitting artifact CRDT updates without echo loops
 * (Requirement 6.3), dispatching server events to subscribers, and reconnect
 * (re-open + re-join).
 */

import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import type {
  ArtifactState,
  Message,
  Participant,
  ServerToClientEvent,
  Workspace,
} from "@maw/shared";
import {
  WorkspaceConnection,
  type ClientSocket,
  type SocketFactory,
} from "./WorkspaceConnection.js";
import { bytesToBase64 } from "./codec.js";

/** In-memory {@link ClientSocket} that captures sends and drives inbound events. */
class FakeSocket implements ClientSocket {
  readonly sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((error?: unknown) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  // --- test drivers -------------------------------------------------------
  open(): void {
    this.onopen?.();
  }

  deliver(event: ServerToClientEvent): void {
    this.onmessage?.({ data: JSON.stringify(event) });
  }

  triggerClose(): void {
    this.onclose?.();
  }

  parsed(): Array<{ type: string; workspaceId: string; payload: Record<string, unknown> }> {
    return this.sent.map((s) => JSON.parse(s));
  }

  ofType(type: string): Array<{ type: string; workspaceId: string; payload: Record<string, unknown> }> {
    return this.parsed().filter((e) => e.type === type);
  }
}

/** A factory that records every socket it creates. */
function recordingFactory(): { factory: SocketFactory; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = [];
  const factory: SocketFactory = () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  };
  return { factory, sockets };
}

/** Encode a Yjs doc whose "content" text equals `content` as a base64 update. */
function encodeArtifactState(content: string): string {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, content);
  const state = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return bytesToBase64(state);
}

/** Encode an incremental update inserting `content` into a fresh doc. */
function encodeUpdate(content: string): string {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, content);
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return bytesToBase64(update);
}

const WORKSPACE: Workspace = {
  id: "ws-1",
  joinReference: "ref-1",
  ownerId: "owner-1",
  artifactId: "artifact-1",
  createdAt: 1000,
};

function makeSnapshot(overrides?: {
  content?: string;
  messages?: Message[];
  participants?: Participant[];
}): Extract<ServerToClientEvent, { type: "workspaceSnapshot" }> {
  const content = overrides?.content ?? "";
  const artifact: ArtifactState = {
    id: "artifact-1",
    workspaceId: "ws-1",
    artifactType: "plan",
    content,
    lastEditorId: null,
    lastEditedAt: null,
    yjsState: encodeArtifactState(content),
  };
  return {
    type: "workspaceSnapshot",
    workspaceId: "ws-1",
    payload: {
      workspace: WORKSPACE,
      participants: overrides?.participants ?? [],
      artifact,
      messages: overrides?.messages ?? [],
    },
  };
}

function makeConnection(factory: SocketFactory) {
  return new WorkspaceConnection({
    url: "ws://test",
    joinReference: "ref-1",
    displayName: "Ada",
    socketFactory: factory,
    reconnect: false,
  });
}

function message(id: string, seq: number): Message {
  return {
    id,
    workspaceId: "ws-1",
    senderId: "owner-1",
    senderType: "human",
    senderName: "Ada",
    content: `msg-${id}`,
    timestamp: 1000 + seq,
    sequence: seq,
    kind: "chat",
  };
}

describe("WorkspaceConnection", () => {
  it("sends a join envelope on socket open", () => {
    const { factory, sockets } = recordingFactory();
    const conn = makeConnection(factory);

    conn.connect();
    expect(conn.state).toBe("connecting");

    sockets[0].open();
    expect(conn.state).toBe("open");

    const joins = sockets[0].ofType("join");
    expect(joins).toHaveLength(1);
    expect(joins[0].payload).toEqual({ joinReference: "ref-1", displayName: "Ada" });
  });

  it("renders a workspaceSnapshot: artifact content, messages, and roster", () => {
    const { factory, sockets } = recordingFactory();
    const conn = makeConnection(factory);
    conn.connect();
    sockets[0].open();

    const messages = [message("a", 1), message("b", 2)];
    const participants: Participant[] = [
      {
        id: "owner-1",
        workspaceId: "ws-1",
        type: "human",
        displayName: "Ada",
        joinedAt: 1000,
        presenceState: "active",
      },
    ];

    let notified = false;
    conn.on("workspaceSnapshot", () => {
      notified = true;
    });

    sockets[0].deliver(makeSnapshot({ content: "seed content", messages, participants }));

    expect(notified).toBe(true);
    expect(conn.getContent()).toBe("seed content");
    expect(conn.getMessages()).toHaveLength(2);
    expect(conn.getMessages().map((m) => m.id)).toEqual(["a", "b"]);
    expect(conn.getParticipants()).toHaveLength(1);
    expect(conn.getWorkspace()?.id).toBe("ws-1");
    expect(conn.getArtifactMeta()?.artifactType).toBe("plan");
  });

  it("applies a remote artifactUpdate to the local Y.Doc (base64 round-trip)", () => {
    const { factory, sockets } = recordingFactory();
    const conn = makeConnection(factory);
    conn.connect();
    sockets[0].open();
    sockets[0].deliver(makeSnapshot({ content: "" }));

    sockets[0].deliver({
      type: "artifactUpdate",
      workspaceId: "ws-1",
      payload: {
        yjsUpdate: encodeUpdate("remote text"),
        lastEditorId: "someone-else",
        lastEditedAt: 2000,
      },
    });

    expect(conn.getContent()).toBe("remote text");
  });

  it("emits a client artifactUpdate when the local Y.Text is edited locally", () => {
    const { factory, sockets } = recordingFactory();
    const conn = makeConnection(factory);
    conn.connect();
    sockets[0].open();
    sockets[0].deliver(makeSnapshot({ content: "" }));

    conn.getText().insert(0, "hello");

    const updates = sockets[0].ofType("artifactUpdate");
    expect(updates).toHaveLength(1);
    expect(updates[0].workspaceId).toBe("ws-1");

    // The emitted update applies onto a fresh doc to reproduce the local edit.
    const other = new Y.Doc();
    const bytes = Uint8Array.from(atob(updates[0].payload.yjsUpdate as string), (c) =>
      c.charCodeAt(0),
    );
    Y.applyUpdate(other, bytes);
    expect(other.getText("content").toString()).toBe("hello");
    other.destroy();
  });

  it("does NOT echo a client artifactUpdate when applying a remote update", () => {
    const { factory, sockets } = recordingFactory();
    const conn = makeConnection(factory);
    conn.connect();
    sockets[0].open();
    sockets[0].deliver(makeSnapshot({ content: "" }));

    const before = sockets[0].ofType("artifactUpdate").length;
    sockets[0].deliver({
      type: "artifactUpdate",
      workspaceId: "ws-1",
      payload: {
        yjsUpdate: encodeUpdate("from server"),
        lastEditorId: "peer",
        lastEditedAt: 3000,
      },
    });
    const after = sockets[0].ofType("artifactUpdate").length;

    expect(conn.getContent()).toBe("from server");
    expect(after).toBe(before); // No outbound update was produced.
  });

  it("dispatches messageAppended and presenceUpdate to subscribers", () => {
    const { factory, sockets } = recordingFactory();
    const conn = makeConnection(factory);
    conn.connect();
    sockets[0].open();
    sockets[0].deliver(
      makeSnapshot({
        participants: [
          {
            id: "p-1",
            workspaceId: "ws-1",
            type: "human",
            displayName: "Grace",
            joinedAt: 1000,
            presenceState: "active",
          },
        ],
      }),
    );

    const appended: Message[] = [];
    conn.on("messageAppended", (payload) => appended.push(payload.message));

    let presenceState: string | null = null;
    conn.on("presenceUpdate", (payload) => {
      presenceState = payload.presenceState;
    });

    sockets[0].deliver({
      type: "messageAppended",
      workspaceId: "ws-1",
      payload: { message: message("c", 3) },
    });
    sockets[0].deliver({
      type: "presenceUpdate",
      workspaceId: "ws-1",
      payload: { participantId: "p-1", presenceState: "disconnected", participantType: "human" },
    });

    expect(appended.map((m) => m.id)).toEqual(["c"]);
    expect(conn.getMessages().map((m) => m.id)).toEqual(["c"]);
    expect(presenceState).toBe("disconnected");
    expect(conn.getParticipants()[0].presenceState).toBe("disconnected");
  });

  it("reconnects on unexpected close by re-opening and re-joining", () => {
    const { factory, sockets } = recordingFactory();
    let scheduled: (() => void) | null = null;
    const conn = new WorkspaceConnection({
      url: "ws://test",
      joinReference: "ref-1",
      displayName: "Ada",
      socketFactory: factory,
      reconnect: true,
      setTimeoutFn: (handler) => {
        scheduled = handler;
      },
    });

    conn.connect();
    sockets[0].open();
    // Learn the workspace id from a snapshot so the rejoin envelope carries it.
    sockets[0].deliver(makeSnapshot({ content: "" }));

    sockets[0].triggerClose();
    expect(conn.state).toBe("reconnecting");
    expect(scheduled).not.toBeNull();

    // Fire the scheduled reconnect: a fresh socket is created and joined.
    scheduled!();
    expect(sockets).toHaveLength(2);

    sockets[1].open();
    const rejoins = sockets[1].ofType("join");
    expect(rejoins).toHaveLength(1);
    expect(rejoins[0].payload).toEqual({ joinReference: "ref-1", displayName: "Ada" });
    expect(conn.state).toBe("open");
  });

  it("does not reconnect after an intentional close", () => {
    const { factory, sockets } = recordingFactory();
    let scheduled: (() => void) | null = null;
    const conn = new WorkspaceConnection({
      url: "ws://test",
      joinReference: "ref-1",
      displayName: "Ada",
      socketFactory: factory,
      reconnect: true,
      setTimeoutFn: (handler) => {
        scheduled = handler;
      },
    });

    conn.connect();
    sockets[0].open();
    conn.close();

    expect(conn.state).toBe("closed");
    expect(sockets[0].ofType("leave")).toHaveLength(1);

    sockets[0].triggerClose();
    expect(scheduled).toBeNull();
    expect(conn.state).toBe("closed");
  });
});

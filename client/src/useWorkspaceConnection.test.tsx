/**
 * Integration tests for {@link useWorkspaceConnection} + {@link WorkspaceView}
 * (task 13.2).
 *
 * Drives a real {@link WorkspaceConnection} through an injected fake socket and
 * asserts the rendered UI reacts to server events: the snapshot populates
 * presence/messages/artifact, `messageAppended` extends the log (Requirement
 * 3.3), `participantCountUpdate` updates the count (Requirement 2.5), and
 * `presenceUpdate` refreshes the roster (Requirement 2.1).
 */

import { describe, it, expect } from "vitest";
import { render, screen, act } from "@testing-library/react";
import type {
  ArtifactState,
  Message,
  Participant,
  ServerToClientEvent,
  Workspace,
} from "@maw/shared";
import * as Y from "yjs";
import {
  WorkspaceConnection,
  type ClientSocket,
  type SocketFactory,
} from "./WorkspaceConnection.js";
import { bytesToBase64 } from "./codec.js";
import { WorkspaceView } from "./components/WorkspaceView.js";

class FakeSocket implements ClientSocket {
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((error?: unknown) => void) | null = null;
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {}
  open(): void {
    this.onopen?.();
  }
  deliver(event: ServerToClientEvent): void {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
}

const WORKSPACE: Workspace = {
  id: "ws-1",
  joinReference: "ref-1",
  ownerId: "owner-1",
  artifactId: "artifact-1",
  createdAt: 1000,
};

function encodeState(content: string): string {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, content);
  const state = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return bytesToBase64(state);
}

function snapshot(participants: Participant[], messages: Message[]): ServerToClientEvent {
  const artifact: ArtifactState = {
    id: "artifact-1",
    workspaceId: "ws-1",
    artifactType: "plan",
    content: "",
    lastEditorId: null,
    lastEditedAt: null,
    yjsState: encodeState(""),
  };
  return {
    type: "workspaceSnapshot",
    workspaceId: "ws-1",
    payload: { workspace: WORKSPACE, participants, artifact, messages, history: [] },
  };
}

function human(id: string, name: string): Participant {
  return {
    id,
    workspaceId: "ws-1",
    type: "human",
    displayName: name,
    joinedAt: 1000,
    presenceState: "active",
  };
}

function message(id: string, seq: number, name = "Ada"): Message {
  return {
    id,
    workspaceId: "ws-1",
    senderId: "owner-1",
    senderType: "human",
    senderName: name,
    content: `msg-${id}`,
    timestamp: 1000 + seq,
    sequence: seq,
    kind: "chat",
  };
}

function setup(displayName = "Ada"): { connection: WorkspaceConnection; socket: FakeSocket } {
  let socket: FakeSocket | null = null;
  const factory: SocketFactory = () => {
    socket = new FakeSocket();
    return socket;
  };
  const connection = new WorkspaceConnection({
    url: "ws://test",
    joinReference: "ref-1",
    displayName,
    socketFactory: factory,
    reconnect: false,
  });
  return { connection, socket: (() => {
    connection.connect();
    socket!.open();
    return socket!;
  })() };
}

describe("useWorkspaceConnection + WorkspaceView", () => {
  it("displays the invitee's submitted name after a successful snapshot", () => {
    const submittedName = "Ada Lovelace";
    const { connection, socket } = setup(submittedName);
    render(<WorkspaceView connection={connection} />);

    const join = JSON.parse(socket.sent[0]) as { payload: { displayName: string } };
    expect(join.payload.displayName).toBe(submittedName);

    act(() => {
      socket.deliver(snapshot([human("invitee-1", submittedName)], []));
    });

    expect(screen.getByLabelText(`${submittedName} (human)`)).toBeTruthy();
  });

  it("renders the snapshot: presence, count, and messages", () => {
    const { connection, socket } = setup();
    render(<WorkspaceView connection={connection} />);

    act(() => {
      socket.deliver(
        snapshot([human("owner-1", "Ada"), human("p-2", "Grace")], [message("a", 1)]),
      );
    });

    // Scope presence assertions to the roster labels (the names also appear as
    // message senders elsewhere in the view).
    expect(screen.getByLabelText(/Ada \(human\)/)).toBeTruthy();
    expect(screen.getByLabelText(/Grace \(human\)/)).toBeTruthy();
    expect(screen.getByTestId("active-count").textContent).toContain("2");
    expect(screen.getByText("msg-a")).toBeTruthy();
  });

  it("appends a new message on messageAppended", () => {
    const { connection, socket } = setup();
    render(<WorkspaceView connection={connection} />);

    act(() => {
      socket.deliver(snapshot([human("owner-1", "Ada")], [message("a", 1)]));
    });
    act(() => {
      socket.deliver({
        type: "messageAppended",
        workspaceId: "ws-1",
        payload: { message: message("b", 2) },
      });
    });

    expect(screen.getByText("msg-a")).toBeTruthy();
    expect(screen.getByText("msg-b")).toBeTruthy();
  });

  it("updates the active count on participantCountUpdate", () => {
    const { connection, socket } = setup();
    render(<WorkspaceView connection={connection} />);

    act(() => {
      socket.deliver(snapshot([human("owner-1", "Ada")], []));
    });
    act(() => {
      socket.deliver({
        type: "participantCountUpdate",
        workspaceId: "ws-1",
        payload: { activeCount: 4 },
      });
    });

    expect(screen.getByTestId("active-count").textContent).toContain("4");
  });

  it("reflects a presence change in the roster", () => {
    const { connection, socket } = setup();
    render(<WorkspaceView connection={connection} />);

    act(() => {
      socket.deliver(
        snapshot([human("owner-1", "Ada"), human("p-2", "Grace")], []),
      );
    });
    // Grace disconnects -> dropped from the active presence list.
    act(() => {
      socket.deliver({
        type: "presenceUpdate",
        workspaceId: "ws-1",
        payload: {
          participantId: "p-2",
          presenceState: "disconnected",
          participantType: "human",
        },
      });
    });

    expect(screen.queryByText("Grace")).toBeNull();
    expect(screen.getByText("Ada")).toBeTruthy();
    expect(screen.getByTestId("active-count").textContent).toContain("1");
  });
});

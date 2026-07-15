import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerToClientEvent } from "@maw/shared";
import {
  BrowserJoinController,
  type WorkspaceConnectionFactory,
} from "./BrowserJoinController.js";
import {
  WorkspaceConnection,
  type ClientSocket,
  type WorkspaceConnectionOptions,
} from "./WorkspaceConnection.js";

class FakeSocket implements ClientSocket {
  readonly sent: string[] = [];
  closeCalls = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((error?: unknown) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls += 1;
    this.onclose?.();
  }

  open(): void {
    this.onopen?.();
  }

  deliver(event: ServerToClientEvent): void {
    this.onmessage?.({ data: JSON.stringify(event) });
  }

  joins(): Array<{ payload: Record<string, unknown> }> {
    return this.sent
      .map((frame) => JSON.parse(frame) as { type: string; payload: Record<string, unknown> })
      .filter((event) => event.type === "join");
  }
}

interface Harness {
  socket: FakeSocket;
  scheduledReconnect: ReturnType<typeof vi.fn>;
  connections: WorkspaceConnection[];
  connectionFactory: WorkspaceConnectionFactory;
}

function makeHarness(): Harness {
  const socket = new FakeSocket();
  const scheduledReconnect = vi.fn();
  const connections: WorkspaceConnection[] = [];
  const connectionFactory = (options: WorkspaceConnectionOptions) => {
    const connection = new WorkspaceConnection({
      ...options,
      socketFactory: () => socket,
      reconnect: true,
      setTimeoutFn: scheduledReconnect,
    });
    connections.push(connection);
    return connection;
  };
  return { socket, scheduledReconnect, connections, connectionFactory };
}

function renderInvite(harness: Harness) {
  return render(
    <BrowserJoinController
      initialInviteReference="missing-ref"
      serverHttp="http://test"
      serverWs="ws://test"
      connectionFactory={harness.connectionFactory}
    />,
  );
}

function beginInviteJoin(harness: Harness, displayName = "Ada Lovelace") {
  fireEvent.change(screen.getByLabelText("Your display name"), {
    target: { value: displayName },
  });
  fireEvent.click(screen.getByRole("button", { name: "Join shared workspace" }));
  act(() => harness.socket.open());
}

function deliverNotFound(harness: Harness) {
  act(() => {
    harness.socket.deliver({
      type: "error",
      workspaceId: "",
      payload: {
        code: "WORKSPACE_NOT_FOUND",
        message: "Workspace not found",
      },
    });
  });
}

function successfulSnapshot(displayName: string): ServerToClientEvent {
  return {
    type: "workspaceSnapshot",
    workspaceId: "ws-1",
    payload: {
      workspace: {
        id: "ws-1",
        joinReference: "missing-ref",
        ownerId: "participant-1",
        artifactId: "artifact-1",
        createdAt: 1000,
      },
      participants: [
        {
          id: "participant-1",
          workspaceId: "ws-1",
          type: "human",
          displayName,
          joinedAt: 1001,
          presenceState: "active",
        },
      ],
      artifact: {
        id: "artifact-1",
        workspaceId: "ws-1",
        artifactType: "plan",
        content: "",
        lastEditorId: null,
        lastEditedAt: null,
        yjsState: "",
      },
      messages: [],
    },
  };
}

beforeEach(() => {
  window.history.replaceState(null, "", "/invite?source=test#missing-ref");
});

describe("BrowserJoinController invite recovery", () => {
  it("treats WORKSPACE_NOT_FOUND as terminal and returns to the invite gate", () => {
    const harness = makeHarness();
    renderInvite(harness);
    beginInviteJoin(harness);

    const connection = harness.connections[0];
    const close = vi.spyOn(connection, "close");
    const destroy = vi.spyOn(connection, "destroy");
    deliverNotFound(harness);

    expect(close).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(harness.socket.closeCalls).toBe(1);
    expect(harness.scheduledReconnect).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "You’ve been invited" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Join shared workspace" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toMatch(
      /workspace was not found.*invalid or expired/i,
    );
  });

  it("back exits invite mode, removes the bad hash, and restores manual controls", () => {
    const harness = makeHarness();
    renderInvite(harness);
    beginInviteJoin(harness);
    deliverNotFound(harness);

    fireEvent.click(screen.getByRole("button", { name: "Back to create or join" }));

    expect(window.location.hash).toBe("");
    expect(window.location.pathname).toBe("/invite");
    expect(window.location.search).toBe("?source=test");
    expect(screen.getByLabelText("Join reference")).toBeTruthy();
    expect(screen.getByLabelText("Artifact type")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create workspace" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Join workspace" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Join shared workspace" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("enters on snapshot and displays the exact submitted participant name", () => {
    const harness = makeHarness();
    const submittedName = "Ada Lovelace";
    renderInvite(harness);
    beginInviteJoin(harness, submittedName);

    expect(harness.socket.joins()).toHaveLength(1);
    expect(harness.socket.joins()[0].payload).toEqual({
      joinReference: "missing-ref",
      displayName: submittedName,
    });

    act(() => harness.socket.deliver(successfulSnapshot(submittedName)));

    expect(screen.queryByRole("heading", { name: "You’ve been invited" })).toBeNull();
    expect(
      screen.getByRole("listitem", { name: `${submittedName} (human)` }),
    ).toBeTruthy();
    expect(screen.getByText(submittedName).textContent).toBe(submittedName);
    expect(screen.getByTestId("active-count").textContent).toContain("1 participant active");
    expect(harness.scheduledReconnect).not.toHaveBeenCalled();
  });
});

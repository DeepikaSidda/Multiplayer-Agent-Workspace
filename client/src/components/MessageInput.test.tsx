/**
 * Tests for {@link MessageInput} (task 13.2).
 *
 * Covers client-side validation feedback (Requirements 3.1/3.2): empty and
 * whitespace-only content block sending, over-length content shows an error and
 * blocks sending, valid content calls `sendMessage`, and a server-side
 * rejection (Requirement 8.2) is surfaced to the sender.
 *
 * The composer drives a real {@link WorkspaceConnection} wired to an injected
 * fake socket, so a genuine `sendMessage` envelope is observed on the wire.
 */

import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MESSAGE_MAX_LENGTH } from "@maw/shared";
import { MessageInput } from "./MessageInput.js";
import {
  WorkspaceConnection,
  type ClientSocket,
  type SocketFactory,
} from "../WorkspaceConnection.js";

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
  sendMessages(): Array<{ type: string; payload: Record<string, unknown> }> {
    return this.sent
      .map((s) => JSON.parse(s))
      .filter((e) => e.type === "sendMessage");
  }
}

function makeOpenConnection(): { connection: WorkspaceConnection; socket: FakeSocket } {
  let socket: FakeSocket | null = null;
  const factory: SocketFactory = () => {
    socket = new FakeSocket();
    return socket;
  };
  const connection = new WorkspaceConnection({
    url: "ws://test",
    joinReference: "ref-1",
    displayName: "Ada",
    socketFactory: factory,
    reconnect: false,
  });
  connection.connect();
  socket!.open();
  return { connection, socket: socket! };
}

describe("MessageInput", () => {
  it("blocks sending empty content and shows a hint", () => {
    const { connection, socket } = makeOpenConnection();
    render(<MessageInput connection={connection} />);

    const send = screen.getByTestId("message-send") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(screen.getByTestId("message-validation").textContent).toContain(
      "Enter a message",
    );

    fireEvent.submit(send.closest("form")!);
    expect(socket.sendMessages()).toHaveLength(0);
  });

  it("blocks sending whitespace-only content", () => {
    const { connection, socket } = makeOpenConnection();
    render(<MessageInput connection={connection} />);

    fireEvent.change(screen.getByTestId("message-input"), {
      target: { value: "   \n\t  " },
    });

    const send = screen.getByTestId("message-send") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.submit(send.closest("form")!);
    expect(socket.sendMessages()).toHaveLength(0);
  });

  it("flags over-length content and blocks sending", () => {
    const { connection, socket } = makeOpenConnection();
    render(<MessageInput connection={connection} />);

    fireEvent.change(screen.getByTestId("message-input"), {
      target: { value: "x".repeat(MESSAGE_MAX_LENGTH + 1) },
    });

    const send = screen.getByTestId("message-send") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(screen.getByTestId("message-validation").textContent).toContain(
      "too long",
    );
    fireEvent.submit(send.closest("form")!);
    expect(socket.sendMessages()).toHaveLength(0);
  });

  it("sends valid content and clears the field", () => {
    const { connection, socket } = makeOpenConnection();
    render(<MessageInput connection={connection} />);

    const field = screen.getByTestId("message-input") as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: "hello team" } });

    const send = screen.getByTestId("message-send") as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    fireEvent.click(send);

    const sent = socket.sendMessages();
    expect(sent).toHaveLength(1);
    expect(sent[0].payload).toEqual({ content: "hello team" });
    expect(field.value).toBe("");
  });

  it("surfaces a server-side message rejection", () => {
    const { connection } = makeOpenConnection();
    render(<MessageInput connection={connection} rejection="TOO_LONG" />);
    const rejection = screen.getByTestId("message-rejection");
    expect(rejection.textContent).toContain("exceeded");
  });
});

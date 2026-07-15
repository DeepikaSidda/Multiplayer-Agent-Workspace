/**
 * Tests for {@link MessageLog} (task 13.2).
 *
 * Covers: messages render in `(timestamp, sequence)` order (Requirement 3.4),
 * sender identity is shown (Requirement 3.5), and agent-authored messages get a
 * visual treatment distinct from human messages (Requirement 3.6).
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Message } from "@maw/shared";
import { MessageLog } from "./MessageLog.js";

function msg(overrides: Partial<Message> & { id: string }): Message {
  return {
    workspaceId: "ws-1",
    senderId: "u-1",
    senderType: "human",
    senderName: "Ada",
    content: "hello",
    timestamp: 1000,
    sequence: 1,
    kind: "chat",
    ...overrides,
  };
}

describe("MessageLog", () => {
  it("orders messages by ascending (timestamp, sequence)", () => {
    const messages: Message[] = [
      msg({ id: "c", content: "third", timestamp: 2000, sequence: 5 }),
      msg({ id: "a", content: "first", timestamp: 1000, sequence: 1 }),
      // Same timestamp as "a" but higher sequence -> comes after "a".
      msg({ id: "b", content: "second", timestamp: 1000, sequence: 2 }),
    ];

    render(<MessageLog messages={messages} />);

    const items = screen.getAllByRole("listitem");
    const contents = items.map((li) =>
      li.querySelector(".message-content")?.textContent,
    );
    expect(contents).toEqual(["first", "second", "third"]);
  });

  it("shows the sender identity for each message", () => {
    render(
      <MessageLog
        messages={[
          msg({ id: "a", senderName: "Ada" }),
          msg({ id: "b", senderName: "Grace", senderId: "u-2" }),
        ]}
      />,
    );
    expect(screen.getByText("Ada")).toBeTruthy();
    expect(screen.getByText("Grace")).toBeTruthy();
  });

  it("renders agent messages distinctly from human messages", () => {
    render(
      <MessageLog
        messages={[
          msg({ id: "h", senderName: "Ada", senderType: "human", kind: "chat" }),
          msg({
            id: "g",
            senderName: "Nova",
            senderType: "agent",
            senderId: "a-1",
            kind: "agent",
            content: "agent reply",
          }),
        ]}
      />,
    );

    const items = screen.getAllByRole("listitem");
    const human = items.find((li) => li.textContent?.includes("Ada"))!;
    const agent = items.find((li) => li.textContent?.includes("Nova"))!;

    expect(human.getAttribute("data-author")).toBe("human");
    expect(agent.getAttribute("data-author")).toBe("agent");
    expect(human.getAttribute("data-author")).not.toBe(
      agent.getAttribute("data-author"),
    );
    expect(human.className).toContain("message-human");
    expect(agent.className).toContain("message-agent");
  });

  it("treats agent error notices as agent-authored", () => {
    render(
      <MessageLog
        messages={[
          msg({
            id: "e",
            senderName: "Nova",
            senderType: "agent",
            senderId: "a-1",
            kind: "error",
            content: "generation failed",
          }),
        ]}
      />,
    );
    const item = screen.getAllByRole("listitem")[0];
    expect(item.getAttribute("data-author")).toBe("agent");
    expect(item.getAttribute("data-message-kind")).toBe("error");
    expect(item.className).toContain("message-error");
  });
});

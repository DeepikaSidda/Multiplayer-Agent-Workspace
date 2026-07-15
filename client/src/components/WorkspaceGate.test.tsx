import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceGate } from "./WorkspaceGate.js";

const noop = () => {};

describe("WorkspaceGate invite joining", () => {
  it("shows only the required display name and shared-workspace join action", () => {
    render(
      <WorkspaceGate
        inviteReference="team/alpha room"
        phase={null}
        onCreate={noop}
        onJoin={noop}
      />,
    );

    const nameInput = screen.getByRole("textbox", { name: "Your display name" });
    expect(nameInput.hasAttribute("required")).toBe(true);
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Join shared workspace" })).toBeTruthy();

    expect(screen.queryByRole("button", { name: "Create workspace" })).toBeNull();
    expect(screen.queryByLabelText("Artifact type")).toBeNull();
    expect(screen.queryByLabelText("Join reference")).toBeNull();
    expect(screen.queryByRole("button", { name: "Join workspace" })).toBeNull();
  });

  it("rejects blank and whitespace-only display names without joining", () => {
    const onJoin = vi.fn();
    render(
      <WorkspaceGate
        inviteReference="shared-ref"
        phase={null}
        onCreate={noop}
        onJoin={onJoin}
      />,
    );

    fireEvent.change(screen.getByLabelText("Your display name"), {
      target: { value: "   \t " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Join shared workspace" }));

    expect(onJoin).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("Enter your display name");
  });

  it("submits the decoded normalized reference and trimmed exact display name", () => {
    const onJoin = vi.fn();
    const { rerender } = render(
      <WorkspaceGate
        inviteReference="team/alpha room"
        phase={null}
        onCreate={noop}
        onJoin={onJoin}
      />,
    );

    fireEvent.change(screen.getByLabelText("Your display name"), {
      target: { value: "  Ada Lovelace  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Join shared workspace" }));
    expect(onJoin).toHaveBeenCalledTimes(1);
    expect(onJoin).toHaveBeenCalledWith({
      displayName: "Ada Lovelace",
      joinReference: "team/alpha room",
    });

    rerender(
      <WorkspaceGate
        inviteReference="team/alpha room"
        phase="joining"
        onCreate={noop}
        onJoin={onJoin}
      />,
    );
    expect(screen.getByRole("button", { name: "Joining…" }).hasAttribute("disabled")).toBe(true);
  });

  it("preserves manual reference entry in default mode", () => {
    const onJoin = vi.fn();
    render(
      <WorkspaceGate
        inviteReference={null}
        phase={null}
        onCreate={noop}
        onJoin={onJoin}
      />,
    );

    expect(screen.getByLabelText("Artifact type")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create workspace" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Your display name"), {
      target: { value: "  Grace Hopper  " },
    });
    fireEvent.change(screen.getByLabelText("Join reference"), {
      target: { value: "  manual-ref  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Join workspace" }));

    expect(onJoin).toHaveBeenCalledWith({
      displayName: "Grace Hopper",
      joinReference: "manual-ref",
    });
  });
});

/**
 * Tests for {@link PresenceIndicator} (task 13.2).
 *
 * Covers: agents are visually distinct from humans (Requirement 2.4), the
 * active-participant count is shown (Requirement 2.5), and disconnected members
 * are omitted from the active view.
 */

import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { Participant } from "@maw/shared";
import { PresenceIndicator } from "./PresenceIndicator.js";

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

function agent(id: string, name: string, processing = false): Participant {
  return {
    id,
    workspaceId: "ws-1",
    type: "agent",
    displayName: name,
    joinedAt: 1000,
    presenceState: processing ? "processing" : "active",
    modelId: "amazon.nova-pro-v1:0",
  };
}

describe("PresenceIndicator", () => {
  it("renders agents with a marker distinct from humans", () => {
    render(
      <PresenceIndicator
        participants={[human("h-1", "Ada"), agent("a-1", "Nova")]}
        activeCount={2}
      />,
    );

    const ada = screen.getByLabelText(/Ada \(human\)/);
    const nova = screen.getByLabelText(/Nova \(AI agent\)/);

    expect(ada.getAttribute("data-participant-type")).toBe("human");
    expect(nova.getAttribute("data-participant-type")).toBe("agent");
    // The distinguishing attribute really differs between the two.
    expect(ada.getAttribute("data-participant-type")).not.toBe(
      nova.getAttribute("data-participant-type"),
    );
    // And the CSS treatment differs too.
    expect(ada.className).toContain("presence-human");
    expect(nova.className).toContain("presence-agent");
  });

  it("shows the active participant count", () => {
    render(
      <PresenceIndicator
        participants={[human("h-1", "Ada"), agent("a-1", "Nova")]}
        activeCount={2}
      />,
    );
    const count = screen.getByTestId("active-count");
    expect(within(count).getByText("2")).toBeTruthy();
  });

  it("marks a processing agent distinctly", () => {
    render(
      <PresenceIndicator
        participants={[agent("a-1", "Nova", true)]}
        activeCount={1}
      />,
    );
    const nova = screen.getByLabelText(/Nova \(AI agent, generating\)/);
    expect(nova.getAttribute("data-presence-state")).toBe("processing");
  });

  it("omits disconnected participants from the active list", () => {
    const disconnected: Participant = {
      ...human("h-2", "Gone"),
      presenceState: "disconnected",
    };
    render(
      <PresenceIndicator
        participants={[human("h-1", "Ada"), disconnected]}
        activeCount={1}
      />,
    );
    expect(screen.queryByText("Gone")).toBeNull();
    expect(screen.getByText("Ada")).toBeTruthy();
  });
});

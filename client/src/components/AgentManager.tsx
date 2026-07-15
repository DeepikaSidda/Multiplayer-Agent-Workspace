/**
 * AgentManager — controls to add, remove, and mention AI agent teammates.
 *
 * Requirements:
 *  - 4.1: add an agent via `connection.addAgent(displayName, persona?)` when the
 *    workspace holds fewer than `MAX_AGENTS_PER_WORKSPACE` agents.
 *  - 4.4: remove an agent via `connection.removeAgent(agentId)`.
 *  - 4.5: when the agent capacity is reached, the add control is disabled with a
 *    hint, and a server `AGENT_LIMIT_REACHED` error is surfaced.
 *  - 4.6: a server `AGENT_NOT_FOUND` error (removing an unknown agent) is
 *    surfaced.
 *  - 5.1: each agent exposes a "Mention" affordance that inserts `@DisplayName `
 *    into the message composer so a message can name/reply to that specific
 *    agent (the server triggers a response for a named agent).
 *
 * The roster is passed in (kept current by {@link useWorkspaceConnection} via
 * `agentAdded` / `agentRemoved` / snapshot). Agent-scoped server errors are
 * passed in via `error` and rendered inline.
 */

import { useState } from "react";
import {
  MAX_AGENTS_PER_WORKSPACE,
  type ErrorPayload,
  type Participant,
} from "@maw/shared";
import type { WorkspaceConnection } from "../WorkspaceConnection.js";

export interface AgentManagerProps {
  connection: WorkspaceConnection;
  /** Current participant roster (agents are filtered out of it here). */
  participants: Participant[];
  /** Latest structured operation error, surfaced when agent-scoped. */
  error?: ErrorPayload | null;
  /** Clear the surfaced error (e.g. after acting again). */
  onClearError?: () => void;
  /** Insert an `@DisplayName ` mention into the message composer. */
  onMention?: (displayName: string) => void;
}

/** Error codes this control is responsible for surfacing. */
const AGENT_ERROR_CODES = new Set(["AGENT_LIMIT_REACHED", "AGENT_NOT_FOUND"]);

function agentErrorMessage(error: ErrorPayload): string {
  switch (error.code) {
    case "AGENT_LIMIT_REACHED":
      return `Maximum of ${MAX_AGENTS_PER_WORKSPACE} agents reached — remove one before adding another.`;
    case "AGENT_NOT_FOUND":
      return "That agent is no longer in the workspace.";
    default:
      return error.message;
  }
}

/** Preset agent roles → the persona text sent to the model. */
const ROLE_PRESETS: Record<string, string> = {
  "Product Manager": "a pragmatic product manager who writes crisp PRDs and user stories",
  "Software Engineer": "a senior software engineer who thinks about implementation, edge cases, and testing",
  "Designer": "a product designer focused on UX, flows, and clear, simple copy",
  "Critic": "a constructive critic who finds gaps, risks, and weak assumptions",
  "Researcher": "a researcher who organizes findings and cites concrete points",
};

export function AgentManager({
  connection,
  participants,
  error,
  onClearError,
  onMention,
}: AgentManagerProps) {
  const [displayName, setDisplayName] = useState("");
  const [persona, setPersona] = useState("");
  const [role, setRole] = useState("");

  const agents = participants.filter((p) => p.type === "agent");
  const atCapacity = agents.length >= MAX_AGENTS_PER_WORKSPACE;
  const nameIsEmpty = displayName.trim().length === 0;
  const canAdd = !atCapacity && !nameIsEmpty;

  const agentError =
    error && AGENT_ERROR_CODES.has(error.code) ? error : null;

  const handleAdd = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    if (!canAdd) return;
    const trimmedPersona = persona.trim();
    // Prefer an explicit persona; otherwise fall back to the selected role.
    const effectivePersona =
      trimmedPersona.length > 0 ? trimmedPersona : ROLE_PRESETS[role];
    connection.addAgent(
      displayName.trim(),
      effectivePersona && effectivePersona.length > 0 ? effectivePersona : undefined,
    );
    setDisplayName("");
    setPersona("");
    setRole("");
    onClearError?.();
  };

  const handleRemove = (agentId: string) => {
    connection.removeAgent(agentId);
    onClearError?.();
  };

  return (
    <section className="agent-manager" aria-label="Agent teammates">
      <h2 className="agent-manager-title">AI teammates</h2>

      <form className="agent-add" onSubmit={handleAdd} aria-label="Add an agent">
        <input
          type="text"
          className="agent-add-name"
          aria-label="Agent name"
          data-testid="agent-name-input"
          placeholder="Agent name"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
        />
        <select
          className="agent-add-role"
          aria-label="Agent role"
          data-testid="agent-role-select"
          value={role}
          onChange={(event) => setRole(event.target.value)}
        >
          <option value="">Role (optional)…</option>
          {Object.keys(ROLE_PRESETS).map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <input
          type="text"
          className="agent-add-persona"
          aria-label="Agent persona (optional)"
          data-testid="agent-persona-input"
          placeholder="Custom persona (optional)"
          value={persona}
          onChange={(event) => setPersona(event.target.value)}
        />
        <button type="submit" disabled={!canAdd} data-testid="agent-add">
          Add agent
        </button>
      </form>

      <p className="agent-capacity" data-testid="agent-capacity">
        {agents.length}/{MAX_AGENTS_PER_WORKSPACE} agents
      </p>
      {atCapacity && (
        <p className="agent-capacity-hint" role="note" data-testid="agent-capacity-hint">
          Maximum number of agents reached.
        </p>
      )}

      {agentError && (
        <p className="agent-error" role="alert" data-testid="agent-error">
          {agentErrorMessage(agentError)}
        </p>
      )}

      <ul className="agent-list" aria-label="Current agents">
        {agents.map((agent) => (
          <li
            key={agent.id}
            className="agent-list-item"
            data-testid={`agent-item-${agent.id}`}
            data-presence-state={agent.presenceState}
          >
            <span className="agent-list-name">{agent.displayName}</span>
            <button
              type="button"
              className="agent-mention"
              data-testid={`agent-mention-${agent.id}`}
              onClick={() => onMention?.(agent.displayName)}
            >
              Mention
            </button>
            <button
              type="button"
              className="agent-remove"
              data-testid={`agent-remove-${agent.id}`}
              onClick={() => handleRemove(agent.id)}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

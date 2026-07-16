/**
 * PresenceIndicator — shows who is currently in the workspace and how many.
 *
 * Requirements:
 *  - 2.1: identify each active participant to everyone in the room.
 *  - 2.4: render each Agent_Participant with a visual marker that differs from
 *    any Human_Participant. Agents and humans get distinct `data-participant-type`
 *    values, distinct CSS classes, distinct glyphs, and distinct accessible
 *    labels so the difference is exposed both visually and to assistive tech.
 *  - 2.5: display the active-participant count and keep it current.
 *
 * Disconnected participants are omitted from the active view.
 */

import type { Participant } from "@maw/shared";

export interface PresenceIndicatorProps {
  /** Current participant roster (including any disconnected members). */
  participants: Participant[];
  /** Authoritative active-participant count from the connection. */
  activeCount: number;
}

function humanReadableType(type: Participant["type"]): string {
  return type === "agent" ? "AI agent" : "human";
}

export function PresenceIndicator({
  participants,
  activeCount,
}: PresenceIndicatorProps) {
  const active = participants.filter((p) => p.presenceState !== "disconnected");

  return (
    <section className="presence-indicator" aria-label="Presence">
      <div className="presence-count" data-testid="active-count">
        <span className="presence-count-value">{activeCount}</span>{" "}
        <span className="presence-count-label">
          {activeCount === 1 ? "participant" : "participants"} active
        </span>
      </div>
      <ul className="presence-list" aria-label="Active participants">
        {active.map((participant) => {
          const isAgent = participant.type === "agent";
          const isProcessing =
            isAgent && participant.presenceState === "processing";
          return (
            <li
              key={participant.id}
              className={`presence-participant presence-${participant.type}`}
              data-participant-type={participant.type}
              data-presence-state={participant.presenceState}
              aria-label={`${participant.displayName} (${humanReadableType(
                participant.type,
              )}${isProcessing ? ", generating" : ""})`}
            >
              <span className="presence-marker" aria-hidden="true">
                {isAgent ? "🤖" : "🧑"}
              </span>
              <span className="presence-name">{participant.displayName}</span>
              <span
                className="presence-id"
                title={`Participant ID: ${participant.id}`}
              >
                #{participant.id.slice(0, 6)}
              </span>
              {isProcessing && (
                <span className="presence-processing" aria-hidden="true">
                  generating…
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

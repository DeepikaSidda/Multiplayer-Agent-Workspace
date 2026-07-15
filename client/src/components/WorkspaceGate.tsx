import { useState } from "react";
import type { ArtifactType } from "@maw/shared";

const ARTIFACT_TYPES: readonly ArtifactType[] = [
  "plan", "PRD", "issue", "workflow", "pitch", "checklist",
];

export interface CreateWorkspaceInput {
  displayName: string;
  artifactType: ArtifactType;
}

export interface JoinWorkspaceInput {
  displayName: string;
  joinReference: string;
}

export interface WorkspaceGateProps {
  inviteReference: string | null;
  phase: "creating" | "joining" | null;
  error?: string;
  onCreate(input: CreateWorkspaceInput): void;
  onJoin(input: JoinWorkspaceInput): void;
  /** Leave a failed invite attempt and restore the default create/join gate. */
  onExitInviteMode?(): void;
}

/** Testable create/join gate; browser/network effects are supplied by callbacks. */
export function WorkspaceGate({
  inviteReference,
  phase,
  error = "",
  onCreate,
  onJoin,
  onExitInviteMode,
}: WorkspaceGateProps) {
  const [displayName, setDisplayName] = useState("");
  const [artifactType, setArtifactType] = useState<ArtifactType>("plan");
  const [manualReference, setManualReference] = useState("");
  const [validationError, setValidationError] = useState("");
  const inviteMode = inviteReference !== null;
  const busy = phase !== null;

  const submitJoin = () => {
    const name = displayName.trim();
    if (!name) {
      setValidationError("Enter your display name to join the workspace.");
      return;
    }
    const joinReference = inviteReference ?? manualReference.trim();
    if (!joinReference) {
      setValidationError("Enter a join reference to join an existing workspace.");
      return;
    }
    setValidationError("");
    onJoin({ displayName: name, joinReference });
  };
  return (
    <div className="gate" data-mode={inviteMode ? "invite" : "default"}>
      <h1>{inviteMode ? "You’ve been invited" : "Multiplayer Agent Workspace"}</h1>
      <p className="sub">
        {inviteMode
          ? "Enter your name to join this shared workspace."
          : "Create a shared room or join one with a reference."}
      </p>

      <label htmlFor="name">Your display name</label>
      <input
        id="name"
        value={displayName}
        placeholder="Ada"
        autoComplete="name"
        required
        disabled={busy}
        aria-invalid={validationError.length > 0}
        onChange={(event) => {
          setDisplayName(event.target.value);
          setValidationError("");
        }}
      />

      {inviteMode ? (
        <button type="button" disabled={busy} aria-busy={phase === "joining"} onClick={submitJoin}>
          {phase === "joining" ? "Joining…" : "Join shared workspace"}
        </button>
      ) : (
        <>
          <div className="row">
            <div>
              <label htmlFor="type">Artifact type</label>
              <select
                id="type"
                value={artifactType}
                disabled={busy}
                onChange={(event) => setArtifactType(event.target.value as ArtifactType)}
              >
                {ARTIFACT_TYPES.map((type) => <option key={type}>{type}</option>)}
              </select>
            </div>
          </div>
          <button
            disabled={busy}
            onClick={() => onCreate({
              displayName: displayName.trim() || "Guest",
              artifactType,
            })}
          >
            {phase === "creating" ? "Creating…" : "Create workspace"}
          </button>

          <p className="divider">— or join an existing one —</p>
          <label htmlFor="ref">Join reference</label>
          <input
            id="ref"
            value={manualReference}
            placeholder="paste a reference"
            disabled={busy}
            onChange={(event) => {
              setManualReference(event.target.value);
              setValidationError("");
            }}
          />
          <button className="secondary" disabled={busy} onClick={submitJoin}>
            {phase === "joining" ? "Joining…" : "Join workspace"}
          </button>
        </>
      )}

      <div className="err" role={(validationError || error) ? "alert" : undefined}>
        {validationError || error}
      </div>
      {inviteMode && error && onExitInviteMode ? (
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={onExitInviteMode}
        >
          Back to create or join
        </button>
      ) : null}
    </div>
  );
}

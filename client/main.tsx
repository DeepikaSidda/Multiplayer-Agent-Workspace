/**
 * Browser entry for the Multiplayer Agent Workspace.
 *
 * Renders a small create/join gate. On create it calls the server HTTP API to
 * mint a workspace + shareable join reference; on join it uses a pasted
 * reference. Either way it opens a {@link WorkspaceConnection} to the server's
 * WebSocket endpoint and hands it to the app UI (built in tasks 13.1–13.3).
 *
 * Consumes the compiled client library from `./dist` so Vite only has to
 * transpile this single entry file.
 */

import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { App, WorkspaceConnection } from "./dist/index.js";
import type { ConnectionState } from "./dist/index.js";

const SERVER_HTTP =
  (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_SERVER_HTTP ??
  "http://localhost:8787";
const SERVER_WS =
  (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_SERVER_WS ??
  "ws://localhost:8787/ws";

const ARTIFACT_TYPES = ["plan", "PRD", "issue", "workflow", "pitch", "checklist"] as const;

function Gate() {
  const [connection, setConnection] = useState<WorkspaceConnection | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [artifactType, setArtifactType] = useState<(typeof ARTIFACT_TYPES)[number]>("plan");
  const [joinRef, setJoinRef] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const name = displayName.trim() || "Guest";

  const openConnection = (joinReference: string, participantId?: string) => {
    const conn = new WorkspaceConnection({
      url: SERVER_WS,
      joinReference,
      displayName: name,
      ...(participantId ? { participantId } : {}),
    });
    conn.connect();
    setConnection(conn);
  };

  const handleCreate = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`${SERVER_HTTP}/api/workspaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ownerDisplayName: name, artifactType }),
      });
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      const data = (await res.json()) as { joinReference: string; ownerId: string };
      // Surface the shareable reference so others can join.
      window.history.replaceState(null, "", `#${data.joinReference}`);
      // Join as the recorded Owner so the creator isn't duplicated in the roster.
      openConnection(data.joinReference, data.ownerId);
    } catch (err) {
      setError(
        `Could not create a workspace. Is the server running on ${SERVER_HTTP}? (${String(err)})`,
      );
    } finally {
      setBusy(false);
    }
  };

  const handleJoin = () => {
    const ref = joinRef.trim() || window.location.hash.replace(/^#/, "");
    if (!ref) {
      setError("Enter a join reference to join an existing workspace.");
      return;
    }
    setError("");
    openConnection(ref);
  };

  if (connection) {
    return <WorkspaceShell connection={connection} />;
  }

  return (
    <div className="gate">
      <h1>Multiplayer Agent Workspace</h1>
      <p className="sub">Create a shared room or join one with a reference.</p>

      <label htmlFor="name">Your display name</label>
      <input
        id="name"
        value={displayName}
        placeholder="Ada"
        onChange={(e) => setDisplayName(e.target.value)}
      />

      <div className="row">
        <div>
          <label htmlFor="type">Artifact type</label>
          <select
            id="type"
            value={artifactType}
            onChange={(e) => setArtifactType(e.target.value as typeof artifactType)}
          >
            {ARTIFACT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
      </div>

      <button disabled={busy} onClick={handleCreate}>
        {busy ? "Creating…" : "Create workspace"}
      </button>

      <p className="divider">— or join an existing one —</p>
      <label htmlFor="ref">Join reference</label>
      <input
        id="ref"
        value={joinRef}
        placeholder="paste a reference (or use a #ref link)"
        onChange={(e) => setJoinRef(e.target.value)}
      />
      <button className="secondary" onClick={handleJoin}>
        Join workspace
      </button>

      <div className="err">{error}</div>
    </div>
  );
}

/** The connected app shell: brand top bar (status + share) over the workspace UI. */
function WorkspaceShell({ connection }: { connection: WorkspaceConnection }) {
  const [state, setState] = useState<ConnectionState>(connection.state);
  const [shared, setShared] = useState(false);

  useEffect(() => {
    setState(connection.state);
    return connection.onStateChange(setState);
  }, [connection]);

  const label: Record<ConnectionState, string> = {
    idle: "Idle",
    connecting: "Connecting…",
    open: "Live",
    reconnecting: "Reconnecting…",
    closed: "Disconnected",
  };

  const handleShare = async () => {
    try {
      await navigator.clipboard?.writeText(window.location.href);
      setShared(true);
      setTimeout(() => setShared(false), 1600);
    } catch {
      setShared(false);
    }
  };

  return (
    <div className="shell">
      <div className="topbar">
        <div className="brand">
          <span className="logo">◆</span>
          Agent Workspace
          <span className="brand-sub">multiplayer</span>
        </div>
        <div className="topbar-right">
          <span className={`conn-dot conn-${state}`}>{label[state]}</span>
          <button className="secondary" onClick={handleShare}>
            {shared ? "Link copied ✓" : "Share link"}
          </button>
        </div>
      </div>
      <App connection={connection} />
    </div>
  );
}

function Root() {
  // Stable across renders.
  return useMemo(() => <Gate />, []);
}

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(<Root />);
}

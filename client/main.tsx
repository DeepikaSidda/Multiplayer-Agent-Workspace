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
import {
  App,
  BrowserJoinController,
  parseJoinReferenceHash,
  WorkspaceConnection,
} from "./dist/index.js";
import type { ConnectionState } from "./dist/index.js";

const ENV = (import.meta as unknown as { env?: Record<string, string> }).env ?? {};
// Default to SAME-ORIGIN so the app works behind one address in production
// (the server serves this build) and in dev (Vite proxies /api and /ws to the
// server). Override with VITE_SERVER_HTTP / VITE_SERVER_WS if hosting split.
const SERVER_HTTP = ENV.VITE_SERVER_HTTP ?? window.location.origin;
const SERVER_WS =
  ENV.VITE_SERVER_WS ??
  `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws`;

// Capture the initial invite target once. Later history/hash mutations (for
// example after workspace creation) must not change which invite was opened.
const INITIAL_INVITE_REFERENCE = parseJoinReferenceHash(window.location.hash);

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
  return useMemo(
    () => (
      <BrowserJoinController
        initialInviteReference={INITIAL_INVITE_REFERENCE}
        serverHttp={SERVER_HTTP}
        serverWs={SERVER_WS}
        renderWorkspace={(connection: WorkspaceConnection) => (
          <WorkspaceShell connection={connection} />
        )}
      />
    ),
    [],
  );
}

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(<Root />);
}

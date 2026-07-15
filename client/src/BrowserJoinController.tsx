import { useEffect, useRef, useState, type ReactNode } from "react";
import { App } from "./App.js";
import {
  WorkspaceConnection,
  type WorkspaceConnectionOptions,
} from "./WorkspaceConnection.js";
import {
  WorkspaceGate,
  type CreateWorkspaceInput,
  type JoinWorkspaceInput,
} from "./components/WorkspaceGate.js";
import {
  clearSession,
  loadSession,
  newParticipantId,
  saveSession,
} from "./sessionStore.js";

export type WorkspaceConnectionFactory = (
  options: WorkspaceConnectionOptions,
) => WorkspaceConnection;

export interface BrowserJoinControllerProps {
  initialInviteReference: string | null;
  serverHttp: string;
  serverWs: string;
  connectionFactory?: WorkspaceConnectionFactory;
  fetchFn?: typeof fetch;
  clearInviteHash?: () => void;
  renderWorkspace?: (connection: WorkspaceConnection) => ReactNode;
}

/**
 * Browser create/join controller with injectable side-effect seams. It keeps an
 * attempted invite connection out of the workspace UI until a snapshot arrives.
 */
export function BrowserJoinController({
  initialInviteReference,
  serverHttp,
  serverWs,
  connectionFactory = (options) => new WorkspaceConnection(options),
  fetchFn,
  clearInviteHash,
  renderWorkspace = (connection) => <App connection={connection} />,
}: BrowserJoinControllerProps) {
  const [connection, setConnection] = useState<WorkspaceConnection | null>(null);
  const [inviteReference, setInviteReference] = useState<string | null>(
    initialInviteReference,
  );
  // A remembered session for an invite reference lets us rejoin on reload
  // without re-prompting for a name and without creating a duplicate.
  const rememberedInvite =
    initialInviteReference !== null ? loadSession(initialInviteReference) : null;
  const [phase, setPhase] = useState<"creating" | "joining" | null>(
    rememberedInvite ? "joining" : null,
  );
  // True while silently rejoining a remembered session on load, so we show a
  // brief "Rejoining…" panel instead of flashing the name-entry gate.
  const [autoRejoining, setAutoRejoining] = useState<boolean>(
    Boolean(rememberedInvite),
  );
  const [error, setError] = useState("");
  const pendingConnection = useRef<WorkspaceConnection | null>(null);

  const destroyPendingConnection = () => {
    const pending = pendingConnection.current;
    pendingConnection.current = null;
    if (pending) {
      pending.close();
      pending.destroy();
    }
  };

  const openConnection = (
    joinReference: string,
    displayName: string,
    participantId?: string,
  ) => {
    destroyPendingConnection();
    setConnection(null);

    // Persist identity so a reload rejoins as the same participant (idempotent
    // on the server) instead of prompting again or duplicating the roster.
    if (participantId) {
      saveSession(joinReference, { displayName, participantId });
    }

    const conn = connectionFactory({
      url: serverWs,
      joinReference,
      displayName,
      ...(participantId ? { participantId } : {}),
    });
    pendingConnection.current = conn;
    setPhase("joining");

    let settled = false;
    let unsubscribeError = () => {};
    let unsubscribeSnapshot = () => {};
    const unsubscribeAttempt = () => {
      unsubscribeError();
      unsubscribeSnapshot();
    };

    // Subscribe before connect: a fake or fast server may reject immediately.
    unsubscribeError = conn.on("error", (payload) => {
      setAutoRejoining(false);
      if (payload.code !== "WORKSPACE_NOT_FOUND" || settled) {
        setError(payload.message || "The workspace connection reported an error.");
        return;
      }

      settled = true;
      unsubscribeAttempt();
      if (pendingConnection.current === conn) pendingConnection.current = null;
      conn.close();
      conn.destroy();
      // A remembered session for a now-invalid reference must be forgotten so
      // the next load shows the gate instead of looping on auto-rejoin.
      clearSession(joinReference);
      setConnection((current) => (current === conn ? null : current));
      setPhase(null);
      setError(
        "That shared workspace was not found. The invite link may be invalid or expired.",
      );
    });
    unsubscribeSnapshot = conn.on("workspaceSnapshot", () => {
      if (settled) return;
      settled = true;
      unsubscribeAttempt();
      if (pendingConnection.current === conn) pendingConnection.current = null;
      setConnection(conn);
      setPhase(null);
      setAutoRejoining(false);
      setError("");
    });
    conn.connect();
  };

  // On load, if we opened an invite link we've joined before, rejoin
  // automatically as the same participant — no name re-prompt, no duplicate.
  useEffect(() => {
    if (initialInviteReference && rememberedInvite) {
      openConnection(
        initialInviteReference,
        rememberedInvite.displayName,
        rememberedInvite.participantId,
      );
    }
    return () => destroyPendingConnection();
    // Run once on mount; openConnection/remembered values are stable here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCreate = async ({
    displayName,
    artifactType,
  }: CreateWorkspaceInput) => {
    setPhase("creating");
    setError("");
    let joiningStarted = false;
    try {
      const request = fetchFn ?? fetch;
      const response = await request(`${serverHttp}/api/workspaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ownerDisplayName: displayName, artifactType }),
      });
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      const data = (await response.json()) as {
        joinReference: string;
        ownerId: string;
      };
      window.history.replaceState(null, "", `#${data.joinReference}`);
      joiningStarted = true;
      openConnection(data.joinReference, displayName, data.ownerId);
    } catch (caught) {
      setError(
        `Could not create a workspace. Is the server running on ${serverHttp}? (${String(caught)})`,
      );
    } finally {
      if (!joiningStarted) setPhase(null);
    }
  };

  const handleJoin = ({ displayName, joinReference }: JoinWorkspaceInput) => {
    const normalizedDisplayName = displayName.trim();
    if (!normalizedDisplayName) {
      setError("Enter your display name to join the workspace.");
      return;
    }

    const reference = joinReference.trim();
    // Reuse a prior identity for this workspace when present, otherwise mint a
    // stable one, so a later reload rejoins as the same participant.
    const participantId =
      loadSession(reference)?.participantId ?? newParticipantId();

    setError("");
    openConnection(reference, normalizedDisplayName, participantId);
  };

  const handleExitInviteMode = () => {
    destroyPendingConnection();
    if (initialInviteReference) clearSession(initialInviteReference);
    setConnection(null);
    setPhase(null);
    setAutoRejoining(false);
    setError("");
    setInviteReference(null);
    if (clearInviteHash) {
      clearInviteHash();
    } else {
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}`,
      );
    }
  };

  if (connection) return <>{renderWorkspace(connection)}</>;

  if (autoRejoining) {
    return (
      <div className="gate" data-mode="rejoining">
        <h1>Rejoining…</h1>
        <p className="sub">Reconnecting you to your workspace.</p>
      </div>
    );
  }

  return (
    <WorkspaceGate
      inviteReference={inviteReference}
      phase={phase}
      error={error}
      onCreate={handleCreate}
      onJoin={handleJoin}
      onExitInviteMode={handleExitInviteMode}
    />
  );
}

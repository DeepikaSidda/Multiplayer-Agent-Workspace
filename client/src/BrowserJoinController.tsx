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
  const [phase, setPhase] = useState<"creating" | "joining" | null>(null);
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

  useEffect(() => () => destroyPendingConnection(), []);

  const openConnection = (
    joinReference: string,
    displayName: string,
    participantId?: string,
  ) => {
    destroyPendingConnection();
    setConnection(null);

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
      if (payload.code !== "WORKSPACE_NOT_FOUND" || settled) {
        setError(payload.message || "The workspace connection reported an error.");
        return;
      }

      settled = true;
      unsubscribeAttempt();
      if (pendingConnection.current === conn) pendingConnection.current = null;
      conn.close();
      conn.destroy();
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
      setError("");
    });
    conn.connect();
  };

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

    setError("");
    openConnection(joinReference.trim(), normalizedDisplayName);
  };

  const handleExitInviteMode = () => {
    destroyPendingConnection();
    setConnection(null);
    setPhase(null);
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

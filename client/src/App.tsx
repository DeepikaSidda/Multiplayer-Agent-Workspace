/**
 * Multiplayer Agent Workspace — client SPA root.
 *
 * When a connected {@link WorkspaceConnection} is provided, the app renders the
 * presence / messaging / artifact-editor UI (task 13.2) via {@link WorkspaceView}.
 * The join/create flow and the agent-management + export controls are added in
 * task 13.3, which supplies the connection to this component.
 */

import type { WorkspaceConnection } from "./WorkspaceConnection.js";
import { WorkspaceView } from "./components/WorkspaceView.js";

export interface AppProps {
  /** An initialized connection to render the workspace for. */
  connection?: WorkspaceConnection;
}

export function App({ connection }: AppProps = {}) {
  if (!connection) {
    return <div className="app app-empty">Multiplayer Agent Workspace</div>;
  }
  return (
    <div className="app">
      <WorkspaceView connection={connection} />
    </div>
  );
}

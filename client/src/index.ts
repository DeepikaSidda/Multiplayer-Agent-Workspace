/**
 * @maw/client — public client surface.
 *
 * Task 13.1 provides the WebSocket transport and Yjs sync. Task 13.2 adds the
 * presence / messaging / artifact-editor UI built on {@link WorkspaceConnection}
 * and the local `Y.Doc` it exposes. Task 13.3 layers on agent-management and
 * export controls.
 */

export {
  WorkspaceConnection,
  ARTIFACT_TEXT_KEY,
  type ClientSocket,
  type SocketFactory,
  type ConnectionState,
  type ServerEventPayloadMap,
  type ServerEventListener,
  type Unsubscribe,
  type WorkspaceConnectionOptions,
} from "./WorkspaceConnection.js";

export { bytesToBase64, base64ToBytes, isBase64 } from "./codec.js";

// React hook adapting the transport into reactive UI state (task 13.2).
export {
  useWorkspaceConnection,
  type WorkspaceView as WorkspaceViewState,
} from "./useWorkspaceConnection.js";

// Presentational UI components (task 13.2).
export { App, type AppProps } from "./App.js";
export {
  WorkspaceView,
  type WorkspaceViewProps,
} from "./components/WorkspaceView.js";
export {
  PresenceIndicator,
  type PresenceIndicatorProps,
} from "./components/PresenceIndicator.js";
export { MessageLog, type MessageLogProps } from "./components/MessageLog.js";
export { MessageInput, type MessageInputProps } from "./components/MessageInput.js";
export {
  ArtifactEditor,
  applyTextDiff,
  type ArtifactEditorProps,
} from "./components/ArtifactEditor.js";

// Agent-management and export controls (task 13.3).
export { AgentManager, type AgentManagerProps } from "./components/AgentManager.js";
export { ExportControl, type ExportControlProps } from "./components/ExportControl.js";
export { ErrorBanner, type ErrorBannerProps } from "./components/ErrorBanner.js";

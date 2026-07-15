/**
 * WorkspaceView — composes the presence, messaging, artifact editor, agent
 * management, and export UI over a connected {@link WorkspaceConnection}
 * (tasks 13.2 and 13.3).
 *
 * It wires the reactive {@link useWorkspaceConnection} state into the
 * presentational components:
 *  - {@link PresenceIndicator} (Requirements 2.1, 2.4, 2.5)
 *  - {@link MessageLog} + {@link MessageInput} (Requirements 3.4, 3.5, 3.6, 3.1/3.2, 8.2)
 *  - {@link ArtifactEditor} bound to the local `Y.Text` (Requirement 6.3)
 *  - {@link AgentManager} to add/remove/mention agents
 *    (Requirements 4.1, 4.4, 4.5, 4.6, 5.1)
 *  - {@link ExportControl} to export the artifact as Markdown
 *    (Requirements 7.1, 7.2, 7.4, 7.5)
 *  - {@link ErrorBanner} to surface artifact rejections and operation errors
 *    (Requirements 6.5, 8.4)
 *
 * The message composer is controlled here so the agent "Mention" affordance can
 * inject `@DisplayName ` into the draft (Requirement 5.1).
 */

import { useCallback, useState } from "react";
import type { WorkspaceConnection } from "../WorkspaceConnection.js";
import { useWorkspaceConnection } from "../useWorkspaceConnection.js";
import { PresenceIndicator } from "./PresenceIndicator.js";
import { MessageLog } from "./MessageLog.js";
import { MessageInput } from "./MessageInput.js";
import { ArtifactEditor } from "./ArtifactEditor.js";
import { AgentManager } from "./AgentManager.js";
import { ExportControl } from "./ExportControl.js";
import { ErrorBanner } from "./ErrorBanner.js";

export interface WorkspaceViewProps {
  connection: WorkspaceConnection;
  /** Optional injected download side effect for {@link ExportControl} (tests). */
  onDownloadExport?: (filename: string, markdown: string) => void;
  /** Optional injected copy side effect for {@link ExportControl} (tests). */
  onCopyExport?: (markdown: string) => void | Promise<void>;
}

export function WorkspaceView({
  connection,
  onDownloadExport,
  onCopyExport,
}: WorkspaceViewProps) {
  const view = useWorkspaceConnection(connection);
  const [draft, setDraft] = useState("");

  // Insert an `@DisplayName ` mention into the composer without clobbering any
  // text already typed, so a human can name/reply to a specific agent (Req 5.1).
  const handleMention = useCallback((displayName: string) => {
    const mention = `@${displayName} `;
    setDraft((current) =>
      current.length === 0 || current.endsWith(" ")
        ? `${current}${mention}`
        : `${current} ${mention}`,
    );
  }, []);

  return (
    <div className="workspace-view" data-connection-state={view.connectionState}>
      <header className="workspace-header">
        <PresenceIndicator
          participants={view.participants}
          activeCount={view.activeCount}
        />
        <ExportControl
          connection={connection}
          download={onDownloadExport}
          copy={onCopyExport}
        />
      </header>

      <ErrorBanner
        artifactRejection={view.lastArtifactRejection}
        onClearArtifactRejection={view.clearArtifactRejection}
        error={view.lastError}
        onClearError={view.clearError}
      />

      <main className="workspace-main">
        <section className="workspace-chat" aria-label="Chat">
          <MessageLog messages={view.messages} />
          <MessageInput
            connection={connection}
            rejection={view.lastMessageRejection}
            onClearRejection={view.clearMessageRejection}
            value={draft}
            onValueChange={setDraft}
          />
        </section>

        <section className="workspace-agents" aria-label="Agents">
          <AgentManager
            connection={connection}
            participants={view.participants}
            error={view.lastError}
            onClearError={view.clearError}
            onMention={handleMention}
          />
        </section>

        <section className="workspace-artifact" aria-label="Artifact">
          <ArtifactEditor
            text={connection.getText()}
            artifactType={view.artifactMeta?.artifactType ?? null}
          />
        </section>
      </main>
    </div>
  );
}

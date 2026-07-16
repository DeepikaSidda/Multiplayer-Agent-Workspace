/**
 * WorkspaceView — composes the presence, messaging, artifact editor, agent
 * management, and export UI over a connected {@link WorkspaceConnection}
 * (tasks 13.2 and 13.3), plus collaboration-signal enhancements:
 *  - a live "agent is typing" indicator while an agent generates (presence
 *    `processing`),
 *  - an approve/reject banner when an agent edits the shared artifact, so a
 *    human can Keep or Revert the agent's contribution.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceConnection } from "../WorkspaceConnection.js";
import { useWorkspaceConnection } from "../useWorkspaceConnection.js";
import {
  addToHistory,
  loadHistory,
  removeFromHistory,
  type SavedResult,
} from "../artifactHistory.js";
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

/** A pending agent artifact contribution awaiting human approval. */
interface PendingAgentEdit {
  agentName: string;
  /** The artifact content immediately BEFORE the agent's edit (for Revert). */
  before: string;
}

export function WorkspaceView({
  connection,
  onDownloadExport,
  onCopyExport,
}: WorkspaceViewProps) {
  const view = useWorkspaceConnection(connection);
  const [draft, setDraft] = useState("");
  const [pendingAgentEdit, setPendingAgentEdit] = useState<PendingAgentEdit | null>(null);

  // Local, per-workspace saved-result history (Save to history / Clear).
  const workspaceId = view.workspace?.id ?? "";
  const [history, setHistory] = useState<SavedResult[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => {
    setHistory(workspaceId ? loadHistory(workspaceId) : []);
  }, [workspaceId]);

  /** Replace the shared result content in a single CRDT transaction. */
  const setArtifactContent = useCallback(
    (content: string) => {
      const text = connection.getText();
      const apply = () => {
        if (text.length > 0) text.delete(0, text.length);
        if (content.length > 0) text.insert(0, content);
      };
      const doc = text.doc;
      if (doc) doc.transact(apply);
      else apply();
    },
    [connection],
  );

  const handleSaveToHistory = useCallback(() => {
    const content = connection.getContent().trim();
    if (!workspaceId || content.length === 0) return;
    setHistory(addToHistory(workspaceId, connection.getContent()));
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1500);
  }, [connection, workspaceId]);

  const handleClearArtifact = useCallback(() => {
    setArtifactContent("");
    setPendingAgentEdit(null);
  }, [setArtifactContent]);

  const handleRestore = useCallback(
    (content: string) => setArtifactContent(content),
    [setArtifactContent],
  );

  const handleDeleteHistory = useCallback(
    (id: string) => setHistory(removeFromHistory(workspaceId, id)),
    [workspaceId],
  );

  // Keep the latest roster in a ref so the artifact-review effect (attached
  // once) can resolve an editor id → agent without re-subscribing constantly.
  const participantsRef = useRef(view.participants);
  participantsRef.current = view.participants;

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

  // Detect agent edits to the shared artifact and surface an approve/reject
  // banner. The connection applies each incoming update to the local Y.Text
  // (firing the observer) BEFORE emitting the `artifactUpdate` event, so when
  // the event names an agent editor we already have the pre-edit content.
  useEffect(() => {
    const text = connection.getText();
    let previous = text.toString();
    let lastBefore = previous;

    const observer = () => {
      lastBefore = previous;
      previous = text.toString();
    };
    text.observe(observer);

    const unsubscribe = connection.on("artifactUpdate", (payload) => {
      const editor = participantsRef.current.find(
        (p) => p.id === payload.lastEditorId,
      );
      if (editor && editor.type === "agent") {
        setPendingAgentEdit({ agentName: editor.displayName, before: lastBefore });
      }
    });

    return () => {
      text.unobserve(observer);
      unsubscribe();
    };
  }, [connection]);

  const keepAgentEdit = useCallback(() => setPendingAgentEdit(null), []);

  const revertAgentEdit = useCallback(() => {
    setPendingAgentEdit((pending) => {
      if (!pending) return null;
      const text = connection.getText();
      const restore = () => {
        if (text.length > 0) text.delete(0, text.length);
        if (pending.before.length > 0) text.insert(0, pending.before);
      };
      const doc = text.doc;
      if (doc) doc.transact(restore);
      else restore();
      return null;
    });
  }, [connection]);

  // Agents currently generating a response (presence `processing`).
  const typingAgents = view.participants.filter(
    (p) => p.type === "agent" && p.presenceState === "processing",
  );

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
          {typingAgents.length > 0 && (
            <div className="typing-indicator" role="status" data-testid="typing-indicator">
              <span className="typing-dots" aria-hidden="true">
                <span /><span /><span />
              </span>
              {typingAgents.map((a) => a.displayName).join(", ")}{" "}
              {typingAgents.length === 1 ? "is" : "are"} generating…
            </div>
          )}
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
          <div className="artifact-toolbar">
            <button
              type="button"
              className="artifact-save"
              data-testid="artifact-save"
              onClick={handleSaveToHistory}
            >
              {savedFlash ? "Saved ✓" : "Save to history"}
            </button>
            <button
              type="button"
              className="secondary artifact-clear"
              data-testid="artifact-clear"
              onClick={handleClearArtifact}
            >
              Clear
            </button>
            <button
              type="button"
              className="secondary artifact-history-toggle"
              data-testid="artifact-history-toggle"
              onClick={() => setHistoryOpen((v) => !v)}
            >
              History ({history.length})
            </button>
          </div>

          {historyOpen && (
            <ul className="artifact-history" data-testid="artifact-history">
              {history.length === 0 && (
                <li className="artifact-history-empty">
                  No saved results yet. Click “Save to history” to keep the current result.
                </li>
              )}
              {history.map((entry) => (
                <li key={entry.id} className="artifact-history-item">
                  <span className="artifact-history-meta">
                    {new Date(entry.savedAt).toLocaleString()} ·{" "}
                    {entry.content.trim().split(/\s+/).length} words
                  </span>
                  <span className="artifact-history-preview">
                    {entry.content.trim().slice(0, 80) || "(empty)"}
                  </span>
                  <span className="artifact-history-actions">
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => handleRestore(entry.content)}
                    >
                      Restore
                    </button>
                    <button
                      type="button"
                      className="secondary artifact-history-delete"
                      onClick={() => handleDeleteHistory(entry.id)}
                      aria-label="Delete saved result"
                    >
                      ✕
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}

          {pendingAgentEdit && (
            <div className="agent-review" role="status" data-testid="agent-review">
              <span className="agent-review-text">
                🤖 <strong>{pendingAgentEdit.agentName}</strong> updated the artifact.
              </span>
              <span className="agent-review-actions">
                <button
                  type="button"
                  className="agent-review-keep"
                  data-testid="agent-review-keep"
                  onClick={keepAgentEdit}
                >
                  Keep
                </button>
                <button
                  type="button"
                  className="agent-review-revert"
                  data-testid="agent-review-revert"
                  onClick={revertAgentEdit}
                >
                  Revert
                </button>
              </span>
            </div>
          )}
          <ArtifactEditor
            text={connection.getText()}
            artifactType={view.artifactMeta?.artifactType ?? null}
          />
        </section>
      </main>
    </div>
  );
}

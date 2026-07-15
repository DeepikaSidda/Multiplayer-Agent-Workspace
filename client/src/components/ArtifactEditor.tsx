/**
 * ArtifactEditor — a Markdown-capable editor bound to the shared `Y.Text`.
 *
 * Requirement 6.3: a human edit is applied and delivered to all participants.
 * The editor edits the artifact's Markdown *source* text (the transport forwards
 * local `Y.Text` changes as `artifactUpdate` envelopes; remote updates flow back
 * in through the same `Y.Text`). A full rich renderer is out of scope — a
 * textarea over the Markdown source is the "Markdown-capable" surface.
 *
 * Sync model:
 *  - Local typing is translated into a minimal `(delete, insert)` edit over the
 *    changed range and applied to the `Y.Text` inside a single transaction, so
 *    concurrent edits merge as CRDT operations rather than clobbering the doc.
 *  - Remote changes to the `Y.Text` are observed and reflected back into the
 *    textarea, keeping the local view convergent with the shared document.
 */

import { useEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import type { ArtifactType } from "@maw/shared";

export interface ArtifactEditorProps {
  /** The shared artifact text (from `WorkspaceConnection.getText()`). */
  text: Y.Text;
  /** Optional artifact type, shown as a label hint. */
  artifactType?: ArtifactType | null;
}

/**
 * Apply the transition from `previous` to `next` onto `text` as the smallest
 * `(delete, insert)` at the first divergent index, so unchanged prefixes and
 * suffixes are preserved as-is and concurrent edits elsewhere are not disturbed.
 */
export function applyTextDiff(text: Y.Text, previous: string, next: string): void {
  if (previous === next) return;

  const maxPrefix = Math.min(previous.length, next.length);
  let prefix = 0;
  while (prefix < maxPrefix && previous[prefix] === next[prefix]) prefix += 1;

  let prevEnd = previous.length;
  let nextEnd = next.length;
  while (
    prevEnd > prefix &&
    nextEnd > prefix &&
    previous[prevEnd - 1] === next[nextEnd - 1]
  ) {
    prevEnd -= 1;
    nextEnd -= 1;
  }

  const deleteCount = prevEnd - prefix;
  const insertText = next.slice(prefix, nextEnd);

  const doc = text.doc;
  const mutate = () => {
    if (deleteCount > 0) text.delete(prefix, deleteCount);
    if (insertText.length > 0) text.insert(prefix, insertText);
  };
  // Group delete+insert into one transaction so the transport emits a single
  // coalesced update for the keystroke.
  if (doc) doc.transact(mutate);
  else mutate();
}

export function ArtifactEditor({ text, artifactType }: ArtifactEditorProps) {
  const [value, setValue] = useState<string>(() => text.toString());
  // Track the last value we pushed into the Y.Text so the diff is computed
  // against the shared doc's current content, even across remote updates.
  const lastSyncedRef = useRef<string>(text.toString());

  useEffect(() => {
    const initial = text.toString();
    lastSyncedRef.current = initial;
    setValue(initial);

    const observer = () => {
      const current = text.toString();
      lastSyncedRef.current = current;
      setValue(current);
    };
    text.observe(observer);
    return () => text.unobserve(observer);
  }, [text]);

  const handleChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = event.target.value;
    setValue(next);
    applyTextDiff(text, lastSyncedRef.current, next);
    lastSyncedRef.current = next;
  };

  return (
    <section className="artifact-editor" aria-label="Artifact editor">
      <label className="artifact-editor-label" htmlFor="artifact-editor-textarea">
        Artifact{artifactType ? ` (${artifactType})` : ""} — Plain text
      </label>
      <textarea
        id="artifact-editor-textarea"
        className="artifact-editor-textarea"
        data-testid="artifact-editor"
        aria-label="Artifact plain text content"
        placeholder="Your shared result appears here. Type to edit it together, or ask an agent to 'write' or 'update' it — e.g. @Nova write a plan for…"
        value={value}
        onChange={handleChange}
        rows={16}
      />
    </section>
  );
}

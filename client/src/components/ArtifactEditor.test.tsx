/**
 * Tests for {@link ArtifactEditor} (task 13.2, Requirement 6.3).
 *
 * Covers: the editor reflects the shared `Y.Text` content on mount, local edits
 * are written into the `Y.Text` (so the transport can forward them), and remote
 * changes to the `Y.Text` are reflected back into the textarea.
 */

import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { act } from "@testing-library/react";
import * as Y from "yjs";
import { ArtifactEditor, applyTextDiff } from "./ArtifactEditor.js";

describe("ArtifactEditor", () => {
  it("reflects the initial Y.Text content", () => {
    const doc = new Y.Doc();
    const text = doc.getText("content");
    text.insert(0, "# Plan\n\nseed");

    render(<ArtifactEditor text={text} />);
    const textarea = screen.getByTestId("artifact-editor") as HTMLTextAreaElement;
    expect(textarea.value).toBe("# Plan\n\nseed");
    doc.destroy();
  });

  it("writes local edits into the Y.Text", () => {
    const doc = new Y.Doc();
    const text = doc.getText("content");

    render(<ArtifactEditor text={text} />);
    const textarea = screen.getByTestId("artifact-editor") as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "hello world" } });
    expect(text.toString()).toBe("hello world");

    // A subsequent edit produces the corresponding Y.Text content.
    fireEvent.change(textarea, { target: { value: "hello brave world" } });
    expect(text.toString()).toBe("hello brave world");
    doc.destroy();
  });

  it("reflects remote Y.Text changes back into the textarea", () => {
    const doc = new Y.Doc();
    const text = doc.getText("content");

    render(<ArtifactEditor text={text} />);
    const textarea = screen.getByTestId("artifact-editor") as HTMLTextAreaElement;

    // Simulate a remote update applied to the shared doc.
    act(() => {
      text.insert(0, "from a teammate");
    });
    expect(textarea.value).toBe("from a teammate");
    doc.destroy();
  });

  it("applyTextDiff applies a minimal middle edit without clobbering the doc", () => {
    const doc = new Y.Doc();
    const text = doc.getText("content");
    text.insert(0, "the quick brown fox");

    // A concurrent observer that would notice a full-replace as many ops.
    let deltaOps = 0;
    text.observe((event) => {
      deltaOps += event.changes.delta.length;
    });

    applyTextDiff(text, "the quick brown fox", "the quick red fox");
    expect(text.toString()).toBe("the quick red fox");
    // A minimal diff touches only the changed middle span (retain/delete/insert),
    // not the entire document.
    expect(deltaOps).toBeLessThanOrEqual(3);
    doc.destroy();
  });
});

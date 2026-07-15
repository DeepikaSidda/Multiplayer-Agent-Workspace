/**
 * ExportControl — requests a Markdown export and makes it available to the
 * requesting participant for download or copy.
 *
 * Requirements:
 *  - 7.1/7.2: request an export via `connection.requestExport()` and, on the
 *    server's `exportReady` event, make the returned Markdown available for
 *    download (a `.md` blob) and copy.
 *  - 7.4: when the artifact is empty, the server returns `EXPORT_EMPTY`; surface
 *    an "artifact is empty" message and produce no download.
 *  - 7.5: when export fails, the server returns `EXPORT_FAILED`; surface an
 *    "export could not be produced" message.
 *
 * The download and copy side effects are injectable so tests do not touch real
 * browser download/clipboard APIs; they default to real browser implementations.
 */

import { useEffect, useRef, useState } from "react";
import { jsPDF } from "jspdf";
import type { WorkspaceConnection } from "../WorkspaceConnection.js";

/** Trigger a browser download of `markdown` as a `.md` file. */
function browserDownload(filename: string, markdown: string): void {
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/**
 * Render `content` as a simple multi-page A4 PDF and trigger a download. The
 * artifact is plain text, so we wrap lines to the page width and paginate.
 */
function browserDownloadPdf(filename: string, content: string): void {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const marginX = 48;
  const marginY = 56;
  const fontSize = 11;
  const lineHeight = 16;
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const usableWidth = pageWidth - marginX * 2;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(fontSize);

  // Preserve blank lines while wrapping long lines to the page width.
  const sourceLines = content.replace(/\r\n/g, "\n").split("\n");
  const wrapped: string[] = [];
  for (const line of sourceLines) {
    if (line.length === 0) {
      wrapped.push("");
      continue;
    }
    for (const piece of doc.splitTextToSize(line, usableWidth) as string[]) {
      wrapped.push(piece);
    }
  }

  let y = marginY;
  for (const line of wrapped) {
    if (y + lineHeight > pageHeight - marginY) {
      doc.addPage();
      y = marginY;
    }
    doc.text(line, marginX, y);
    y += lineHeight;
  }

  doc.save(filename);
}

/** Turn `document.md` (or similar) into a `.pdf` filename. */
function toPdfFilename(filename: string): string {
  return filename.replace(/\.md$/i, "") + ".pdf";
}

/** Copy `markdown` to the clipboard via the async Clipboard API. */
async function browserCopy(markdown: string): Promise<void> {
  await navigator.clipboard?.writeText(markdown);
}

export interface ExportControlProps {
  connection: WorkspaceConnection;
  /** Side effect that saves the export locally. Defaults to a blob download. */
  download?: (filename: string, markdown: string) => void;
  /** Side effect that saves the export as a PDF. Defaults to a jsPDF download. */
  downloadPdf?: (filename: string, content: string) => void;
  /** Side effect that copies the export. Defaults to the Clipboard API. */
  copy?: (markdown: string) => void | Promise<void>;
}

interface ReadyExport {
  filename: string;
  markdown: string;
}

type Status =
  | { kind: "idle" }
  | { kind: "requesting" }
  | { kind: "ready"; filename: string }
  | { kind: "copied"; filename: string }
  | { kind: "empty" }
  | { kind: "failed" };

export function ExportControl({
  connection,
  download = browserDownload,
  downloadPdf = browserDownloadPdf,
  copy = browserCopy,
}: ExportControlProps) {
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [ready, setReady] = useState<ReadyExport | null>(null);
  // Which format the pending request should download when it arrives.
  const requestedFormat = useRef<"md" | "pdf">("md");

  useEffect(() => {
    const unsubReady = connection.on("exportReady", (payload) => {
      setReady({ filename: payload.filename, markdown: payload.markdown });
      // Deliver the export for download as soon as it is produced (Req 7.2),
      // in whichever format was requested.
      if (requestedFormat.current === "pdf") {
        const pdfName = toPdfFilename(payload.filename);
        downloadPdf(pdfName, payload.markdown);
        setStatus({ kind: "ready", filename: pdfName });
      } else {
        download(payload.filename, payload.markdown);
        setStatus({ kind: "ready", filename: payload.filename });
      }
    });
    const unsubError = connection.on("error", (payload) => {
      if (payload.code === "EXPORT_EMPTY") {
        setReady(null);
        setStatus({ kind: "empty" });
      } else if (payload.code === "EXPORT_FAILED") {
        setReady(null);
        setStatus({ kind: "failed" });
      }
    });
    return () => {
      unsubReady();
      unsubError();
    };
  }, [connection, download, downloadPdf]);

  const handleExport = (format: "md" | "pdf") => {
    requestedFormat.current = format;
    setStatus({ kind: "requesting" });
    setReady(null);
    connection.requestExport();
  };

  const handleCopy = async () => {
    if (!ready) return;
    await copy(ready.markdown);
    setStatus({ kind: "copied", filename: ready.filename });
  };

  return (
    <section className="export-control" aria-label="Export">
      <button
        type="button"
        onClick={() => handleExport("md")}
        data-testid="export-request"
      >
        Export Markdown
      </button>

      <button
        type="button"
        onClick={() => handleExport("pdf")}
        data-testid="export-request-pdf"
      >
        Export PDF
      </button>

      {ready && (
        <button type="button" onClick={handleCopy} data-testid="export-copy">
          Copy to clipboard
        </button>
      )}

      {status.kind === "ready" && (
        <p className="export-status" role="status" data-testid="export-status">
          Exported {status.filename}.
        </p>
      )}
      {status.kind === "copied" && (
        <p className="export-status" role="status" data-testid="export-status">
          Copied {status.filename} to the clipboard.
        </p>
      )}
      {status.kind === "empty" && (
        <p className="export-error" role="alert" data-testid="export-error">
          The artifact is empty — nothing to export.
        </p>
      )}
      {status.kind === "failed" && (
        <p className="export-error" role="alert" data-testid="export-error">
          The export could not be produced. Please try again.
        </p>
      )}
    </section>
  );
}

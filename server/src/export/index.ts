/**
 * Export module: the `ExportService` that produces a Markdown representation of
 * a workspace's current artifact content (Requirement 7).
 */

export {
  createExportService,
  extractExportedBody,
  EXPORT_REASON_TO_ERROR_CODE,
  ARTIFACT_BODY_SENTINEL,
  type ExportService,
  type ExportSource,
  type ExportSourceProvider,
  type ExportResult,
  type ExportSuccess,
  type ExportFailure,
} from "./ExportService.js";

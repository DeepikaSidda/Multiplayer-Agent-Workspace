/**
 * Workspace lifecycle module: creation and join-reference resolution built on
 * top of the durable {@link WorkspaceStore}.
 */

export {
  WorkspaceService,
  ARTIFACT_TEXT_FIELD,
  type CreateWorkspaceInput,
  type CreateWorkspaceResult,
  type JoinWorkspaceInput,
  type JoinWorkspaceResult,
  type WorkspaceServiceOptions,
} from "./WorkspaceService.js";

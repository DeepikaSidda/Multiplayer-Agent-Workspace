/**
 * WorkspaceService — workspace lifecycle and join-reference resolution.
 *
 * Implements the workspace-creation and join flows from the design document's
 * Room Manager / Workspace lifecycle, on top of the durable
 * {@link WorkspaceStore}:
 *
 *  - Create a workspace with a unique id and a shareable join reference that
 *    resolves back to that id, record the requesting human as the Owner, and
 *    initialize an artifact of the Owner-selected {@link ArtifactType} (default
 *    "plan") with empty content and an encoded (empty) Y.Doc state.
 *    Requirements 1.1, 1.3, 6.1, 6.2.
 *  - Resolve a join reference to a workspace and add a human participant
 *    idempotently (a reconnect with the same participant id upserts rather than
 *    duplicates), or report `WORKSPACE_NOT_FOUND` for an unknown reference.
 *    Requirements 1.4, 1.5, 1.6.
 *  - Surface `WORKSPACE_CREATE_FAILED` on a creation failure; because
 *    {@link WorkspaceStore.createWorkspace} is a single transactional insert,
 *    no workspace/owner/artifact rows are written on failure. Requirement 1.2.
 *
 * Expected failures (`WORKSPACE_NOT_FOUND`, `WORKSPACE_CREATE_FAILED`) are
 * returned as structured results rather than thrown, so the caller (the future
 * WebSocket gateway / Room Manager) can map them directly onto `error` events.
 */

import * as Y from "yjs";
import {
  DEFAULT_ARTIFACT_TYPE,
  isArtifactType,
  type ArtifactSnapshot,
  type ArtifactType,
  type Participant,
  type Workspace,
} from "@maw/shared";
import type { WorkspaceStore } from "../store/index.js";

/** The shared Y.Text field name used for the artifact document. */
export const ARTIFACT_TEXT_FIELD = "content";

/** Input for {@link WorkspaceService.createWorkspace}. */
export interface CreateWorkspaceInput {
  /** Display name of the requesting human, recorded as the Owner. */
  ownerDisplayName: string;
  /**
   * Owner-selected artifact type. May be any (untrusted) value; when it is not
   * one of the valid {@link ArtifactType} values the artifact defaults to
   * "plan" (Requirement 6.2).
   */
  artifactType?: unknown;
}

/** Result of a workspace-creation request. */
export type CreateWorkspaceResult =
  | { ok: true; workspace: Workspace; owner: Participant; artifact: ArtifactSnapshot }
  | { ok: false; error: "WORKSPACE_CREATE_FAILED"; message: string };

/** Input for {@link WorkspaceService.join}. */
export interface JoinWorkspaceInput {
  /** The shareable reference resolving to a workspace id. */
  joinReference: string;
  /** Display name of the joining human. */
  displayName: string;
  /**
   * Stable participant id. Supplying the same id on a reconnect makes the join
   * idempotent (upsert, no duplicate entry — Requirement 1.5). Omit for a
   * brand-new participant; a fresh id is generated.
   */
  participantId?: string;
}

/** Result of a join request. */
export type JoinWorkspaceResult =
  | { ok: true; workspace: Workspace; participant: Participant }
  | { ok: false; error: "WORKSPACE_NOT_FOUND"; message: string };

/**
 * Injectable dependencies, defaulted to production implementations. Overriding
 * `newId` / `newJoinReference` / `now` lets tests make creation deterministic.
 */
export interface WorkspaceServiceOptions {
  /** Generate a unique identifier (workspace/participant/artifact ids). */
  newId?: () => string;
  /** Generate a shareable join reference. */
  newJoinReference?: () => string;
  /** Current time in epoch milliseconds. */
  now?: () => number;
}

export class WorkspaceService {
  private readonly newId: () => string;
  private readonly newJoinReference: () => string;
  private readonly now: () => number;

  constructor(
    private readonly store: WorkspaceStore,
    options: WorkspaceServiceOptions = {},
  ) {
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.newJoinReference =
      options.newJoinReference ?? (() => crypto.randomUUID());
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Create a workspace with a unique id and a shareable join reference,
   * assign the requesting human as Owner, and initialize an empty artifact of
   * the (validated) Owner-selected type. Requirements 1.1, 1.2, 1.3, 6.1, 6.2.
   */
  async createWorkspace(
    input: CreateWorkspaceInput,
  ): Promise<CreateWorkspaceResult> {
    const now = this.now();
    const workspaceId = this.newId();
    const ownerId = this.newId();
    const artifactId = this.newId();
    const joinReference = this.newJoinReference();

    // Default to "plan" when the Owner-selected type is missing/invalid.
    const artifactType: ArtifactType = isArtifactType(input.artifactType)
      ? input.artifactType
      : DEFAULT_ARTIFACT_TYPE;

    const workspace: Workspace = {
      id: workspaceId,
      joinReference,
      ownerId,
      artifactId,
      createdAt: now,
    };

    const owner: Participant = {
      id: ownerId,
      workspaceId: workspaceId,
      type: "human",
      displayName: input.ownerDisplayName,
      joinedAt: now,
      presenceState: "active",
    };

    const artifact: ArtifactSnapshot = {
      id: artifactId,
      workspaceId: workspaceId,
      artifactType,
      content: "",
      lastEditorId: null,
      lastEditedAt: null,
      yjsState: emptyArtifactState(),
    };

    try {
      // Single transactional insert: on failure no rows are written and no
      // Owner is assigned (Requirement 1.2).
      await this.store.createWorkspace({ workspace, owner, artifact });
    } catch (err) {
      return {
        ok: false,
        error: "WORKSPACE_CREATE_FAILED",
        message: `Workspace creation failed: ${errorMessage(err)}`,
      };
    }

    return { ok: true, workspace, owner, artifact };
  }

  /**
   * Resolve a join reference and add a human participant idempotently, or
   * report `WORKSPACE_NOT_FOUND` for an unknown reference.
   * Requirements 1.4, 1.5, 1.6.
   */
  async join(input: JoinWorkspaceInput): Promise<JoinWorkspaceResult> {
    const workspace = await this.store.getWorkspaceByJoinRef(
      input.joinReference,
    );
    if (workspace === null) {
      return {
        ok: false,
        error: "WORKSPACE_NOT_FOUND",
        message: `No workspace found for the provided join reference.`,
      };
    }

    const participant: Participant = {
      // A reused id makes reconnect idempotent (upsert, no duplicate).
      id: input.participantId ?? this.newId(),
      workspaceId: workspace.id,
      type: "human",
      displayName: input.displayName,
      joinedAt: this.now(),
      presenceState: "active",
    };

    // `upsertParticipant` is idempotent by id, so rejoining as an existing
    // member leaves the participant set unchanged (Requirement 1.5).
    await this.store.upsertParticipant(workspace.id, participant);

    return { ok: true, workspace, participant };
  }

  /**
   * Resolve a join reference to its workspace id, or null when unknown.
   * Requirement 1.3 (the shareable reference resolves to exactly one id).
   */
  async resolveJoinReference(ref: string): Promise<string | null> {
    const workspace = await this.store.getWorkspaceByJoinRef(ref);
    return workspace?.id ?? null;
  }
}

/**
 * Encode the initial (empty) artifact CRDT state. A fresh `Y.Doc` with its
 * `Y.Text` field materialized encodes to the canonical empty-document update,
 * which durably restores to empty content on rejoin.
 */
function emptyArtifactState(): Uint8Array {
  const doc = new Y.Doc();
  // Materialize the shared text type so the field is present in the state.
  doc.getText(ARTIFACT_TEXT_FIELD);
  const state = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return state;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

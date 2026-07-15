/**
 * SQLite-backed {@link WorkspaceStore} using `better-sqlite3`.
 *
 * `better-sqlite3` is synchronous; each async method wraps a synchronous
 * prepared-statement call. Workspace creation uses a single `better-sqlite3`
 * transaction so the workspace, Owner participant, and initial artifact are
 * inserted atomically — a duplicate id/joinReference (or any other error)
 * rolls back all three inserts, leaving no partial rows (Requirement 1.2).
 *
 * The encoded Yjs CRDT state (`yjsState`, a `Uint8Array`) is stored as a BLOB
 * and round-trips byte-for-byte.
 */

import Database from "better-sqlite3";
import type {
  ArtifactSnapshot,
  ArtifactType,
  Message,
  MessageKind,
  Participant,
  ParticipantType,
  PresenceState,
  Workspace,
} from "@maw/shared";
import type { WorkspaceCreation, WorkspaceStore } from "./WorkspaceStore.js";

/** Row shape for the `workspaces` table. */
interface WorkspaceRow {
  id: string;
  joinReference: string;
  ownerId: string;
  artifactId: string;
  createdAt: number;
}

/** Row shape for the `participants` table. */
interface ParticipantRow {
  id: string;
  workspaceId: string;
  type: string;
  displayName: string;
  joinedAt: number;
  presenceState: string;
  persona: string | null;
  modelId: string | null;
}

/** Row shape for the `messages` table. */
interface MessageRow {
  id: string;
  workspaceId: string;
  senderId: string;
  senderType: string;
  senderName: string;
  content: string;
  timestamp: number;
  sequence: number;
  kind: string;
}

/** Row shape for the `artifact_snapshots` table. */
interface ArtifactRow {
  id: string;
  workspaceId: string;
  artifactType: string;
  content: string;
  lastEditorId: string | null;
  lastEditedAt: number | null;
  yjsState: Buffer;
}

export class SqliteWorkspaceStore implements WorkspaceStore {
  private readonly db: Database.Database;

  /**
   * @param filename Path to the SQLite database file. Defaults to `:memory:`
   *   for an ephemeral in-process database (handy for tests / dev).
   */
  constructor(filename = ":memory:") {
    this.db = new Database(filename);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  /** Create the schema if it does not yet exist. */
  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id            TEXT PRIMARY KEY,
        joinReference TEXT NOT NULL UNIQUE,
        ownerId       TEXT NOT NULL,
        artifactId    TEXT NOT NULL,
        createdAt     INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS participants (
        id            TEXT NOT NULL,
        workspaceId   TEXT NOT NULL,
        type          TEXT NOT NULL,
        displayName   TEXT NOT NULL,
        joinedAt      INTEGER NOT NULL,
        presenceState TEXT NOT NULL,
        persona       TEXT,
        modelId       TEXT,
        PRIMARY KEY (workspaceId, id)
      );

      CREATE TABLE IF NOT EXISTS messages (
        id          TEXT PRIMARY KEY,
        workspaceId TEXT NOT NULL,
        senderId    TEXT NOT NULL,
        senderType  TEXT NOT NULL,
        senderName  TEXT NOT NULL,
        content     TEXT NOT NULL,
        timestamp   INTEGER NOT NULL,
        sequence    INTEGER NOT NULL,
        kind        TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_order
        ON messages (workspaceId, timestamp, sequence);

      CREATE TABLE IF NOT EXISTS artifact_snapshots (
        workspaceId  TEXT PRIMARY KEY,
        id           TEXT NOT NULL,
        artifactType TEXT NOT NULL,
        content      TEXT NOT NULL,
        lastEditorId TEXT,
        lastEditedAt INTEGER,
        yjsState     BLOB NOT NULL
      );
    `);
  }

  async createWorkspace(creation: WorkspaceCreation): Promise<void> {
    const { workspace, owner, artifact } = creation;

    const insertWorkspace = this.db.prepare(
      `INSERT INTO workspaces (id, joinReference, ownerId, artifactId, createdAt)
       VALUES (@id, @joinReference, @ownerId, @artifactId, @createdAt)`,
    );
    const insertParticipant = this.db.prepare(
      `INSERT INTO participants
         (id, workspaceId, type, displayName, joinedAt, presenceState, persona, modelId)
       VALUES
         (@id, @workspaceId, @type, @displayName, @joinedAt, @presenceState, @persona, @modelId)`,
    );
    const insertArtifact = this.db.prepare(
      `INSERT INTO artifact_snapshots
         (workspaceId, id, artifactType, content, lastEditorId, lastEditedAt, yjsState)
       VALUES
         (@workspaceId, @id, @artifactType, @content, @lastEditorId, @lastEditedAt, @yjsState)`,
    );

    // A single transaction: all three inserts commit together or roll back
    // together, so a failure never leaves a partial workspace/owner row.
    const tx = this.db.transaction((c: WorkspaceCreation) => {
      insertWorkspace.run(c.workspace);
      insertParticipant.run(toParticipantRow(c.owner.workspaceId, c.owner));
      insertArtifact.run(toArtifactRow(c.artifact));
    });

    tx({ workspace, owner, artifact });
  }

  async getWorkspaceByJoinRef(ref: string): Promise<Workspace | null> {
    const row = this.db
      .prepare("SELECT * FROM workspaces WHERE joinReference = ?")
      .get(ref) as WorkspaceRow | undefined;
    return row ? rowToWorkspace(row) : null;
  }

  async workspaceExists(id: string): Promise<boolean> {
    const row = this.db
      .prepare("SELECT 1 FROM workspaces WHERE id = ?")
      .get(id);
    return row !== undefined;
  }

  async appendMessage(m: Message): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO messages
           (id, workspaceId, senderId, senderType, senderName, content, timestamp, sequence, kind)
         VALUES
           (@id, @workspaceId, @senderId, @senderType, @senderName, @content, @timestamp, @sequence, @kind)`,
      )
      .run(m);
  }

  async loadMessages(workspaceId: string): Promise<Message[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE workspaceId = ?
         ORDER BY timestamp ASC, sequence ASC`,
      )
      .all(workspaceId) as MessageRow[];
    return rows.map(rowToMessage);
  }

  async saveArtifactSnapshot(a: ArtifactSnapshot): Promise<void> {
    // One artifact per workspace: replace any existing snapshot.
    this.db
      .prepare(
        `INSERT INTO artifact_snapshots
           (workspaceId, id, artifactType, content, lastEditorId, lastEditedAt, yjsState)
         VALUES
           (@workspaceId, @id, @artifactType, @content, @lastEditorId, @lastEditedAt, @yjsState)
         ON CONFLICT(workspaceId) DO UPDATE SET
           id           = excluded.id,
           artifactType = excluded.artifactType,
           content      = excluded.content,
           lastEditorId = excluded.lastEditorId,
           lastEditedAt = excluded.lastEditedAt,
           yjsState     = excluded.yjsState`,
      )
      .run(toArtifactRow(a));
  }

  async loadArtifact(workspaceId: string): Promise<ArtifactSnapshot | null> {
    const row = this.db
      .prepare("SELECT * FROM artifact_snapshots WHERE workspaceId = ?")
      .get(workspaceId) as ArtifactRow | undefined;
    return row ? rowToArtifact(row) : null;
  }

  async upsertParticipant(workspaceId: string, p: Participant): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO participants
           (id, workspaceId, type, displayName, joinedAt, presenceState, persona, modelId)
         VALUES
           (@id, @workspaceId, @type, @displayName, @joinedAt, @presenceState, @persona, @modelId)
         ON CONFLICT(workspaceId, id) DO UPDATE SET
           type          = excluded.type,
           displayName   = excluded.displayName,
           joinedAt      = excluded.joinedAt,
           presenceState = excluded.presenceState,
           persona       = excluded.persona,
           modelId       = excluded.modelId`,
      )
      .run(toParticipantRow(workspaceId, p));
  }

  async removeParticipant(
    workspaceId: string,
    participantId: string,
  ): Promise<void> {
    this.db
      .prepare("DELETE FROM participants WHERE workspaceId = ? AND id = ?")
      .run(workspaceId, participantId);
  }

  async loadParticipants(workspaceId: string): Promise<Participant[]> {
    const rows = this.db
      .prepare("SELECT * FROM participants WHERE workspaceId = ?")
      .all(workspaceId) as ParticipantRow[];
    return rows.map(rowToParticipant);
  }

  /** Close the underlying database connection. */
  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Row <-> domain mapping helpers
// ---------------------------------------------------------------------------

function toParticipantRow(
  workspaceId: string,
  p: Participant,
): ParticipantRow {
  return {
    id: p.id,
    workspaceId,
    type: p.type,
    displayName: p.displayName,
    joinedAt: p.joinedAt,
    presenceState: p.presenceState,
    persona: p.persona ?? null,
    modelId: p.modelId ?? null,
  };
}

function rowToParticipant(row: ParticipantRow): Participant {
  const p: Participant = {
    id: row.id,
    workspaceId: row.workspaceId,
    type: row.type as ParticipantType,
    displayName: row.displayName,
    joinedAt: row.joinedAt,
    presenceState: row.presenceState as PresenceState,
  };
  // Omit agent-only fields when null so rows round-trip to the domain shape.
  if (row.persona !== null) p.persona = row.persona;
  if (row.modelId !== null) p.modelId = row.modelId;
  return p;
}

function toArtifactRow(a: ArtifactSnapshot): ArtifactRow {
  return {
    id: a.id,
    workspaceId: a.workspaceId,
    artifactType: a.artifactType,
    content: a.content,
    lastEditorId: a.lastEditorId,
    lastEditedAt: a.lastEditedAt,
    // Copy into a Buffer for BLOB storage.
    yjsState: Buffer.from(a.yjsState),
  };
}

function rowToWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    joinReference: row.joinReference,
    ownerId: row.ownerId,
    artifactId: row.artifactId,
    createdAt: row.createdAt,
  };
}

function rowToMessage(row: MessageRow): Message {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    senderId: row.senderId,
    senderType: row.senderType as ParticipantType,
    senderName: row.senderName,
    content: row.content,
    timestamp: row.timestamp,
    sequence: row.sequence,
    kind: row.kind as MessageKind,
  };
}

function rowToArtifact(row: ArtifactRow): ArtifactSnapshot {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    artifactType: row.artifactType as ArtifactType,
    content: row.content,
    lastEditorId: row.lastEditorId,
    lastEditedAt: row.lastEditedAt,
    // Copy the BLOB bytes into a fresh Uint8Array so the CRDT state round-trips.
    yjsState: new Uint8Array(row.yjsState),
  };
}

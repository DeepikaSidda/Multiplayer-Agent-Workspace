/**
 * DynamoDB-backed {@link WorkspaceStore}.
 *
 * A single DynamoDB table stores every entity using a composite key:
 *   - PK = `WS#<workspaceId>`
 *   - SK = `META` (workspace) | `ARTIFACT` | `PART#<participantId>` | `MSG#<paddedSequence>`
 *
 * A global secondary index (`GSI1`) resolves a shareable join reference to its
 * workspace: GSI1PK = `REF#<joinReference>`, GSI1SK = `META`.
 *
 * Workspace creation writes the workspace, Owner participant, and initial
 * artifact in a single `TransactWriteItems` call guarded by
 * `attribute_not_exists(PK)`, so a duplicate id (or any failure) leaves the
 * table unchanged — matching the atomic-create contract (Requirement 1.2).
 *
 * The encoded Yjs CRDT state (`yjsState`) is stored as a DynamoDB Binary
 * (`Uint8Array`) and round-trips byte-for-byte.
 *
 * This store is durable and independent of the compute instance: the data
 * survives container restarts, redeploys, and instance replacement.
 */

import {
  DynamoDBClient,
  type DynamoDBClientConfig,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
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

const META_SK = "META";
const ARTIFACT_SK = "ARTIFACT";
const PART_PREFIX = "PART#";
const MSG_PREFIX = "MSG#";

function wsPk(workspaceId: string): string {
  return `WS#${workspaceId}`;
}
function refPk(joinReference: string): string {
  return `REF#${joinReference}`;
}
function partSk(participantId: string): string {
  return `${PART_PREFIX}${participantId}`;
}
/**
 * A message's storage key is derived from its UNIQUE id (not its sequence), so
 * two messages can never collide on the same key and a stored message can never
 * be overwritten — even if a per-workspace sequence counter were ever reset.
 * Ordering is handled at read time by sorting on (timestamp, sequence).
 */
function msgSk(messageId: string): string {
  return `${MSG_PREFIX}${messageId}`;
}

export interface DynamoWorkspaceStoreOptions {
  /** DynamoDB table name. Defaults to `MAW_DYNAMO_TABLE` env or `maw`. */
  tableName?: string;
  /** GSI name for join-reference lookups. Defaults to `GSI1`. */
  indexName?: string;
  /** Optional pre-built document client (tests can inject a fake). */
  documentClient?: DynamoDBDocumentClient;
  /** Client config (region, endpoint) when constructing the default client. */
  clientConfig?: DynamoDBClientConfig;
}

export class DynamoWorkspaceStore implements WorkspaceStore {
  private readonly doc: DynamoDBDocumentClient;
  private readonly table: string;
  private readonly index: string;

  constructor(options: DynamoWorkspaceStoreOptions = {}) {
    this.table = options.tableName ?? "maw";
    this.index = options.indexName ?? "GSI1";
    if (options.documentClient) {
      this.doc = options.documentClient;
    } else {
      const client = new DynamoDBClient(options.clientConfig ?? {});
      this.doc = DynamoDBDocumentClient.from(client, {
        marshallOptions: { removeUndefinedValues: true },
      });
    }
  }

  async createWorkspace(creation: WorkspaceCreation): Promise<void> {
    const { workspace, owner, artifact } = creation;
    await this.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.table,
              Item: workspaceItem(workspace),
              // No partial create: fail if this workspace already exists.
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
          {
            Put: {
              TableName: this.table,
              Item: participantItem(owner.workspaceId, owner),
            },
          },
          {
            Put: {
              TableName: this.table,
              Item: artifactItem(artifact),
            },
          },
        ],
      }),
    );
  }

  async getWorkspaceByJoinRef(ref: string): Promise<Workspace | null> {
    const result = await this.doc.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: this.index,
        KeyConditionExpression: "GSI1PK = :pk AND GSI1SK = :sk",
        ExpressionAttributeValues: { ":pk": refPk(ref), ":sk": META_SK },
        Limit: 1,
      }),
    );
    const item = result.Items?.[0];
    return item ? itemToWorkspace(item) : null;
  }

  async workspaceExists(id: string): Promise<boolean> {
    const result = await this.doc.send(
      new GetCommand({
        TableName: this.table,
        Key: { PK: wsPk(id), SK: META_SK },
        ProjectionExpression: "PK",
      }),
    );
    return result.Item !== undefined;
  }

  async appendMessage(m: Message): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.table,
        Item: messageItem(m),
        // Never overwrite an existing message at this key (id-based, unique).
        ConditionExpression: "attribute_not_exists(SK)",
      }),
    );
  }

  async loadMessages(workspaceId: string): Promise<Message[]> {
    const items = await this.queryAll(workspaceId, MSG_PREFIX);
    const messages = items.map(itemToMessage);
    // Present in total (timestamp, sequence) order (Requirements 3.4, 8.5).
    messages.sort((a, b) =>
      a.timestamp !== b.timestamp
        ? a.timestamp - b.timestamp
        : a.sequence - b.sequence,
    );
    return messages;
  }

  async saveArtifactSnapshot(a: ArtifactSnapshot): Promise<void> {
    await this.doc.send(
      new PutCommand({ TableName: this.table, Item: artifactItem(a) }),
    );
  }

  async loadArtifact(workspaceId: string): Promise<ArtifactSnapshot | null> {
    const result = await this.doc.send(
      new GetCommand({
        TableName: this.table,
        Key: { PK: wsPk(workspaceId), SK: ARTIFACT_SK },
      }),
    );
    return result.Item ? itemToArtifact(result.Item) : null;
  }

  async upsertParticipant(workspaceId: string, p: Participant): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.table,
        Item: participantItem(workspaceId, p),
      }),
    );
  }

  async loadParticipants(workspaceId: string): Promise<Participant[]> {
    const items = await this.queryAll(workspaceId, PART_PREFIX);
    return items.map(itemToParticipant);
  }

  async removeParticipant(
    workspaceId: string,
    participantId: string,
  ): Promise<void> {
    await this.doc.send(
      new DeleteCommand({
        TableName: this.table,
        Key: { PK: wsPk(workspaceId), SK: partSk(participantId) },
      }),
    );
  }

  /** Query every item under a workspace whose SK begins with `prefix`. */
  private async queryAll(
    workspaceId: string,
    prefix: string,
  ): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let lastKey: Record<string, unknown> | undefined;
    do {
      const result = await this.doc.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
          ExpressionAttributeValues: { ":pk": wsPk(workspaceId), ":prefix": prefix },
          ExclusiveStartKey: lastKey,
          // Strongly consistent so a join snapshot always reflects the latest
          // committed messages/participants (no eventual-consistency lag).
          ConsistentRead: true,
        }),
      );
      if (result.Items) items.push(...result.Items);
      lastKey = result.LastEvaluatedKey;
    } while (lastKey);
    return items;
  }
}

// ---------------------------------------------------------------------------
// Item <-> domain mapping helpers
// ---------------------------------------------------------------------------

function workspaceItem(w: Workspace): Record<string, unknown> {
  return {
    PK: wsPk(w.id),
    SK: META_SK,
    GSI1PK: refPk(w.joinReference),
    GSI1SK: META_SK,
    id: w.id,
    joinReference: w.joinReference,
    ownerId: w.ownerId,
    artifactId: w.artifactId,
    createdAt: w.createdAt,
  };
}

function itemToWorkspace(item: Record<string, unknown>): Workspace {
  return {
    id: String(item.id),
    joinReference: String(item.joinReference),
    ownerId: String(item.ownerId),
    artifactId: String(item.artifactId),
    createdAt: Number(item.createdAt),
  };
}

function participantItem(
  workspaceId: string,
  p: Participant,
): Record<string, unknown> {
  return {
    PK: wsPk(workspaceId),
    SK: partSk(p.id),
    id: p.id,
    workspaceId,
    type: p.type,
    displayName: p.displayName,
    joinedAt: p.joinedAt,
    presenceState: p.presenceState,
    persona: p.persona ?? undefined,
    modelId: p.modelId ?? undefined,
  };
}

function itemToParticipant(item: Record<string, unknown>): Participant {
  const p: Participant = {
    id: String(item.id),
    workspaceId: String(item.workspaceId),
    type: item.type as ParticipantType,
    displayName: String(item.displayName),
    joinedAt: Number(item.joinedAt),
    presenceState: item.presenceState as PresenceState,
  };
  if (typeof item.persona === "string") p.persona = item.persona;
  if (typeof item.modelId === "string") p.modelId = item.modelId;
  return p;
}

function messageItem(m: Message): Record<string, unknown> {
  return {
    PK: wsPk(m.workspaceId),
    SK: msgSk(m.id),
    id: m.id,
    workspaceId: m.workspaceId,
    senderId: m.senderId,
    senderType: m.senderType,
    senderName: m.senderName,
    content: m.content,
    timestamp: m.timestamp,
    sequence: m.sequence,
    kind: m.kind,
  };
}

function itemToMessage(item: Record<string, unknown>): Message {
  return {
    id: String(item.id),
    workspaceId: String(item.workspaceId),
    senderId: String(item.senderId),
    senderType: item.senderType as ParticipantType,
    senderName: String(item.senderName),
    content: String(item.content),
    timestamp: Number(item.timestamp),
    sequence: Number(item.sequence),
    kind: item.kind as MessageKind,
  };
}

function artifactItem(a: ArtifactSnapshot): Record<string, unknown> {
  return {
    PK: wsPk(a.workspaceId),
    SK: ARTIFACT_SK,
    id: a.id,
    workspaceId: a.workspaceId,
    artifactType: a.artifactType,
    content: a.content,
    lastEditorId: a.lastEditorId ?? undefined,
    lastEditedAt: a.lastEditedAt ?? undefined,
    // Stored as a DynamoDB Binary; copy into a fresh Uint8Array.
    yjsState: Uint8Array.from(a.yjsState),
  };
}

function itemToArtifact(item: Record<string, unknown>): ArtifactSnapshot {
  const raw = item.yjsState;
  const yjsState =
    raw instanceof Uint8Array
      ? new Uint8Array(raw)
      : new Uint8Array(0);
  return {
    id: String(item.id),
    workspaceId: String(item.workspaceId),
    artifactType: item.artifactType as ArtifactType,
    content: String(item.content),
    lastEditorId: typeof item.lastEditorId === "string" ? item.lastEditorId : null,
    lastEditedAt: typeof item.lastEditedAt === "number" ? item.lastEditedAt : null,
    yjsState,
  };
}

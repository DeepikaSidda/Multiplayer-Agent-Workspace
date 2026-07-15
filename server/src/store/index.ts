/**
 * Persistence store module: the `WorkspaceStore` interface and its
 * implementations (SQLite, in-memory, and a failure-injecting decorator).
 */

export type { WorkspaceStore, WorkspaceCreation } from "./WorkspaceStore.js";
export { SqliteWorkspaceStore } from "./SqliteWorkspaceStore.js";
export {
  DynamoWorkspaceStore,
  type DynamoWorkspaceStoreOptions,
} from "./DynamoWorkspaceStore.js";
export { InMemoryWorkspaceStore } from "./InMemoryWorkspaceStore.js";
export {
  FailureInjectingWorkspaceStore,
  InjectedPersistenceError,
  type StoreOperation,
} from "./FailureInjectingWorkspaceStore.js";

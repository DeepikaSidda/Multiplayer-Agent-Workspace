/**
 * Room module: the `RoomManager` that owns per-workspace in-memory room state
 * (participant roster, presence map, authoritative Y.Doc, message sequence),
 * composes the pure services, and serializes state-changing operations per room.
 */

export {
  RoomManager,
  type AddAgentInput,
  type AddAgentResult,
  type RemoveAgentResult,
  type RoomManagerOptions,
  type AgentResponseResult,
  type AgentResponseHooks,
  type AgentArtifactEdit,
} from "./RoomManager.js";

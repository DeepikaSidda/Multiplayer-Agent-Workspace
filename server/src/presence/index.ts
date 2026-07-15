/**
 * Presence module: the `PresenceService` that tracks participant presence,
 * heartbeat-based disconnect reaping, and active-count reporting.
 */

export {
  PresenceService,
  participantCountUpdate,
  DISCONNECT_GRACE_MS,
  HEARTBEAT_INTERVAL_MS,
  type PresenceParticipant,
  type PresenceEntry,
  type PresenceChange,
} from "./PresenceService.js";

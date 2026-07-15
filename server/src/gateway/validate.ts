/**
 * Schema validation for inbound WebSocket envelopes.
 *
 * All inbound payloads are untrusted (design: "the transport boundary; all
 * inbound event payloads are treated as untrusted and validated before use").
 * Every frame is parsed and structurally validated against the
 * {@link ClientToServerEvent} contract here; a malformed frame yields
 * `{ ok: false }` so the gateway can drop it with a `MALFORMED_EVENT` error and
 * never mutate room state.
 *
 * Validation is purely structural (shape + primitive types). Domain validation
 * — message length/whitespace, artifact size, agent capacity — is enforced by
 * the services the gateway routes to, so it is intentionally not duplicated
 * here.
 */

import type { ClientToServerEvent } from "@maw/shared";

/** Result of validating a raw inbound frame. */
export type EnvelopeValidation =
  | { ok: true; event: ClientToServerEvent }
  | { ok: false };

/** True for a non-null, non-array object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** Validate the per-type payload shape, returning the typed event or null. */
function validatePayload(
  type: string,
  workspaceId: string,
  payload: Record<string, unknown>,
): ClientToServerEvent | null {
  switch (type) {
    case "join":
      if (!isString(payload.joinReference) || !isString(payload.displayName)) {
        return null;
      }
      // participantId is optional but must be a string when present.
      if (payload.participantId !== undefined && !isString(payload.participantId)) {
        return null;
      }
      return {
        type,
        workspaceId,
        payload: {
          joinReference: payload.joinReference,
          displayName: payload.displayName,
          ...(payload.participantId !== undefined
            ? { participantId: payload.participantId }
            : {}),
        },
      };

    case "sendMessage":
      return isString(payload.content)
        ? { type, workspaceId, payload: { content: payload.content } }
        : null;

    case "artifactUpdate":
      return isString(payload.yjsUpdate)
        ? { type, workspaceId, payload: { yjsUpdate: payload.yjsUpdate } }
        : null;

    case "addAgent":
      if (!isString(payload.displayName)) return null;
      // persona is optional but must be a string when present.
      if (payload.persona !== undefined && !isString(payload.persona)) {
        return null;
      }
      return {
        type,
        workspaceId,
        payload: {
          displayName: payload.displayName,
          ...(payload.persona !== undefined
            ? { persona: payload.persona }
            : {}),
        },
      };

    case "removeAgent":
      return isString(payload.agentId)
        ? { type, workspaceId, payload: { agentId: payload.agentId } }
        : null;

    case "leave":
      return { type, workspaceId, payload: {} };

    case "export":
      return { type, workspaceId, payload: {} };

    default:
      // Unknown event type.
      return null;
  }
}

/**
 * Parse and structurally validate a raw inbound frame against the
 * {@link ClientToServerEvent} contract. Returns the typed event on success, or
 * `{ ok: false }` for any malformed input (invalid JSON, missing/mistyped
 * `type`/`workspaceId`/`payload`, unknown type, or a payload that does not
 * match its event's shape).
 */
export function validateEnvelope(raw: string): EnvelopeValidation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false };
  }

  if (!isObject(parsed)) return { ok: false };
  if (!isString(parsed.type)) return { ok: false };
  if (!isString(parsed.workspaceId)) return { ok: false };
  if (!isObject(parsed.payload)) return { ok: false };

  const event = validatePayload(parsed.type, parsed.workspaceId, parsed.payload);
  return event ? { ok: true, event } : { ok: false };
}

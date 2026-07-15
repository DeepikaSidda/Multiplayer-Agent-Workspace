/**
 * WebSocket gateway module — the transport boundary that validates inbound
 * envelopes and routes typed client events to the Room Manager and services,
 * emitting server events back to the room. See {@link WebSocketGateway}.
 */

export {
  WebSocketGateway,
  type WebSocketGatewayDeps,
  type WebSocketGatewayOptions,
  type HeartbeatScheduler,
} from "./WebSocketGateway.js";
export {
  type GatewayConnection,
  type MessageHandler,
  wsConnection,
  FakeConnection,
} from "./Connection.js";
export { validateEnvelope, type EnvelopeValidation } from "./validate.js";
export { bytesToBase64, base64ToBytes, isBase64 } from "./codec.js";

/**
 * Transport abstraction for the WebSocket gateway.
 *
 * The gateway core (envelope validation, routing, broadcast, snapshot building,
 * heartbeat) is written against the minimal {@link GatewayConnection} interface
 * rather than the concrete `ws` `WebSocket`. This keeps the core unit-testable
 * with in-memory {@link FakeConnection}s (no real network, no timers) while the
 * production adapter {@link wsConnection} makes a real `ws` socket satisfy the
 * same interface.
 *
 * The interface is intentionally tiny: text send, close, heartbeat ping, and
 * registration of the three inbound events the gateway cares about — `message`,
 * `close`, and `pong`.
 */

import type { WebSocket } from "ws";

/** A handler for an inbound text frame. May be async; the gateway awaits it. */
export type MessageHandler = (data: string) => void | Promise<void>;

/**
 * The minimal socket surface the gateway depends on. A real `ws.WebSocket`
 * satisfies this via {@link wsConnection}; tests use {@link FakeConnection}.
 */
export interface GatewayConnection {
  /** Send a serialized (JSON) envelope as a text frame. */
  send(data: string): void;
  /** Close the connection (graceful). */
  close(): void;
  /** Send a heartbeat ping frame for liveness detection. */
  ping(): void;
  /** Register the inbound text-frame handler. */
  onMessage(handler: MessageHandler): void;
  /** Register the connection-closed handler. */
  onClose(handler: () => void): void;
  /** Register the pong (heartbeat reply) handler. */
  onPong(handler: () => void): void;
}

/**
 * Adapt a real `ws` {@link WebSocket} to the {@link GatewayConnection}
 * interface. Inbound binary/buffer frames are coerced to a UTF-8 string; the
 * async message handler's promise is intentionally not awaited here (the socket
 * event emitter is synchronous), so a rejection is swallowed to avoid an
 * unhandled rejection.
 */
export function wsConnection(socket: WebSocket): GatewayConnection {
  return {
    send: (data) => socket.send(data),
    close: () => socket.close(),
    ping: () => socket.ping(),
    onMessage: (handler) => {
      socket.on("message", (raw: unknown) => {
        void Promise.resolve(handler(String(raw))).catch(() => {});
      });
    },
    onClose: (handler) => {
      socket.on("close", () => handler());
    },
    onPong: (handler) => {
      socket.on("pong", () => handler());
    },
  };
}

/**
 * In-memory {@link GatewayConnection} for tests. Captures everything the gateway
 * sends (parsed back into objects for easy assertions) and lets a test drive
 * inbound events (`receive`, `receiveRaw`, `pong`, `triggerClose`).
 */
export class FakeConnection implements GatewayConnection {
  /** Every envelope the gateway sent to this connection, parsed. */
  readonly sent: unknown[] = [];
  /** Number of heartbeat pings the gateway issued to this connection. */
  pingCount = 0;
  /** Whether the gateway closed this connection. */
  closed = false;

  private messageHandler?: MessageHandler;
  private closeHandler?: () => void;
  private pongHandler?: () => void;

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.closed = true;
    this.closeHandler?.();
  }

  ping(): void {
    this.pingCount += 1;
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  onPong(handler: () => void): void {
    this.pongHandler = handler;
  }

  // --- test drivers -------------------------------------------------------

  /** Deliver a structured envelope; returns the gateway's processing promise. */
  receive(event: unknown): void | Promise<void> {
    return this.messageHandler?.(JSON.stringify(event));
  }

  /** Deliver a raw (possibly malformed) frame; returns the processing promise. */
  receiveRaw(raw: string): void | Promise<void> {
    return this.messageHandler?.(raw);
  }

  /** Simulate a heartbeat pong reply from the peer. */
  pong(): void {
    this.pongHandler?.();
  }

  /** Simulate an unexpected socket close from the peer. */
  triggerClose(): void {
    this.closeHandler?.();
  }

  /** All captured envelopes of a given `type`. */
  ofType<T = Record<string, unknown>>(type: string): T[] {
    return this.sent.filter(
      (e): e is T =>
        typeof e === "object" &&
        e !== null &&
        (e as { type?: unknown }).type === type,
    );
  }

  /** The most recently captured envelope, if any. */
  last(): unknown {
    return this.sent[this.sent.length - 1];
  }
}

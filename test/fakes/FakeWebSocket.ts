import { EventEmitter } from "events";
import { Timer } from "../../src/utils/SystemTimer";
import { defaultTimer } from "../../src/utils/SystemTimer";

/**
 * WebSocket states as defined by the WebSocket API
 */
export enum WebSocketState {
  CONNECTING = 0,
  OPEN = 1,
  CLOSING = 2,
  CLOSED = 3,
}

/**
 * Whether ping() replies with a pong on this fake socket. "auto" models a
 * peer that answers protocol pings (both real runners do — see issue #7554);
 * "withhold" models a wedged peer whose TCP connection stays open but never
 * responds, the failure mode the liveness probe exists to catch.
 */
export type PongMode = "auto" | "withhold";

/**
 * Fake WebSocket implementation for testing
 * Allows simulating instant connection failures without waiting for timeout
 */
export class FakeWebSocket
  extends EventEmitter
  implements Pick<WebSocket, "readyState" | "send" | "close" | "ping" | "terminate">
{
  public readyState: WebSocketState = WebSocketState.CONNECTING;
  private failureMode: "instant" | "timeout" | "none";
  private connectTimeoutMs: number = 0;
  private timer: Timer;
  private pongMode: PongMode;

  constructor(
    url: string,
    failureMode: "instant" | "timeout" | "none" = "none",
    connectTimeoutMs: number = 0,
    timer: Timer = defaultTimer,
    pongMode: PongMode = "auto",
  ) {
    super();
    this.failureMode = failureMode;
    this.connectTimeoutMs = connectTimeoutMs;
    this.timer = timer;
    this.pongMode = pongMode;

    // For success mode with no delay, emit open synchronously after constructor returns
    // This ensures the "open" event fires before any FakeTimer.setTimeout with autoAdvance
    // can schedule its timeout callback via setImmediate
    if (this.failureMode === "none" && this.connectTimeoutMs === 0) {
      // Use queueMicrotask to emit after constructor returns but before setImmediate callbacks
      queueMicrotask(() => {
        this.handleConnection();
      });
    } else {
      // For failure modes or delayed connections, use setImmediate
      setImmediate(() => {
        this.handleConnection();
      });
    }
  }

  private handleConnection(): void {
    if (this.failureMode === "instant") {
      // Fail instantly
      this.readyState = WebSocketState.CLOSED;
      this.emit("error", new Error("Connection refused"));
      this.emit("close");
    } else if (this.failureMode === "timeout") {
      // Simulate timeout after specified duration
      this.timer.setTimeout(() => {
        if (this.readyState === WebSocketState.CONNECTING) {
          this.readyState = WebSocketState.CLOSED;
          this.emit("error", new Error("Connection timeout"));
          this.emit("close");
        }
      }, this.connectTimeoutMs);
    } else {
      // Success case
      this.readyState = WebSocketState.OPEN;
      this.emit("open");
    }
  }

  send(data: any): void {
    if (this.readyState !== WebSocketState.OPEN) {
      throw new Error("WebSocket is not open");
    }
    // In fake mode, we don't actually send data
  }

  close(): void {
    if (this.readyState === WebSocketState.OPEN || this.readyState === WebSocketState.CONNECTING) {
      this.readyState = WebSocketState.CLOSING;
      // Use setImmediate for 0-delay close to work with FakeTimer
      setImmediate(() => {
        this.readyState = WebSocketState.CLOSED;
        this.emit("close");
      });
    }
  }

  // Real `ws` terminate() forcibly ends the connection without a close
  // handshake. Modeled the same way `close()` is: flip state and emit "close"
  // on the next tick so it still composes with FakeTimer-driven test flows.
  terminate(): void {
    if (this.readyState !== WebSocketState.CLOSED) {
      this.readyState = WebSocketState.CLOSED;
      setImmediate(() => {
        this.emit("close");
      });
    }
  }

  // Real `ws` ping() sends a protocol-level ping frame; a cooperative peer
  // replies with "pong". Only emits when `pongMode` is "auto" — "withhold"
  // models the wedged-peer failure mode the liveness probe (#7554) detects.
  ping(): void {
    if (this.readyState !== WebSocketState.OPEN || this.pongMode !== "auto") {
      return;
    }
    setImmediate(() => {
      if (this.readyState === WebSocketState.OPEN) {
        this.emit("pong");
      }
    });
  }

  // Method to simulate receiving a message from server
  simulateMessage(data: any): void {
    if (this.readyState === WebSocketState.OPEN) {
      this.emit("message", data);
    }
  }

  // Models the peer sending its own protocol-level ping (e.g. the Android
  // Ktor CtrlProxy server's `pingPeriod`), independent of anything the host
  // sent. Real `ws` auto-pongs these but still surfaces a "ping" event.
  simulatePing(): void {
    if (this.readyState === WebSocketState.OPEN) {
      this.emit("ping");
    }
  }
}

/**
 * Factory function that creates FakeWebSockets configured to fail instantly
 * This is useful for testing connection failure scenarios without waiting for timeouts
 */
export function createInstantFailureWebSocketFactory(
  timer?: Timer,
): (url: string) => FakeWebSocket {
  return (url: string) => new FakeWebSocket(url, "instant", 0, timer);
}

/**
 * Factory function that creates FakeWebSockets that connect successfully
 * This is useful for testing normal operation scenarios
 */
export function createSuccessWebSocketFactory(
  timer?: Timer,
  pongMode: PongMode = "auto",
): (url: string) => FakeWebSocket {
  return (url: string) => new FakeWebSocket(url, "none", 0, timer, pongMode);
}

/**
 * Factory that fails the first N-1 attempts and succeeds on the Nth.
 * Useful for testing recovery after cooldown.
 */
export function createNthAttemptSuccessWebSocketFactory(
  successOnAttempt: number,
  timer?: Timer,
): (url: string) => FakeWebSocket {
  let attempt = 0;
  return (url: string) => {
    attempt++;
    return new FakeWebSocket(url, attempt >= successOnAttempt ? "none" : "instant", 0, timer);
  };
}

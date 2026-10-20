import type WebSocket from "ws";
import type { Timer } from "../../utils/SystemTimer";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { CtrlSocket } from "./shared/types";
export interface WebSocketHandshakeHost {
  readonly timer: Timer;
  readonly connectionTimeoutMs: number;
  readonly logTag: string;
  createSocket(url: string): CtrlSocket;
  getLifecycleSocket(): CtrlSocket | null;
  setLifecycleSocket(socket: CtrlSocket | null): void;
  clearLifecycleSocket(socket: CtrlSocket): void;
  getSocket(): CtrlSocket | null;
  getConnectionGeneration(): number;
  setPendingConnectAbort(pending: { socket: CtrlSocket; abort: () => void }): void;
  clearPendingConnectAbort(socket: CtrlSocket): void;
  setConnecting(connecting: boolean): void;
  onConnectAttemptFailed(): void;
  onSocketOpened(socket: CtrlSocket): void;
  markLivenessSeen(): void;
  handleMessage(data: WebSocket.Data): void | Promise<void>;
  finishEstablishedConnection(socket: CtrlSocket): void;
}
/** Owns listeners and the deadline for one socket handshake. */
export class WebSocketHandshake {
  constructor(private readonly host: WebSocketHandshakeHost) {}
  open(wsUrl: string, generation: number): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      const ws = this.host.createSocket(wsUrl);
      let opened = false;
      this.host.setLifecycleSocket(ws);
      const connectionTimeout = this.host.timer.setTimeout(() => {
        this.host.clearPendingConnectAbort(ws);
        this.host.clearLifecycleSocket(ws);
        ws.close();
        reject(new Error("WebSocket connection timeout"));
      }, this.host.connectionTimeoutMs);

      // Track this in-flight handshake so a generation change
      // (close()/updatePort()) can abort it eagerly. A socket stuck in
      // CONNECTING emits neither "open" nor "error", so the generation
      // guard in the handlers below would never run for it. (#5656)
      this.host.setPendingConnectAbort({
        socket: ws,
        abort: () => {
          this.host.timer.clearTimeout(connectionTimeout);
          // Detach lifecycle listeners before closing so the aborted
          // socket's delayed close/error cannot mutate state for the
          // replacement connect; keep a lone swallowing error listener so a
          // mid-handshake error cannot throw and crash the daemon.
          this.host.clearLifecycleSocket(ws);
          this.discardSocket(ws, "aborted");
          this.host.setConnecting(false);
          this.host.onConnectAttemptFailed();
          resolve(false);
        },
      });

      ws.on("open", () => {
        this.host.clearPendingConnectAbort(ws);
        this.host.timer.clearTimeout(connectionTimeout);
        if (generation !== this.host.getConnectionGeneration()) {
          // close() or updatePort() ran while this connection was mid-handshake.
          // Detach this socket's listeners BEFORE closing it, then discard it.
          // A replacement connect (e.g. to a new port after updatePort) may
          // already be live; without detaching, this socket's still-attached
          // close/error handlers would fire on its delayed close-handshake and
          // null out the live socket, stop the replacement's health check, and schedule
          // a spurious reconnect. Removing the listeners makes that a no-op.
          logger.info(`[${this.host.logTag}] Discarding WebSocket opened after close`);
          this.host.clearLifecycleSocket(ws);
          this.discardSocket(ws, "discarded");
          this.host.setConnecting(false);
          resolve(false);
          return;
        }
        logger.info(`[${this.host.logTag}] WebSocket connected successfully`);
        opened = true;
        this.host.onSocketOpened(ws);
        resolve(true);
      });

      ws.on("message", (data: WebSocket.Data) => {
        if (this.host.getSocket() !== ws) {
          return;
        }
        // Any inbound frame proves the peer is alive, independent of
        // whether it happens to be a pong reply (#7554).
        this.host.markLivenessSeen();
        void this.host.handleMessage(data);
      });

      ws.on("pong", () => {
        if (this.host.getSocket() === ws) {
          this.host.markLivenessSeen();
        }
      });

      // The Android Ktor CtrlProxy server pings the host every 15s
      // (WebSocketServer.kt `pingPeriod`); `ws` auto-pongs those but
      // still surfaces them as a "ping" event on this side. That is a
      // free proof of life independent of the host's own probe (#7554).
      ws.on("ping", () => {
        if (this.host.getSocket() === ws) {
          this.host.markLivenessSeen();
        }
      });

      ws.on("error", (error) => {
        if (opened || this.host.getLifecycleSocket() !== ws) {
          logger.warn(`[${this.host.logTag}] WebSocket error: ${error.message}`);
          return;
        }
        this.host.clearPendingConnectAbort(ws);
        this.host.clearLifecycleSocket(ws);
        this.host.timer.clearTimeout(connectionTimeout);
        logger.warn(`[${this.host.logTag}] WebSocket error: ${error.message}`);
        this.host.setConnecting(false);
        reject(error);
      });

      ws.on("close", () => {
        if (this.host.getLifecycleSocket() !== ws) {
          logger.debug(`[${this.host.logTag}] Ignoring close from stale WebSocket`);
          return;
        }
        this.host.clearPendingConnectAbort(ws);
        this.host.setLifecycleSocket(null);
        if (!opened) {
          this.host.timer.clearTimeout(connectionTimeout);
          this.host.setConnecting(false);
          reject(new Error("WebSocket closed before opening"));
          return;
        }
        logger.info(`[${this.host.logTag}] WebSocket connection closed`);
        this.host.finishEstablishedConnection(ws);
      });
    });
  }
  private discardSocket(ws: CtrlSocket, reason: string): void {
    try {
      ws.removeAllListeners();
      // Discarded sockets can emit a late error during close; they no longer own client state.
      ws.on("error", (error) =>
        logger.debug(
          `[${this.host.logTag}] Ignoring error on ${reason} WebSocket: ${errorMessage(error)}`,
        ),
      );
      ws.close();
    } catch (error) {
      // The socket may already be closing; nothing else to clean up.
      logger.debug(
        `[${this.host.logTag}] Error closing ${reason} WebSocket: ${errorMessage(error)}`,
      );
    }
  }
}

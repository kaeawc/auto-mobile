/**
 * WebSocketHandshake - dial one device service WebSocket and report whether it
 * opened.
 *
 * Extracted from DeviceServiceClient.connectWebSocketAttempt. The handshake owns
 * the per-socket listeners (open/message/pong/ping/error/close) and the
 * connection timeout; all client state it touches goes through
 * {@link WebSocketHandshakeHost} so the client keeps ownership of that state.
 */

import type WebSocket from "ws";
import { logger } from "../../utils/logger";
import type { Timer } from "../../utils/SystemTimer";
import { discardSocket } from "./discardSocket";

export interface WebSocketHandshakeHost {
  readonly timer: Timer;
  readonly connectionTimeoutMs: number;
  readonly logTag: string;
  createSocket(url: string): WebSocket;
  /** Socket that currently owns the handshake/open lifecycle (null once it terminates). */
  getLifecycleSocket(): WebSocket | null;
  setLifecycleSocket(socket: WebSocket | null): void;
  clearLifecycleSocket(socket: WebSocket): void;
  /** The installed live socket, or null before open / after close. */
  getSocket(): WebSocket | null;
  getConnectionGeneration(): number;
  /** Track the in-flight handshake so a generation change can abort it eagerly (#5656). */
  setPendingConnectAbort(pending: { socket: WebSocket; abort: () => void }): void;
  clearPendingConnectAbort(socket: WebSocket): void;
  setConnecting(connecting: boolean): void;
  onConnectAttemptFailed(): void;
  /** Install `socket` as the live connection and run the post-open bookkeeping. */
  onSocketOpened(socket: WebSocket): void;
  /** Any proof of life from the peer (pong, ping, inbound frame). */
  markLivenessSeen(): void;
  handleMessage(data: WebSocket.Data): void | Promise<void>;
  /** The opened socket closed: finish the lost connection exactly once. */
  finishEstablishedConnection(socket: WebSocket): void;
}

export function openWebSocketHandshake(
  host: WebSocketHandshakeHost,
  wsUrl: string,
  generation: number,
): Promise<boolean> {
  const { logTag, timer } = host;
  return new Promise<boolean>((resolve, reject) => {
    const ws = host.createSocket(wsUrl);
    let opened = false;
    host.setLifecycleSocket(ws);
    const connectionTimeout = timer.setTimeout(() => {
      host.clearPendingConnectAbort(ws);
      host.clearLifecycleSocket(ws);
      ws.close();
      reject(new Error("WebSocket connection timeout"));
    }, host.connectionTimeoutMs);

    // Track this in-flight handshake so a generation change (close()/updatePort())
    // can abort it eagerly. A socket stuck in CONNECTING emits neither "open" nor
    // "error", so the generation guard in the handlers below would never run for
    // it. (#5656)
    host.setPendingConnectAbort({
      socket: ws,
      abort: () => {
        timer.clearTimeout(connectionTimeout);
        // Detach lifecycle listeners before closing so the aborted socket's
        // delayed close/error cannot mutate state for the replacement connect.
        host.clearLifecycleSocket(ws);
        discardSocket(ws, logTag, "aborted");
        host.setConnecting(false);
        host.onConnectAttemptFailed();
        resolve(false);
      },
    });

    ws.on("open", () => {
      host.clearPendingConnectAbort(ws);
      timer.clearTimeout(connectionTimeout);
      if (generation !== host.getConnectionGeneration()) {
        // close() or updatePort() ran while this connection was mid-handshake.
        // Detach this socket's listeners BEFORE closing it, then discard it. A
        // replacement connect (e.g. to a new port after updatePort) may already
        // be live; without detaching, this socket's still-attached close/error
        // handlers would fire on its delayed close-handshake and null out the
        // live socket, stop the replacement's health check, and schedule a
        // spurious reconnect.
        logger.info(`[${logTag}] Discarding WebSocket opened after close`);
        host.clearLifecycleSocket(ws);
        discardSocket(ws, logTag, "discarded");
        host.setConnecting(false);
        resolve(false);
        return;
      }
      logger.info(`[${logTag}] WebSocket connected successfully`);
      opened = true;
      host.onSocketOpened(ws);
      resolve(true);
    });

    ws.on("message", (data: WebSocket.Data) => {
      if (host.getSocket() !== ws) {
        return;
      }
      // Any inbound frame proves the peer is alive, independent of whether it
      // happens to be a pong reply (#7554).
      host.markLivenessSeen();
      void host.handleMessage(data);
    });

    ws.on("pong", () => {
      if (host.getSocket() === ws) {
        host.markLivenessSeen();
      }
    });

    // The Android Ktor CtrlProxy server pings the host every 15s
    // (WebSocketServer.kt `pingPeriod`); `ws` auto-pongs those but still surfaces
    // them as a "ping" event on this side. That is a free proof of life
    // independent of the host's own probe (#7554).
    ws.on("ping", () => {
      if (host.getSocket() === ws) {
        host.markLivenessSeen();
      }
    });

    ws.on("error", (error) => {
      if (opened || host.getLifecycleSocket() !== ws) {
        logger.warn(`[${logTag}] WebSocket error: ${error.message}`);
        return;
      }
      host.clearPendingConnectAbort(ws);
      host.clearLifecycleSocket(ws);
      timer.clearTimeout(connectionTimeout);
      logger.warn(`[${logTag}] WebSocket error: ${error.message}`);
      host.setConnecting(false);
      reject(error);
    });

    ws.on("close", () => {
      if (host.getLifecycleSocket() !== ws) {
        logger.debug(`[${logTag}] Ignoring close from stale WebSocket`);
        return;
      }
      host.clearPendingConnectAbort(ws);
      host.setLifecycleSocket(null);
      if (!opened) {
        timer.clearTimeout(connectionTimeout);
        host.setConnecting(false);
        reject(new Error("WebSocket closed before opening"));
        return;
      }
      logger.info(`[${logTag}] WebSocket connection closed`);
      host.finishEstablishedConnection(ws);
    });
  });
}

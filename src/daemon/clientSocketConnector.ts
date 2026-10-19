import { Socket, createConnection } from "node:net";
import type { Duplex } from "node:stream";
import type { Timer } from "../utils/SystemTimer";
import { logger } from "../utils/logger";
import { DaemonUnavailableError, toDaemonTransportError } from "./DaemonUnavailableError";

/** The slice of {@link DaemonClient} state the socket connector reads and mutates. */
export interface DaemonSocketConnectorHost {
  readonly timer: Timer;
  readonly socketPath: string;
  getSocket(): Socket | Duplex | null;
  setSocket(socket: Socket | Duplex | null): void;
  setConnected(connected: boolean): void;
  /** Install a fresh inbound framer and reopen the inbound side. */
  resetInbound(): void;
  handleData(data: Buffer): void;
  handleSocketClosed(socket: Socket | Duplex | null): void;
  hasClosedSocket(socket: Socket | Duplex): boolean;
  hasPendingRequests(): boolean;
  rejectPendingRequests(error: Error, preserveRequestCause: boolean): void;
}

/**
 * Open the daemon socket and resolve once connected. The initiating caller owns
 * cancellation of the transport via `signal`.
 */
export function openDaemonSocket(
  host: DaemonSocketConnectorHost,
  connectionTimeout: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let removeAbortListener = () => {};

    const fail = (error: Error) => {
      if (isStaleSocket()) {
        return;
      }
      host.timer.clearTimeout(timeout);
      removeAbortListener();
      host.setConnected(false);
      host.setSocket(null);
      socket.destroy();
      // Type the transport failure so the proxy can recover sibling sessions
      // wedged by a daemon restart (#2599/#2737) instead of surfacing a raw
      // ECONNRESET/EPIPE/"socket hang up" that its recovery does not match.
      const failure = toDaemonTransportError(error);
      host.rejectPendingRequests(failure, true);
      if (!settled) {
        settled = true;
        reject(failure);
      }
    };

    const timeout = host.timer.setTimeout(() => {
      fail(new DaemonUnavailableError(`Failed to connect to daemon within ${connectionTimeout}ms`));
    }, connectionTimeout);

    if (signal) {
      const onAbort = () =>
        fail(
          new DaemonUnavailableError("Daemon connection attempt aborted", {
            cause: signal.reason,
          }),
        );
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    }

    const isStaleSocket = () => host.getSocket() !== null && host.getSocket() !== socket;
    const socket = createConnection(host.socketPath, () => {
      if (settled || socket.destroyed || isStaleSocket()) {
        return;
      }
      host.timer.clearTimeout(timeout);
      removeAbortListener();
      host.resetInbound();
      host.setConnected(true);
      logger.info(`Connected to daemon at ${host.socketPath}`);
      if (!settled) {
        settled = true;
        resolve();
      }
    });
    host.setSocket(socket);

    socket.on("data", (data) => {
      if (isStaleSocket()) {
        return;
      }
      host.handleData(typeof data === "string" ? Buffer.from(data) : data);
    });

    socket.on("error", (error) => {
      if (isStaleSocket()) {
        return;
      }
      logger.error(`Daemon socket error: ${error.message}`);
      fail(error);
    });

    socket.once("close", () => {
      // fail() clears the client socket before destroy emits close. Preserve that
      // notification path; only a different installed socket makes this stale.
      if (isStaleSocket() || host.hasClosedSocket(socket)) {
        return;
      }
      host.handleSocketClosed(socket);
      // A daemon restart/crash closes the socket. Over a Unix domain socket
      // (no TCP RST) a dying daemon delivers EOF -> "close" with no "error"
      // event, so any in-flight request would otherwise hang until its request
      // timeout. Reject pending requests with a recoverable transport error so
      // the proxy reconnects to the restarted daemon and retries (#2599/#2737).
      // After fail() the pending map is already cleared, so this is a no-op on
      // the error path.
      if (host.hasPendingRequests()) {
        host.rejectPendingRequests(
          new DaemonUnavailableError("Daemon socket connection lost: connection closed"),
          true,
        );
      }
    });
  });
}

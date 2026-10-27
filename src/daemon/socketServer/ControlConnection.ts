import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import type { Timer } from "../../utils/SystemTimer";
import { DAEMON_RPC_SOCKET_IDLE_TIMEOUT_MS } from "../../utils/deviceTimeouts";
import { DAEMON_RPC_SOCKET_PEER_END_FLUSH_GRACE_MS } from "../wire/constants";
import { OutboundWriteGuard } from "../outboundWriteGuard";
import { LineFramer } from "../wire/LineFramer";

const EXPECTED_PEER_CLOSE_CODES = new Set([
  "EPIPE",
  "ECONNRESET",
  "ERR_STREAM_DESTROYED",
  "ECONNABORTED",
]);

export function isExpectedPeerClose(error: Error): boolean {
  return (
    "code" in error && typeof error.code === "string" && EXPECTED_PEER_CLOSE_CODES.has(error.code)
  );
}

/**
 * The slice of `net.Socket` a connection drives; tests pass a plain emitter. Methods return
 * `unknown` because only their side effects matter; a `Pick` of `Socket` would force every fake to
 * return a real `Socket`.
 */
export interface ControlConnectionSocket {
  readonly destroyed: boolean;
  readonly writableLength: number;
  on(event: "data", listener: (data: Buffer | string) => void): unknown;
  on(event: "close", listener: (hadError: boolean) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "timeout" | "drain" | "pause" | "end" | "finish", listener: () => void): unknown;
  setTimeout(timeout: number): unknown;
  destroy(): unknown;
}

export type ControlConnectionTraceEvent =
  | "socket_drain"
  | "socket_pause"
  | "socket_end"
  | "socket_finish"
  | "socket_close";

/**
 * Per-connection transport state and lifecycle of one control-socket client (#11815): the idle
 * timer, the peer-end flush grace, the inbound line framer and the outbound write guard. It owns
 * no request routing; the owner supplies the request-level reactions through
 * {@link ControlConnectionHandlers}. Moved verbatim from `UnixSocketServer.handleConnection`.
 */
export interface ControlConnectionHandlers {
  /** One complete, newline-delimited inbound frame, with the receive time of its chunk. */
  onLine(line: string, receivedAtMs: number): void;
  /** The peer sent a frame over the inbound limit. */
  onOverflow(): void;
  /** True while a request on this socket still has a live deadline (renews the idle window). */
  hasLiveRequest(): boolean;
  /** The socket closed; runs after this connection's own timers and guard are released. */
  onClose(hadError: boolean): void;
  /** The socket errored; runs after the error is logged. */
  onError(error: Error): void;
  /** Optional socket-lifecycle trace hook (drain/pause/end/finish/close). */
  trace?(event: ControlConnectionTraceEvent, extra?: { hadError: boolean }): void;
}

/** What response writers need from a connection. */
export interface ControlConnectionTransport {
  /** The socket's outbound guard, created on first use. */
  outboundWriteGuard(): OutboundWriteGuard;
  /** Start the idle clock once a write backpressures. */
  startBackpressureIdle(): void;
  /** A write completed with nothing queued: extend the idle window. */
  refreshIdle(): void;
  /** A terminal response flushed to the peer. */
  responseFlushed(): void;
}

export class ControlConnection implements ControlConnectionTransport {
  private guard: OutboundWriteGuard | undefined;
  private idleTimeout: NodeJS.Timeout | undefined;
  private peerEndGrace: NodeJS.Timeout | undefined;
  private started = false;
  private handlers: ControlConnectionHandlers | undefined;

  constructor(
    private readonly socket: ControlConnectionSocket,
    private readonly sessionId: string,
    private readonly timer: Timer,
    private readonly maxInboundFrameBytes: number,
  ) {}

  outboundWriteGuard(): OutboundWriteGuard {
    if (!this.guard) {
      this.guard = new OutboundWriteGuard(this.socket, this.timer, (stall) => {
        logger.warn(
          `Daemon RPC socket ${this.sessionId} reader stalled: no queued bytes freed for ${stall.stalledMs}ms with ${stall.queuedBytes} bytes queued; destroying`,
        );
        this.socket.destroy();
      });
    }
    return this.guard;
  }

  startBackpressureIdle(): void {
    if (!this.started || this.idleTimeout || this.socket.destroyed) {
      return;
    }
    this.socket.setTimeout(0);
    this.idleTimeout = this.armIdleTimeout();
  }

  refreshIdle(): void {
    if (!this.started || !this.idleTimeout || this.socket.destroyed) {
      return;
    }
    this.timer.clearTimeout(this.idleTimeout);
    this.idleTimeout = this.armIdleTimeout();
  }

  responseFlushed(): void {
    if (!this.started || this.socket.destroyed) {
      return;
    }
    if (this.idleTimeout) {
      if (this.socket.writableLength === 0) {
        this.refreshIdle();
      }
    } else {
      this.socket.setTimeout(DAEMON_RPC_SOCKET_IDLE_TIMEOUT_MS);
    }
  }

  /** Wire the socket's listeners. Called once, right after the owner registers the session. */
  start(handlers: ControlConnectionHandlers): void {
    const { socket, sessionId, timer } = this;
    this.started = true;
    this.handlers = handlers;

    // Ordinary idle sockets retain Node's timeout. Once a write backpressures,
    // writes must no longer extend the lifetime of a peer that is not reading.
    socket.setTimeout(DAEMON_RPC_SOCKET_IDLE_TIMEOUT_MS);
    socket.on("timeout", () => this.onIdleTimeout(handlers));
    socket.on("drain", () => this.refreshIdle());
    socket.on("drain", () => this.guard?.flushed());

    if (handlers.trace) {
      const trace = handlers.trace.bind(handlers);
      socket.on("drain", () => trace("socket_drain"));
      socket.on("pause", () => trace("socket_pause"));
      socket.on("end", () => trace("socket_end"));
      socket.on("finish", () => trace("socket_finish"));
    }

    // Frames are delivered synchronously from `framer.push`, so every frame of a
    // chunk sees that chunk's receive time.
    let receivedAtMs = timer.now();
    const framer = new LineFramer(this.maxInboundFrameBytes, {
      onLine: (line) => handlers.onLine(line, receivedAtMs),
      onOverflow: () => handlers.onOverflow(),
    });
    socket.on("data", (data) => {
      // After an overflow the socket only waits for its error reply to flush;
      // further bytes must not keep it alive past the idle timeout.
      if (framer.hasOverflowed) {
        return;
      }
      this.refreshIdle();
      receivedAtMs = timer.now();
      framer.push(data);
    });

    // The peer closed its side (#11058). Replies already queued may still flush within the grace;
    // past it the socket is destroyed, because a reply queued to a peer that is gone can stay
    // unflushed without an error, so the automatic end would never complete and `close` (and the
    // owner-disconnect release it triggers) would never run.
    socket.on("end", () => {
      if (socket.destroyed || this.peerEndGrace) {
        return;
      }
      this.peerEndGrace = timer.setTimeout(() => {
        if (!socket.destroyed) {
          logger.debug(
            `Daemon RPC socket ${sessionId} peer closed with ${socket.writableLength} bytes unflushed; destroying`,
          );
          socket.destroy();
        }
      }, DAEMON_RPC_SOCKET_PEER_END_FLUSH_GRACE_MS);
    });

    socket.on("close", (hadError) => {
      if (this.peerEndGrace) {
        timer.clearTimeout(this.peerEndGrace);
      }
      if (this.idleTimeout) {
        timer.clearTimeout(this.idleTimeout);
      }
      this.started = false;
      this.guard?.dispose();
      handlers.trace?.("socket_close", { hadError });
      handlers.onClose(hadError);
    });

    socket.on("error", (error) => {
      if (isExpectedPeerClose(error)) {
        // The peer has gone away; release and destruction still clean up this socket's work.
        logger.debug(`Socket peer closed for ${sessionId}: ${errorMessage(error)}`);
      } else {
        logger.error(`Socket error for ${sessionId}:`, error);
      }
      handlers.onError(error);
      if (!socket.destroyed) {
        socket.destroy();
      }
    });
  }

  private armIdleTimeout(): NodeJS.Timeout {
    return this.timer.setTimeout(
      () => this.onIdleTimeout(this.handlers),
      DAEMON_RPC_SOCKET_IDLE_TIMEOUT_MS,
    );
  }

  private onIdleTimeout(handlers: ControlConnectionHandlers | undefined): void {
    // A silent request may outlive the idle window. Renew only while its
    // live deadline permits work, never for an unread backpressured write.
    // A handler that never answers loses this exemption at its deadline and
    // is disconnected on the next check (at most one further idle window).
    if (this.socket.writableLength === 0 && handlers?.hasLiveRequest()) {
      this.socket.setTimeout(0);
      if (this.idleTimeout) {
        this.timer.clearTimeout(this.idleTimeout);
      }
      this.idleTimeout = this.armIdleTimeout();
      return;
    }
    logger.warn(
      `Daemon RPC socket ${this.sessionId} idle timeout after ${DAEMON_RPC_SOCKET_IDLE_TIMEOUT_MS}ms, destroying`,
    );
    this.socket.destroy();
  }
}

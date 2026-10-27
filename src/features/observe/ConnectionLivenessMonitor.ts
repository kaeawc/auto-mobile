import WebSocket from "ws";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { TimedOutRequest } from "../../utils/RequestManager";
import type { Timer } from "../../utils/SystemTimer";
import type { CtrlSocket } from "./shared/types";
// Liveness probe tuning (issue #7554). `readyState === OPEN` alone cannot
// distinguish a healthy peer from a half-open connection whose TCP stream
// stalled without a close reaching the host (a wedged device-side handler, an
// adb hop that never tears down, a suspended emulator). Both runners already
// answer protocol-level pings, so the host probes with `ws.ping()` and treats
// silence past a bounded deadline as a dead connection.
//
// The deadline is a multiple of the health-check interval rather than a fixed
// constant so a client configured with a shorter/longer interval (as tests
// do) gets a proportionally scaled deadline without new config plumbing.
const LIVENESS_TIMEOUT_INTERVAL_MULTIPLIER = 2;
// After this many consecutive RequestManager timeouts with no inbound frame
// in between, the socket is "suspect": something is still accepting the TCP
// connection but not answering application requests. Run the same
// ping-then-terminate probe immediately instead of waiting for the next
// periodic health-check tick.
const REQUEST_TIMEOUT_LIVENESS_THRESHOLD = 3;

export interface ConnectionLivenessHost {
  readonly timer: Timer;
  readonly healthCheckIntervalMs: number;
  healthCheckIntervalId: ReturnType<Timer["setInterval"]> | null;
  lastHealthCheckTime: number;
  getLogTag(): string;
  getSocket(): CtrlSocket | null;
  reconnectAfterFailedHealthCheck(): void;
  silentTimeoutConfirmationMs(request: TimedOutRequest): number | undefined;
  onConfirmedRequestStall(request: TimedOutRequest): void;
}
/** Tracks peer liveness without owning connection replacement or recovery. */
export class ConnectionLivenessMonitor {
  constructor(private readonly host: ConnectionLivenessHost) {}

  // Liveness state (issue #7554). Refreshed by any proof of life on the
  // current socket: a pong reply, a server-initiated ping, or any inbound
  // frame (a frame proves the peer is alive even if no ping is outstanding).
  // lastLivenessAt remains for logging/inspection; startLivenessProbe()
  // compares livenessSeq rather than the timestamp, since a monotonic
  // counter can't miss a frame that lands in the same millisecond as the
  // probe's deadline tick (timer resolution is coarser than that).
  private lastLivenessAt: number = 0;
  private livenessSeq: number = 0;
  private livenessDeadlineTimeoutId: ReturnType<Timer["setTimeout"]> | null = null;
  // Consecutive RequestManager timeouts observed since the last proof of
  // life. Reset by markLivenessSeen(); read by handleRequestTimeout().
  private consecutiveRequestTimeouts: number = 0;
  private stallConfirmationTimeoutId: ReturnType<Timer["setTimeout"]> | null = null;

  // ===========================================================================
  // Health check (shared implementation)
  // ===========================================================================

  /**
   * Start periodic health check to ensure WebSocket stays connected.
   */
  startHealthCheck(): void {
    // Clear any existing health check
    this.stopHealthCheck();

    logger.debug(
      `[${this.host.getLogTag()}] Starting health check (interval: ${this.host.healthCheckIntervalMs}ms)`,
    );
    this.host.lastHealthCheckTime = this.host.timer.now();

    this.host.healthCheckIntervalId = this.host.timer.setInterval(() => {
      const now = this.host.timer.now();
      const timeSinceLastCheck = now - this.host.lastHealthCheckTime;
      this.host.lastHealthCheckTime = now;

      // Check if WebSocket is still connected
      const ws = this.host.getSocket();
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        logger.warn(`[${this.host.getLogTag()}] Health check failed: WebSocket not connected`);
        this.stopHealthCheck();

        // Attempt reconnection if auto-reconnect is enabled and not already connecting
        this.host.reconnectAfterFailedHealthCheck();
      } else {
        logger.debug(
          `[${this.host.getLogTag()}] Health check passed (time since last: ${timeSinceLastCheck}ms)`,
        );
        // readyState alone only proves the socket hasn't been torn down; it
        // says nothing about whether the peer is still answering (#7554).
        // Probe with a protocol-level ping on the injected timer.
        this.startLivenessProbe(ws);
      }
    }, this.host.healthCheckIntervalMs);
  }

  /**
   * Stop the health check interval.
   */
  stopHealthCheck(): void {
    if (this.host.healthCheckIntervalId !== null) {
      logger.debug(`[${this.host.getLogTag()}] Stopping health check`);
      this.host.timer.clearInterval(this.host.healthCheckIntervalId);
      this.host.healthCheckIntervalId = null;
    }
    if (this.livenessDeadlineTimeoutId !== null) {
      this.host.timer.clearTimeout(this.livenessDeadlineTimeoutId);
      this.livenessDeadlineTimeoutId = null;
    }
    if (this.stallConfirmationTimeoutId !== null) {
      this.host.timer.clearTimeout(this.stallConfirmationTimeoutId);
      this.stallConfirmationTimeoutId = null;
    }
  }

  /**
   * Record proof that the current connection's peer is alive: a pong reply,
   * a server-initiated ping, or any inbound frame (a frame proves liveness
   * even without an outstanding ping). Also clears the consecutive-timeout
   * counter used by {@link handleRequestTimeout}, since a live peer means
   * those earlier timeouts were not evidence of a wedged socket after all.
   *
   * Bumps {@link livenessSeq} rather than relying solely on the
   * {@link lastLivenessAt} timestamp: {@link startLivenessProbe}'s deadline
   * check compares the sequence number, which can't miss a frame that lands
   * in the same millisecond as the check (timer/`Date.now()` resolution is
   * coarser than that).
   */
  markLivenessSeen(): void {
    if (this.livenessDeadlineTimeoutId !== null) {
      this.host.timer.clearTimeout(this.livenessDeadlineTimeoutId);
      this.livenessDeadlineTimeoutId = null;
    }
    this.lastLivenessAt = this.host.timer.now();
    this.livenessSeq++;
    this.consecutiveRequestTimeouts = 0;
  }

  /**
   * Send a protocol-level ping and, unless a probe is already in flight,
   * arm a bounded deadline on the injected {@link Timer}. If neither a pong
   * nor any other inbound frame refreshes {@link livenessSeq} before the
   * deadline, the socket is presumed dead and torn down with
   * `ws.terminate()`. That firing is what drives the normal was-open close
   * path (`onConnectionClosed()` → `scheduleReconnect()`) — this method
   * never calls either directly, so a liveness failure is counted as exactly
   * one lost connection, the same as any other close (#7554).
   *
   * Safe to call from both the periodic health check and
   * {@link handleRequestTimeout}: a probe already in flight is left alone
   * rather than restarted, so back-to-back callers cannot pile up deadlines
   * or double-count a single failure.
   */
  private startLivenessProbe(ws: CtrlSocket): void {
    if (this.livenessDeadlineTimeoutId !== null) {
      return;
    }
    const checkStartedAtSeq = this.livenessSeq;
    try {
      ws.ping();
    } catch (error) {
      // Best-effort: a ping send failure on a socket that still reports OPEN
      // is itself evidence of trouble, so still arm the deadline below rather
      // than returning early.
      logger.debug(
        `[${this.host.getLogTag()}] Failed to send liveness ping: ${errorMessage(error)}`,
      );
    }
    if (this.livenessSeq !== checkStartedAtSeq) {
      return;
    }
    const livenessTimeoutMs =
      this.host.healthCheckIntervalMs * LIVENESS_TIMEOUT_INTERVAL_MULTIPLIER;
    this.livenessDeadlineTimeoutId = this.host.timer.setTimeout(() => {
      this.livenessDeadlineTimeoutId = null;
      if (this.host.getSocket() !== ws || ws.readyState !== WebSocket.OPEN) {
        // Already replaced or torn down through some other path; nothing to do.
        return;
      }
      if (this.livenessSeq > checkStartedAtSeq) {
        // A pong or another frame arrived since this probe started.
        return;
      }
      logger.warn(
        `[${this.host.getLogTag()}] Liveness probe failed: no pong or frame received within ${livenessTimeoutMs}ms, terminating stale connection`,
      );
      ws.terminate();
    }, livenessTimeoutMs);
  }

  /**
   * Feed RequestManager timeouts back into connection state (#7554). A
   * wedged device-side handler can still answer protocol pings while never
   * responding to application requests, so consecutive request timeouts with
   * no proof of life in between are treated as "suspect" and trigger the same
   * ping-then-terminate probe immediately, instead of waiting out the rest of
   * the current health-check interval.
   */
  handleRequestTimeout(request: TimedOutRequest): void {
    this.confirmSilentRequestStall(request);
    this.consecutiveRequestTimeouts++;
    if (this.consecutiveRequestTimeouts < REQUEST_TIMEOUT_LIVENESS_THRESHOLD) {
      return;
    }
    const ws = this.host.getSocket();
    if (ws && ws.readyState === WebSocket.OPEN) {
      logger.warn(
        `[${this.host.getLogTag()}] ${this.consecutiveRequestTimeouts} consecutive request timeouts with no inbound frame; probing connection liveness`,
      );
      this.startLivenessProbe(ws);
    }
  }

  /**
   * A command that times out while the peer sent nothing at all may be a
   * stopped runner rather than a slow one. Ping it once on a short deadline:
   * a peer that answers is merely busy; silence is reported to the subclass,
   * which owns recovery (#11247). Unlike {@link startLivenessProbe} this never
   * terminates the socket itself.
   */
  private confirmSilentRequestStall(request: TimedOutRequest): void {
    const ws = this.host.getSocket();
    if (
      !ws ||
      ws.readyState !== WebSocket.OPEN ||
      this.stallConfirmationTimeoutId !== null ||
      // Same-millisecond proof of life is ambiguous; treat it as life.
      this.lastLivenessAt >= request.createdAt
    ) {
      return;
    }
    const confirmationMs = this.host.silentTimeoutConfirmationMs(request);
    if (confirmationMs === undefined) {
      return;
    }
    const startedAtSeq = this.livenessSeq;
    try {
      ws.ping();
    } catch (error) {
      // A failed send is itself stall evidence; the deadline below decides.
      logger.debug(
        `[${this.host.getLogTag()}] Failed to send stall-confirmation ping: ${errorMessage(error)}`,
      );
    }
    this.stallConfirmationTimeoutId = this.host.timer.setTimeout(() => {
      this.stallConfirmationTimeoutId = null;
      if (
        this.host.getSocket() !== ws ||
        ws.readyState !== WebSocket.OPEN ||
        this.livenessSeq !== startedAtSeq
      ) {
        return;
      }
      logger.warn(
        `[${this.host.getLogTag()}] ${request.type} request timed out after ${request.timeoutMs}ms and a ` +
          `ping went unanswered for ${confirmationMs}ms; treating the runner as stalled`,
      );
      this.host.onConfirmedRequestStall(request);
    }, confirmationMs);
  }
}

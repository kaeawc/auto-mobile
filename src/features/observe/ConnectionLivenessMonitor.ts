/**
 * ConnectionLivenessMonitor - periodic health check, ping-based liveness probe and
 * silent-request-stall confirmation for a device service WebSocket.
 *
 * Extracted from DeviceServiceClient so the connection lifecycle (dial, teardown,
 * reconnect) and the "is the peer still answering" bookkeeping stay separate. The
 * monitor owns only liveness state; everything it needs from the client (the live
 * socket, reconnect policy, platform stall hooks) arrives through
 * {@link ConnectionLivenessHost}.
 */

import WebSocket from "ws";
import { logger } from "../../utils/logger";
import type { TimedOutRequest } from "../../utils/RequestManager";
import type { Timer } from "../../utils/SystemTimer";

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
  /** Resolved lazily: the abstract log tag is not assigned until the subclass constructor runs. */
  getLogTag(): string;
  getSocket(): WebSocket | null;
  /** Reconnect after a failed health check when auto-reconnect is enabled and idle. */
  reconnectAfterFailedHealthCheck(): void;
  /** Platform hook: confirmation window for a silent request timeout, or undefined when disabled. */
  silentTimeoutConfirmationMs(request: TimedOutRequest): number | undefined;
  /** Platform hook: a silent timeout whose confirmation ping also went unanswered. */
  onConfirmedRequestStall(request: TimedOutRequest): void;
}

export class ConnectionLivenessMonitor {
  private healthCheckIntervalId: ReturnType<Timer["setInterval"]> | null = null;
  private lastHealthCheckTime = 0;
  // Refreshed by any proof of life on the current socket: a pong reply, a
  // server-initiated ping, or any inbound frame (a frame proves the peer is
  // alive even if no ping is outstanding). lastLivenessAt remains for
  // logging/inspection; startLivenessProbe() compares livenessSeq rather than
  // the timestamp, since a monotonic counter can't miss a frame that lands in
  // the same millisecond as the probe's deadline tick.
  private lastLivenessAt = 0;
  private livenessSeq = 0;
  private livenessDeadlineTimeoutId: ReturnType<Timer["setTimeout"]> | null = null;
  // Consecutive RequestManager timeouts observed since the last proof of life.
  private consecutiveRequestTimeouts = 0;
  private stallConfirmationTimeoutId: ReturnType<Timer["setTimeout"]> | null = null;

  constructor(private readonly host: ConnectionLivenessHost) {}

  /** Start periodic health check to ensure the WebSocket stays connected. */
  startHealthCheck(): void {
    this.stopHealthCheck();
    const { host } = this;
    logger.debug(
      `[${host.getLogTag()}] Starting health check (interval: ${host.healthCheckIntervalMs}ms)`,
    );
    this.lastHealthCheckTime = host.timer.now();
    this.healthCheckIntervalId = host.timer.setInterval(
      () => this.runHealthCheck(),
      host.healthCheckIntervalMs,
    );
  }

  private runHealthCheck(): void {
    const { host } = this;
    const now = host.timer.now();
    const timeSinceLastCheck = now - this.lastHealthCheckTime;
    this.lastHealthCheckTime = now;

    const ws = host.getSocket();
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      logger.warn(`[${host.getLogTag()}] Health check failed: WebSocket not connected`);
      this.stopHealthCheck();
      host.reconnectAfterFailedHealthCheck();
      return;
    }
    logger.debug(
      `[${host.getLogTag()}] Health check passed (time since last: ${timeSinceLastCheck}ms)`,
    );
    // readyState alone only proves the socket hasn't been torn down; it says
    // nothing about whether the peer is still answering (#7554). Probe with a
    // protocol-level ping on the injected timer.
    this.startLivenessProbe(ws);
  }

  /** Stop the health check interval and any pending liveness or stall deadlines. */
  stopHealthCheck(): void {
    const { timer } = this.host;
    if (this.healthCheckIntervalId !== null) {
      logger.debug(`[${this.host.getLogTag()}] Stopping health check`);
      timer.clearInterval(this.healthCheckIntervalId);
      this.healthCheckIntervalId = null;
    }
    if (this.livenessDeadlineTimeoutId !== null) {
      timer.clearTimeout(this.livenessDeadlineTimeoutId);
      this.livenessDeadlineTimeoutId = null;
    }
    if (this.stallConfirmationTimeoutId !== null) {
      timer.clearTimeout(this.stallConfirmationTimeoutId);
      this.stallConfirmationTimeoutId = null;
    }
  }

  /**
   * Record proof that the current connection's peer is alive: a pong reply,
   * a server-initiated ping, or any inbound frame. Also clears the
   * consecutive-timeout counter used by {@link handleRequestTimeout}, since a
   * live peer means those earlier timeouts were not evidence of a wedged socket.
   *
   * Bumps a sequence number rather than relying solely on the timestamp: the
   * probe's deadline check compares the sequence, which can't miss a frame that
   * lands in the same millisecond as the check.
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
   * Send a protocol-level ping and, unless a probe is already in flight, arm a
   * bounded deadline on the injected timer. If neither a pong nor any other
   * inbound frame refreshes the sequence before the deadline, the socket is
   * presumed dead and torn down with `ws.terminate()`. That firing drives the
   * normal was-open close path, so a liveness failure is counted as exactly one
   * lost connection, the same as any other close (#7554).
   */
  private startLivenessProbe(ws: WebSocket): void {
    if (this.livenessDeadlineTimeoutId !== null) {
      return;
    }
    const { host } = this;
    const checkStartedAtSeq = this.livenessSeq;
    try {
      ws.ping();
    } catch (error) {
      // Best-effort: a ping send failure on a socket that still reports OPEN
      // is itself evidence of trouble, so still arm the deadline below rather
      // than returning early.
      logger.debug(`[${host.getLogTag()}] Failed to send liveness ping: ${error}`);
    }
    if (this.livenessSeq !== checkStartedAtSeq) {
      return;
    }
    const livenessTimeoutMs = host.healthCheckIntervalMs * LIVENESS_TIMEOUT_INTERVAL_MULTIPLIER;
    this.livenessDeadlineTimeoutId = host.timer.setTimeout(() => {
      this.livenessDeadlineTimeoutId = null;
      if (host.getSocket() !== ws || ws.readyState !== WebSocket.OPEN) {
        // Already replaced or torn down through some other path; nothing to do.
        return;
      }
      if (this.livenessSeq > checkStartedAtSeq) {
        // A pong or another frame arrived since this probe started.
        return;
      }
      logger.warn(
        `[${host.getLogTag()}] Liveness probe failed: no pong or frame received within ${livenessTimeoutMs}ms, terminating stale connection`,
      );
      ws.terminate();
    }, livenessTimeoutMs);
  }

  /**
   * Feed RequestManager timeouts back into connection state (#7554). A wedged
   * device-side handler can still answer protocol pings while never responding
   * to application requests, so consecutive request timeouts with no proof of
   * life in between trigger the same ping-then-terminate probe immediately,
   * instead of waiting out the rest of the current health-check interval.
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
   * stopped runner rather than a slow one. Ping it once on a short deadline: a
   * peer that answers is merely busy; silence is reported to the platform
   * client, which owns recovery (#11247). Unlike the liveness probe this never
   * terminates the socket itself.
   */
  private confirmSilentRequestStall(request: TimedOutRequest): void {
    const { host } = this;
    const ws = host.getSocket();
    if (
      !ws ||
      ws.readyState !== WebSocket.OPEN ||
      this.stallConfirmationTimeoutId !== null ||
      // Same-millisecond proof of life is ambiguous; treat it as life.
      this.lastLivenessAt >= request.createdAt
    ) {
      return;
    }
    const confirmationMs = host.silentTimeoutConfirmationMs(request);
    if (confirmationMs === undefined) {
      return;
    }
    const startedAtSeq = this.livenessSeq;
    try {
      ws.ping();
    } catch (error) {
      // A failed send is itself stall evidence; the deadline below decides.
      logger.debug(`[${host.getLogTag()}] Failed to send stall-confirmation ping: ${error}`);
    }
    this.stallConfirmationTimeoutId = host.timer.setTimeout(() => {
      this.stallConfirmationTimeoutId = null;
      if (
        host.getSocket() !== ws ||
        ws.readyState !== WebSocket.OPEN ||
        this.livenessSeq !== startedAtSeq
      ) {
        return;
      }
      logger.warn(
        `[${host.getLogTag()}] ${request.type} request timed out after ${request.timeoutMs}ms and a ` +
          `ping went unanswered for ${confirmationMs}ms; treating the runner as stalled`,
      );
      host.onConfirmedRequestStall(request);
    }, confirmationMs);
  }
}

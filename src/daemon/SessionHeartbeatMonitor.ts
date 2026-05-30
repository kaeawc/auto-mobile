import { Timer, defaultTimer } from "../utils/SystemTimer";
import { logger } from "../utils/logger";
import { SessionManager, type Session } from "./sessionManager";

/**
 * Minimal view of the session store the heartbeat monitor needs.
 */
export interface HeartbeatSessionSource {
  getAllSessions(): Session[];
  /** Remove expired sessions and fire their release callbacks. */
  cleanupExpiredSessions(): void;
}

export interface SessionHeartbeatMonitorConfig {
  /** How often to scan for stale sessions. Default: 10s. */
  checkIntervalMs?: number;
  /** Grace period before a session that never sent a heartbeat is eligible. Default: 20s. */
  graceMs?: number;
}

/**
 * Session Heartbeat Monitor
 *
 * Periodically cancels sessions whose heartbeat has gone stale, freeing their
 * devices. A session is reaped when, after the initial grace period and with no
 * active executions, `now - lastHeartbeat` exceeds the session's heartbeat
 * timeout.
 *
 * Extracted from the daemon so the reaping logic can be driven deterministically
 * with an injected timer in tests. Behaviour is unchanged in production, where
 * the daemon passes its default timer.
 */
export class SessionHeartbeatMonitor {
  private timerHandle: NodeJS.Timeout | null = null;
  private readonly checkIntervalMs: number;
  private readonly graceMs: number;

  constructor(
    private readonly sessions: HeartbeatSessionSource,
    private readonly hasActiveExecutions: (sessionId: string) => boolean,
    private readonly reap: (sessionId: string) => Promise<void>,
    private readonly timer: Timer = defaultTimer,
    config: SessionHeartbeatMonitorConfig = {},
  ) {
    this.checkIntervalMs = config.checkIntervalMs ?? 10_000;
    this.graceMs = config.graceMs ?? 20_000;
  }

  start(): void {
    if (this.timerHandle) {
      return;
    }
    this.timerHandle = this.timer.setInterval(() => {
      void this.tick();
    }, this.checkIntervalMs);

    // Allow the process to exit even if the monitor is running.
    const handle = this.timerHandle as { unref?: () => void };
    if (handle && typeof handle.unref === "function") {
      handle.unref();
    }
  }

  stop(): void {
    if (this.timerHandle) {
      this.timer.clearInterval(this.timerHandle);
      this.timerHandle = null;
    }
  }

  /**
   * Scan sessions once and reap any whose heartbeat has gone stale.
   * Exposed for deterministic testing; also invoked on each interval tick.
   */
  async tick(): Promise<void> {
    const now = this.timer.now();

    // Release idle/expired sessions promptly (e.g. autolocked devices whose idle
    // timeout has elapsed). Their idle timeout equals their heartbeat timeout, so
    // they expire out of getAllSessions() exactly when they would become stale —
    // sweeping here gives them the monitor's interval granularity instead of the
    // 5-minute cleanup sweep.
    this.sessions.cleanupExpiredSessions();

    for (const session of this.sessions.getAllSessions()) {
      if (!session.hasReceivedHeartbeat && now - session.createdAt < this.graceMs) {
        continue;
      }
      if (this.hasActiveExecutions(session.sessionId)) {
        continue;
      }
      const timeoutMs = session.heartbeatTimeoutMs ?? SessionManager.DEFAULT_HEARTBEAT_TIMEOUT_MS;
      const lastHeartbeat = session.lastHeartbeat ?? session.lastUsedAt;
      if (now - lastHeartbeat > timeoutMs) {
        logger.warn(`Session ${session.sessionId} heartbeat timeout, cancelling`);
        await this.reap(session.sessionId);
      }
    }
  }
}

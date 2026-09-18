import { Timer, defaultTimer } from "../utils/SystemTimer";
import { logger } from "../utils/logger";
import {
  getDefaultPreFirstHeartbeatGraceMs,
  getDefaultSessionHeartbeatTimeoutMs,
  type Session,
} from "./sessionManager";
import { SingleFlightInterval } from "./SingleFlightInterval";

/**
 * Minimal view of the session store the heartbeat monitor needs.
 */
export interface HeartbeatSessionSource {
  getAllSessions(): Session[];
  /** Remove expired sessions and fire their release callbacks. */
  cleanupExpiredSessions(): void;
}

type SessionHeartbeatReleaseReason =
  | "missing-first-heartbeat"
  | "heartbeat-timeout"
  | "cli-idle-timeout"
  | "rehydration-owner-timeout";

/** Log prose for each release reason, so the sweep loop carries no branching. */
const STALE_REASON_DESCRIPTION: Record<SessionHeartbeatReleaseReason, string> = {
  "missing-first-heartbeat": "never received first heartbeat",
  "heartbeat-timeout": "heartbeat timeout",
  "cli-idle-timeout": "idle past the CLI idle timeout",
  "rehydration-owner-timeout": "awaiting reconnect past rehydration grace",
};

export interface SessionHeartbeatMonitorConfig {
  /** How often to scan for stale sessions. Default: 10s. */
  checkIntervalMs?: number;
  /** Grace period before default-heartbeat sessions that never sent a heartbeat are reaped. Default: 5s. */
  preFirstHeartbeatGraceMs?: number;
  /** Grace period before a custom-heartbeat session that never sent a heartbeat is eligible. Default: 20s. */
  graceMs?: number;
  /** Default timeout for sessions that do not carry their own heartbeat timeout. Default: 10s. */
  heartbeatTimeoutMs?: number;
}

const DEFAULT_CHECK_INTERVAL_MS = 10_000;
const DEFAULT_INITIAL_GRACE_MS = 20_000;

function readPositiveMsEnv(primaryName: string, legacyName: string): number | undefined {
  const rawValue = process.env[primaryName] ?? process.env[legacyName];
  if (!rawValue) {
    return undefined;
  }
  const parsed = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Session Heartbeat Monitor
 *
 * Periodically cancels sessions whose heartbeat has gone stale, freeing their
 * devices. Sessions using the default heartbeat policy that never send their
 * first heartbeat are reaped after a short pre-first-heartbeat grace. Other
 * sessions are reaped when, after the initial grace period and with no active
 * executions, `now - lastHeartbeat` exceeds the session's heartbeat timeout.
 *
 * Extracted from the daemon so the reaping logic can be driven deterministically
 * with an injected timer in tests. Behaviour is unchanged in production, where
 * the daemon passes its default timer.
 */
export class SessionHeartbeatMonitor {
  private readonly interval: SingleFlightInterval;
  private readonly checkIntervalMs: number;
  private readonly graceMs: number;
  private readonly preFirstHeartbeatGraceMs: number;
  private readonly defaultHeartbeatTimeoutMs: number;

  constructor(
    private readonly sessions: HeartbeatSessionSource,
    private readonly hasActiveExecutions: (sessionId: string) => boolean,
    private readonly reap: (
      sessionId: string,
      reason: SessionHeartbeatReleaseReason,
    ) => Promise<void>,
    private readonly timer: Timer = defaultTimer,
    config: SessionHeartbeatMonitorConfig = {},
  ) {
    this.checkIntervalMs =
      config.checkIntervalMs ??
      readPositiveMsEnv(
        "AUTOMOBILE_SESSION_HEARTBEAT_CHECK_INTERVAL_MS",
        "AUTO_MOBILE_SESSION_HEARTBEAT_CHECK_INTERVAL_MS",
      ) ??
      DEFAULT_CHECK_INTERVAL_MS;
    this.graceMs =
      config.graceMs ??
      readPositiveMsEnv(
        "AUTOMOBILE_SESSION_HEARTBEAT_INITIAL_GRACE_MS",
        "AUTO_MOBILE_SESSION_HEARTBEAT_INITIAL_GRACE_MS",
      ) ??
      DEFAULT_INITIAL_GRACE_MS;
    this.preFirstHeartbeatGraceMs =
      config.preFirstHeartbeatGraceMs ?? getDefaultPreFirstHeartbeatGraceMs();
    this.defaultHeartbeatTimeoutMs =
      config.heartbeatTimeoutMs ??
      readPositiveMsEnv(
        "AUTOMOBILE_SESSION_HEARTBEAT_TIMEOUT_MS",
        "AUTO_MOBILE_SESSION_HEARTBEAT_TIMEOUT_MS",
      ) ??
      getDefaultSessionHeartbeatTimeoutMs();
    this.interval = new SingleFlightInterval(this.timer, this.checkIntervalMs, () =>
      this.tickOnce(),
    );
  }

  start(): void {
    this.interval.start();
  }

  async stop(): Promise<void> {
    const settled = await this.interval.stop();
    if (!settled) {
      logger.warn("Session heartbeat monitor did not settle before shutdown timeout");
    }
  }

  /**
   * Scan sessions once and reap any whose heartbeat has gone stale.
   * Exposed for deterministic testing; also invoked on each interval tick.
   */
  async tick(): Promise<void> {
    return this.interval.run();
  }

  private async tickOnce(): Promise<void> {
    const now = this.timer.now();

    // Release idle/expired sessions promptly (e.g. autolocked devices whose idle
    // timeout has elapsed). Their idle timeout equals their heartbeat timeout, so
    // they expire out of getAllSessions() exactly when they would become stale —
    // sweeping here gives them the monitor's interval granularity instead of the
    // 5-minute cleanup sweep.
    this.sessions.cleanupExpiredSessions();

    for (const session of this.sessions.getAllSessions()) {
      if (this.hasActiveExecutions(session.sessionId)) {
        continue;
      }
      // Awaiting-owner sessions never receive pre-first-heartbeat grace; judge them solely by
      // the rehydration-owner timeout while they await ownership.
      const reason =
        session.ownership === "awaiting-owner"
          ? this.rehydrationOwnerStaleReason(session, now)
          : this.staleReason(session, now);
      if (reason) {
        logger.warn(
          `Session ${session.sessionId} ${STALE_REASON_DESCRIPTION[reason]}, cancelling (reason=${reason})`,
        );
        await this.reap(session.sessionId, reason);
      }
    }
  }

  /**
   * Why this session should be released now, or undefined to leave it alone.
   *
   * Split out of {@link tickOnce} so the per-session policy reads as one
   * decision rather than a nest of early-continues inside the sweep loop.
   */
  private staleReason(session: Session, now: number): SessionHeartbeatReleaseReason | undefined {
    const timeoutMs = session.heartbeatTimeoutMs ?? this.defaultHeartbeatTimeoutMs;
    const lastHeartbeat = session.lastHeartbeat ?? session.lastUsedAt;

    // A CLI-owned session (issue #6870) is judged on wall-clock idleness, not on
    // the 10 s heartbeat contract: the `--cli` process that owns it exits between
    // calls, so nobody is left to heartbeat and a missing first heartbeat says
    // nothing about abandonment. Its `heartbeatTimeoutMs` was widened to the CLI
    // idle timeout when it adopted the policy.
    if (session.livenessPolicy === "cli-idle") {
      return now - lastHeartbeat > timeoutMs ? "cli-idle-timeout" : undefined;
    }

    if (!session.hasReceivedHeartbeat) {
      if (session.heartbeatTimeoutSource === "default") {
        return now - lastHeartbeat > this.preFirstHeartbeatGraceMs
          ? "missing-first-heartbeat"
          : undefined;
      }
      if (now - session.createdAt < this.graceMs) {
        return undefined;
      }
    }

    return now - lastHeartbeat > timeoutMs ? "heartbeat-timeout" : undefined;
  }

  private rehydrationOwnerStaleReason(
    session: Session,
    now: number,
  ): SessionHeartbeatReleaseReason | undefined {
    if (session.ownership !== "awaiting-owner") {
      return undefined;
    }
    const awaitingOwnerSince = session.awaitingOwnerSince ?? now;
    return now - awaitingOwnerSince > session.heartbeatTimeoutMs
      ? "rehydration-owner-timeout"
      : undefined;
  }
}

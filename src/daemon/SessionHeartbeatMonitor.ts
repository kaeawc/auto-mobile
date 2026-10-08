import { Timer, defaultTimer } from "../utils/SystemTimer";
import { logger } from "../utils/logger";
import {
  getDefaultPreFirstHeartbeatGraceMs,
  getDefaultSessionHeartbeatTimeoutMs,
  type Session,
} from "./sessionManager";
import { SingleFlightInterval } from "./SingleFlightInterval";
import { effectiveLastHeartbeat, suspectGraceMsFor } from "./livenessOwnerLease";
import { MAX_CALLER_MCP_REQUEST_TIMEOUT_MS } from "./mcpRequestTimeout";
import {
  DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS,
  SUSPECT_GRACE_MS,
} from "./sessionLivenessWindows";

/**
 * Minimal view of the session store the heartbeat monitor needs.
 */
export interface HeartbeatSessionSource {
  getAllSessions(): Session[];
  /** Remove expired sessions and fire their release callbacks. */
  cleanupExpiredSessions(): void;
  /**
   * Move every session's lease forward by `lostMs`, the interval the daemon itself stalled for
   * and cannot have received heartbeats during (#10051). Never past `resumedAt`.
   */
  forgiveDaemonStall?(resumedAt: number, lostMs: number): number;
  /** Register a detector the source runs before every expiry judgement; undefined detaches it. */
  setStallProbe?(probe: (() => void) | undefined): void;
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
  /** How often to scan for stale sessions. Default: 2s (see `./sessionLivenessWindows`). */
  checkIntervalMs?: number;
  /** Grace period before default-heartbeat sessions that never sent a heartbeat are reaped. Default: 5s. */
  preFirstHeartbeatGraceMs?: number;
  /** Grace period before a custom-heartbeat session that never sent a heartbeat is eligible. Default: 20s. */
  graceMs?: number;
  /** Default timeout for sessions that do not carry their own heartbeat timeout. Default: 4s. */
  heartbeatTimeoutMs?: number;
  /**
   * How much later than scheduled a tick may fire before the daemon is judged to
   * have stalled itself and no session is held to the lost interval (#10051).
   * Judged against the monitor's own interval, not the lease: a daemon that was
   * silent for only a fraction of the lease can still push a heartbeating owner
   * past lease plus grace when the reaper runs before its buffered heartbeats.
   * Default: {@link DEFAULT_STALL_MARGIN_MS}, which absorbs ordinary timer jitter.
   */
  stallThresholdMs?: number;
}

/** Timer jitter tolerated before a late scan is treated as a stall of the daemon itself. */
export const DEFAULT_STALL_MARGIN_MS = 2_000;

/**
 * Ceiling on how long an execution that never settles may veto the release of a stale session
 * (#10663). No request's deadline can exceed the caller timeout cap, so an execution still
 * tracked this long after its session went stale has outlived any deadline it could have had,
 * and its abandoned owner's device is released anyway.
 */
export const UNSETTLED_EXECUTION_VETO_CEILING_MS = MAX_CALLER_MCP_REQUEST_TIMEOUT_MS;

const DEFAULT_CHECK_INTERVAL_MS = DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS;
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
 * executions, `now - lastHeartbeat` exceeds the session's heartbeat timeout. An
 * active execution keeps a stale session only up to
 * {@link UNSETTLED_EXECUTION_VETO_CEILING_MS} (#10663).
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
  private readonly stallThresholdMs: number;
  /** When each stale session incarnation was first kept alive by an active execution. */
  private readonly executionVetoSince = new WeakMap<Session, number>();
  /** When the previous scan finished (or the monitor started); undefined until started. */
  private lastScanSettledAt: number | undefined;
  /** A running scan has already judged its own lateness; a probe mid-scan would count scan time. */
  private scanInFlight = false;

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
    this.stallThresholdMs = config.stallThresholdMs ?? DEFAULT_STALL_MARGIN_MS;
    this.interval = new SingleFlightInterval(this.timer, this.checkIntervalMs, () =>
      this.tickOnce(),
    );
  }

  start(): void {
    this.lastScanSettledAt ??= this.timer.now();
    this.sessions.setStallProbe?.(() => this.forgiveStallIfLate());
    this.interval.start();
  }

  async stop(): Promise<void> {
    this.sessions.setStallProbe?.(undefined);
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

  /**
   * How late this scan fired relative to its schedule, judged on the injected
   * clock. Undefined before the monitor starts, so a manually driven `tick()`
   * has no schedule to be late against.
   */
  private scanLatenessMs(now: number): number | undefined {
    return this.lastScanSettledAt === undefined
      ? undefined
      : now - this.lastScanSettledAt - this.checkIntervalMs;
  }

  /**
   * A tick that fires later than scheduled by more than the margin means the daemon's own event
   * loop stalled, so the owners' heartbeats could not have reached it for that long. Never reap
   * on the strength of that: every session's lease is moved forward by exactly the lateness.
   */
  private forgiveOwnStall(): void {
    this.forgiveStallIfLate();
  }

  /**
   * Idempotent form of the stall check, also run by the session source before each lazy expiry
   * judgement (#10661). Once a stall is judged, the schedule watermark is moved so the overdue
   * tick measures only what is still unaccounted for and forgiveness is never applied twice.
   */
  private forgiveStallIfLate(): void {
    if (this.scanInFlight) {
      return;
    }
    const now = this.timer.now();
    const lateness = this.scanLatenessMs(now);
    if (lateness === undefined || lateness <= this.stallThresholdMs) {
      return;
    }
    this.lastScanSettledAt = now - this.checkIntervalMs;
    const forgiven = this.sessions.forgiveDaemonStall?.(now, lateness) ?? 0;
    logger.warn(
      `Heartbeat monitor tick fired ${lateness}ms late; the daemon stalled, so ${forgiven} ` +
        `session(s) get their lease extended by ${lateness}ms instead of being reaped for the stalled interval`,
    );
  }

  private async tickOnce(): Promise<void> {
    this.forgiveOwnStall();
    this.scanInFlight = true;
    try {
      // Release idle/expired sessions promptly (e.g. autolocked devices whose idle
      // timeout has elapsed). Their idle timeout equals their heartbeat timeout, so
      // they expire out of getAllSessions() exactly when they would become stale —
      // sweeping here gives them the monitor's interval granularity instead of the
      // 5-minute cleanup sweep.
      this.sessions.cleanupExpiredSessions();
      const results = await Promise.allSettled(this.reapStaleSessions());
      const firstFailure = results.find((result) => result.status === "rejected");
      if (firstFailure) {
        throw firstFailure.reason;
      }
    } finally {
      this.scanInFlight = false;
      if (this.lastScanSettledAt !== undefined) {
        this.lastScanSettledAt = this.timer.now();
      }
    }
  }

  /** Start a reap for every stale session and return the in-flight reaps. */
  private reapStaleSessions(): Promise<void>[] {
    const reaps: Promise<void>[] = [];
    for (const session of this.sessions.getAllSessions()) {
      // Awaiting-owner sessions never receive pre-first-heartbeat grace; judge them solely by
      // the rehydration-owner timeout while they await ownership.
      const now = this.timer.now();
      const reason =
        session.ownership === "awaiting-owner"
          ? this.rehydrationOwnerStaleReason(session, now)
          : this.staleReason(session, now);
      if (!reason) {
        this.executionVetoSince.delete(session);
        continue;
      }
      if (this.isVetoedByActiveExecution(session, reason, now)) {
        continue;
      }
      logger.warn(
        `Session ${session.sessionId} ${STALE_REASON_DESCRIPTION[reason]}, cancelling (reason=${reason})`,
      );
      try {
        reaps.push(
          this.reap(session.sessionId, reason).catch((error: unknown) => {
            logger.warn(`Failed to reap stale session ${session.sessionId}`, error);
            throw error;
          }),
        );
      } catch (error) {
        logger.warn(`Failed to reap stale session ${session.sessionId}`, error);
        reaps.push(Promise.reject(error));
      }
    }
    return reaps;
  }

  /**
   * Whether an active execution still keeps this stale session (#5343: never reap mid-call).
   * The veto is bounded (#10663): once it has held for {@link UNSETTLED_EXECUTION_VETO_CEILING_MS} the execution
   * has outlived any request deadline, nobody is left to consume its result, and the session is
   * released anyway so its device does not stay held for as long as the call stays unsettled.
   */
  private isVetoedByActiveExecution(
    session: Session,
    reason: SessionHeartbeatReleaseReason,
    now: number,
  ): boolean {
    if (!this.hasActiveExecutions(session.sessionId)) {
      this.executionVetoSince.delete(session);
      return false;
    }
    const vetoedSince = this.executionVetoSince.get(session) ?? now;
    this.executionVetoSince.set(session, vetoedSince);
    const vetoedMs = now - vetoedSince;
    if (vetoedMs < UNSETTLED_EXECUTION_VETO_CEILING_MS) {
      return true;
    }
    logger.warn(
      `Session ${session.sessionId} (${STALE_REASON_DESCRIPTION[reason]}) was kept for ${vetoedMs}ms ` +
        `by executions that never settled; releasing it anyway past the ` +
        `${UNSETTLED_EXECUTION_VETO_CEILING_MS}ms unsettled-execution ceiling (reason=${reason})`,
    );
    return false;
  }

  /**
   * Why this session should be released now, or undefined to leave it alone.
   *
   * Split out of {@link tickOnce} so the per-session policy reads as one
   * decision rather than a nest of early-continues inside the sweep loop.
   */
  private staleReason(session: Session, now: number): SessionHeartbeatReleaseReason | undefined {
    const timeoutMs = session.heartbeatTimeoutMs ?? this.defaultHeartbeatTimeoutMs;
    // The daemon's own stall is never held against the owner (#10051).
    const lastHeartbeat = effectiveLastHeartbeat({
      lastHeartbeat: session.lastHeartbeat ?? session.lastUsedAt,
      stallForgivenAt: session.stallForgivenAt,
    });

    // A CLI-owned session (issue #6870) is judged on wall-clock idleness, not on
    // the heartbeat lease: the `--cli` process that owns it exits between calls,
    // so nobody is left to heartbeat and a missing first heartbeat says nothing
    // about abandonment. Its `heartbeatTimeoutMs` was widened to the CLI idle
    // timeout when it adopted the policy. Idleness is measured from the last TOOL
    // activity (`lastUsedAt`, stamped at a call's start and end), never from a
    // heartbeat: a `--daemon heartbeat` loop proves liveness, not use, and must
    // not hold the device with no tool calls (owner decision 2026-10-08).
    if (session.livenessPolicy === "cli-idle") {
      return now - session.lastUsedAt > timeoutMs ? "cli-idle-timeout" : undefined;
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

    // Past the lease the session is suspect, not released: it is held for the
    // grace window with its device reserved so the owner can restore it (#10051).
    return now - lastHeartbeat > timeoutMs + suspectGraceMsFor(session)
      ? "heartbeat-timeout"
      : undefined;
  }

  private rehydrationOwnerStaleReason(
    session: Session,
    now: number,
  ): SessionHeartbeatReleaseReason | undefined {
    if (session.ownership !== "awaiting-owner") {
      return undefined;
    }
    // A returning owner gets the budget a live owner gets: the lease plus the suspect grace.
    // The release is terminal, and a proxy reconnecting to a restarted daemon must first find
    // the socket and then deliver a heartbeat on its own cadence.
    const awaitingOwnerSince = session.awaitingOwnerSince ?? now;
    return now - awaitingOwnerSince > session.heartbeatTimeoutMs + SUSPECT_GRACE_MS
      ? "rehydration-owner-timeout"
      : undefined;
  }
}

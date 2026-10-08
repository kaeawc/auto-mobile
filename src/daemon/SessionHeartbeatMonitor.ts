import { Timer, defaultTimer } from "../utils/SystemTimer";
import { logger } from "../utils/logger";
import { errorMessage } from "../utils/describeUnknownError";
import {
  getDefaultPreFirstHeartbeatGraceMs,
  getDefaultSessionHeartbeatTimeoutMs,
  type Session,
} from "./sessionManager";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import { effectiveLastHeartbeat, suspectGraceMsFor } from "./livenessOwnerLease";
import {
  UNSETTLED_EXECUTION_VETO_CEILING_MS,
  UnsettledExecutionVeto,
  type SessionExecutionProbeInput,
} from "./unsettledExecutionVeto";
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

/** Shared with the owner-disconnect release; see `./unsettledExecutionVeto` (#10712). */
export { UNSETTLED_EXECUTION_VETO_CEILING_MS };

const DEFAULT_CHECK_INTERVAL_MS = DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS;
/** How long shutdown waits for releases a scan started before giving up on them. */
const REAP_STOP_TIMEOUT_MS = 5_000;
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
 * active execution keeps a stale session only as long as the shared unsettled-execution veto
 * policy allows (#10663, #10712).
 *
 * Extracted from the daemon so the reaping logic can be driven deterministically
 * with an injected timer in tests. Behaviour is unchanged in production, where
 * the daemon passes its default timer.
 */
export class SessionHeartbeatMonitor {
  private intervalHandle: NodeJS.Timeout | null = null;
  private readonly checkIntervalMs: number;
  private readonly graceMs: number;
  private readonly preFirstHeartbeatGraceMs: number;
  private readonly defaultHeartbeatTimeoutMs: number;
  private readonly stallThresholdMs: number;
  /** Bounds how long active executions keep a stale session (#10663, shared policy #10712). */
  private readonly executionVeto: UnsettledExecutionVeto;
  /** When the previous scan finished (or the monitor started); undefined until started. */
  private lastScanSettledAt: number | undefined;
  /** A running scan has already judged its own lateness; a probe mid-scan would count scan time. */
  private scanInFlight = false;
  /**
   * Releases started by earlier scans that are still tearing down, one per session. A scan never
   * waits on them: one slow teardown must not delay the expiry checks of every other session.
   */
  private readonly reapsInFlight = new Map<string, Promise<void>>();

  constructor(
    private readonly sessions: HeartbeatSessionSource,
    executions: SessionExecutionProbeInput,
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
    this.executionVeto = new UnsettledExecutionVeto(executions, timer);
  }

  start(): void {
    this.lastScanSettledAt ??= this.timer.now();
    this.sessions.setStallProbe?.(() => this.forgiveStallIfLate());
    if (this.intervalHandle) {
      return;
    }
    // The scan is synchronous and never waits on a release's teardown (each release is
    // single-flight per session), so a slow teardown cannot delay other sessions' checks.
    this.intervalHandle = this.timer.setInterval(() => {
      try {
        void Promise.allSettled(this.scan());
      } catch (error) {
        logger.warn(`Session heartbeat scan failed: ${errorMessage(error)}`, error);
      }
    }, this.checkIntervalMs);
    (this.intervalHandle as { unref?: () => void }).unref?.();
  }

  async stop(): Promise<void> {
    this.sessions.setStallProbe?.(undefined);
    if (this.intervalHandle) {
      this.timer.clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    const reaps = [...this.reapsInFlight.values()];
    const reapsSettled =
      reaps.length === 0 ||
      (await raceWithDeadline(
        Promise.allSettled(reaps).then(() => true),
        {
          timer: this.timer,
          timeoutMs: REAP_STOP_TIMEOUT_MS,
          label: "Heartbeat monitor release drain",
        },
      ).catch((error: unknown) => {
        // A release still tearing down at shutdown is left to the daemon's own teardown bound.
        logger.debug(`Heartbeat monitor release drain did not finish: ${error}`);
        return false;
      }));
    if (!reapsSettled) {
      logger.warn("Session heartbeat monitor did not settle before shutdown timeout");
    }
  }

  /**
   * Scan sessions once and reap any whose heartbeat has gone stale, then wait for the releases
   * this scan started. Exposed for deterministic testing; the interval runs the same scan without
   * waiting on the releases.
   */
  async tick(): Promise<void> {
    const results = await Promise.allSettled(this.scan());
    const firstFailure = results.find((result) => result.status === "rejected");
    if (firstFailure) {
      throw firstFailure.reason;
    }
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

  /** Judge every session now and start the releases due; returns the releases started. */
  private scan(): Promise<void>[] {
    this.forgiveOwnStall();
    this.scanInFlight = true;
    try {
      // Release idle/expired sessions promptly (e.g. autolocked devices whose idle
      // timeout has elapsed). Their idle timeout equals their heartbeat timeout, so
      // they expire out of getAllSessions() exactly when they would become stale —
      // sweeping here gives them the monitor's interval granularity instead of the
      // 5-minute cleanup sweep.
      this.sessions.cleanupExpiredSessions();
      return this.reapStaleSessions();
    } finally {
      this.scanInFlight = false;
      if (this.lastScanSettledAt !== undefined) {
        // Never backwards: a scan judged at an earlier clock reading must not reopen a stall.
        this.lastScanSettledAt = Math.max(this.lastScanSettledAt, this.timer.now());
      }
    }
  }

  /** Start a reap for every stale session and return the in-flight reaps. */
  private reapStaleSessions(): Promise<void>[] {
    const reaps: Promise<void>[] = [];
    for (const session of this.sessions.getAllSessions()) {
      if (this.reapsInFlight.has(session.sessionId)) {
        continue;
      }
      // Awaiting-owner sessions never receive pre-first-heartbeat grace; judge them solely by
      // the rehydration-owner timeout while they await ownership.
      const now = this.timer.now();
      const reason =
        session.ownership === "awaiting-owner"
          ? this.rehydrationOwnerStaleReason(session, now)
          : this.staleReason(session, now);
      if (!reason) {
        this.executionVeto.forget(session);
        continue;
      }
      if (this.isVetoedByActiveExecution(session, reason)) {
        continue;
      }
      logger.warn(
        `Session ${session.sessionId} ${STALE_REASON_DESCRIPTION[reason]}, cancelling (reason=${reason})`,
      );
      try {
        reaps.push(this.trackReap(session.sessionId, this.reap(session.sessionId, reason)));
      } catch (error) {
        logger.warn(`Failed to reap stale session ${session.sessionId}`, error);
        reaps.push(Promise.reject(error));
      }
    }
    return reaps;
  }

  /** Record a started release so later scans skip its session until it settles. */
  private trackReap(sessionId: string, reap: Promise<void>): Promise<void> {
    const logged = reap.catch((error: unknown) => {
      logger.warn(`Failed to reap stale session ${sessionId}`, error);
      throw error;
    });
    const settled = logged.then(
      () => undefined,
      () => undefined,
    );
    this.reapsInFlight.set(sessionId, settled);
    void settled.then(() => {
      if (this.reapsInFlight.get(sessionId) === settled) {
        this.reapsInFlight.delete(sessionId);
      }
    });
    return logged;
  }

  /**
   * Whether an active execution still keeps this stale session (#5343: never reap mid-call).
   * The veto is bounded (#10663) by the shared policy in `./unsettledExecutionVeto`: once it has
   * outlived its bound nobody is left to consume the call's result, and the session is released
   * anyway so its device does not stay held for as long as the call stays unsettled.
   */
  private isVetoedByActiveExecution(
    session: Session,
    reason: SessionHeartbeatReleaseReason,
  ): boolean {
    const verdict = this.executionVeto.judge(session);
    if (verdict.kind !== "expired") {
      return verdict.kind === "kept";
    }
    logger.warn(
      `Session ${session.sessionId} (${STALE_REASON_DESCRIPTION[reason]}) was kept for ${verdict.vetoedMs}ms ` +
        `by executions that never settled; releasing it anyway past their ${verdict.bound} ` +
        `bound (reason=${reason})`,
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

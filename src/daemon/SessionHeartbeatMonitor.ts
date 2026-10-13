import {
  DEFAULT_STALL_MARGIN_MS,
  MAX_CREDIBLE_DAEMON_STALL_MS,
  splitScheduleGap,
} from "./timerLateness";
export { DEFAULT_STALL_MARGIN_MS, MAX_CREDIBLE_DAEMON_STALL_MS } from "./timerLateness";
import { Timer, defaultTimer, monotonicClockSemanticsDrift } from "../utils/SystemTimer";
import { readOptionalEnvPositiveInteger } from "../utils/envNumbers";
import { logger } from "../utils/logger";
import { errorMessage } from "../utils/describeUnknownError";
import {
  SESSION_RELEASE_STUCK_DEADLINE_MS,
  getDefaultPreFirstHeartbeatGraceMs,
  getDefaultSessionHeartbeatTimeoutMs,
  type Session,
} from "./sessionManager";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import {
  judgedLeaseHeartbeat,
  suspectGraceMsFor,
  heartbeatLeasePastGrace,
} from "./livenessOwnerLease";
import { sessionIdleDeadline } from "./sessionClocks";
import {
  UNSETTLED_EXECUTION_VETO_CEILING_MS,
  UnsettledExecutionVeto,
  type SessionExecutionProbeInput,
} from "./unsettledExecutionVeto";
import { getSessionHeartbeatCheckIntervalMs, SUSPECT_GRACE_MS } from "./sessionLivenessWindows";

/**
 * Minimal view of the session store the heartbeat monitor needs.
 */
export interface HeartbeatSessionSource {
  getAllSessions(): Session[];
  /** Remove expired sessions and fire their release callbacks. */
  cleanupExpiredSessions(): void;
  /**
   * Move every session's lease forward by `lostMs`, the interval the daemon itself stalled for
   * and cannot have received heartbeats during (#10051), and by `sleptMs`, the interval the host
   * was suspended and no owner could heartbeat (#10699). Only `lostMs` also moves the idle
   * deadline: host sleep counts toward idle. Never past `resumedAt`.
   */
  forgiveDaemonStall?(
    resumedAt: number,
    lostMs: number,
    sleptMs?: number,
    gapBeganAt?: number,
  ): number;
  /**
   * The clock the source stamps session timestamps with (#11080). Every judgement and every
   * watermark here reads it, so a wall-clock step cannot move a lease. Absent: the timer's wall
   * clock.
   */
  sessionNow?(): number;
  /** Lease heartbeat including a qualifying same-token base's owner proof (#11722). */
  judgedLeaseHeartbeat?(session: Session): number;
  /** Register a detector the source runs before every expiry judgement; undefined detaches it. */
  setStallProbe?(probe: (() => void) | undefined): void;
  /**
   * The idle releases the source started itself (its idle sweep, a lazy expiry) that still hold
   * their device, with when each started on the session clock (#11481). They are not reaps of the
   * monitor, so it learns of them here to hold them to the same stuck deadline.
   */
  getIdleReleasesInProgress?(): IdleReleaseInProgress[];
  /**
   * The releases in progress that carry a non-terminal reason (a `device-restart:` handoff, a
   * `plan-auto-release`), with when each started on the session clock (#11554). The source
   * refuses heartbeats for a releasing session, so the monitor judges such a session as of the
   * release's start and never reaps it for the silence the release itself imposed.
   */
  getNonTerminalReleasesInProgress?(): NonTerminalReleaseInProgress[];
  /**
   * Terminal releases without an idle expiry origin, including releases no monitor reap joins.
   * Every release in flight must be tracked and forced to enforce the advertised cleanup bound.
   */
  getTerminalReleasesInProgress?(): IdleReleaseInProgress[];
  /**
   * Whether the release of this session that started at `startedAtMs` is still running and still
   * holds its device, whatever reason it carries now (#11554). A joiner can upgrade a non-terminal
   * release to a terminal reason, which drops it from {@link getNonTerminalReleasesInProgress}
   * while it is as wedged as before; the monitor asks this before it forgets a release it tracks.
   */
  isReleaseInProgress?(sessionId: string, startedAtMs: number): boolean;
  /** Per-release absolute stuck deadline on the session clock, including ownership holds. */
  getReleaseStuckAtMs?(sessionId: string): number | undefined;
}

/** One idle release the session source is still running. */
export interface IdleReleaseInProgress {
  sessionId: string;
  startedAtMs: number;
}

/** One release with a non-terminal reason the session source is still running. */
export interface NonTerminalReleaseInProgress extends IdleReleaseInProgress {
  /** The session incarnation being released: a re-created session of the same id is not it. */
  session: Session;
}

/** A release the monitor holds to {@link STUCK_REAP_WARN_MS}. */
interface TrackedRelease {
  at: number;
  /** Reported (and forced, when a force is wired) already: once per release. */
  reported: boolean;
  /** Started by the session source (idle, non-terminal or terminal), not by a monitor reap. */
  sourceRelease?: boolean;
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
  /**
   * Only consulted when the timer's monotonic clock runs through host sleep
   * (`Timer.monotonicIncludesHostSleep`: Windows, Linux), so sleep and a daemon stall look alike.
   * A gap later than this is then judged to be host sleep, which counts toward idle, rather than
   * a stall, which is forgiven in full. A shorter sleep is still forgiven as a stall, so a session
   * can be held for up to this much longer than its idle window after a short sleep. Default:
   * {@link MAX_CREDIBLE_DAEMON_STALL_MS}, independent of the idle window (#10962).
   */
  maxCredibleStallMs?: number;
  /** The running Bun version the clock-semantics self-check compares (#10962); tests inject it. */
  bunVersion?: string;
  /**
   * Called once when a reap has been unsettled for {@link STUCK_REAP_WARN_MS} (#10963): force the
   * device back to the pool while the session stays fenced. Without it the stuck reap is only
   * reported and its device stays held for as long as the teardown stays wedged.
   */
  forceStuckRelease?: (sessionId: string) => Promise<void>;
}

/** Shared with the owner-disconnect release; see `./unsettledExecutionVeto` (#10712). */
export { UNSETTLED_EXECUTION_VETO_CEILING_MS };

/** How long shutdown waits for releases a scan started before giving up on them. */
const REAP_STOP_TIMEOUT_MS = 5_000;
/**
 * Fallback stuck deadline (#10704, #10963) when the source reports none or release has not
 * started: 18 s for first attempts, two bounded writes and scheduling slack. A source deadline
 * adds clock (15 s), rotation (1 s), screen-reader (35 s) state and any ownership hold. Its
 * session is skipped meanwhile, never released twice; other sessions are judged on schedule.
 */
export const STUCK_REAP_WARN_MS = SESSION_RELEASE_STUCK_DEADLINE_MS;
const DEFAULT_INITIAL_GRACE_MS = 20_000;

function readPositiveMsEnv(primaryName: string, legacyName: string): number | undefined {
  return readOptionalEnvPositiveInteger(primaryName, legacyName);
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
  private readonly maxCredibleStallMs: number;
  private readonly bunVersionOverride: string | undefined;
  private readonly forceStuckRelease: ((sessionId: string) => Promise<void>) | undefined;
  /** The measured clock disagreed with `monotonicIncludesHostSleep`; warned once (#10962). */
  private clockSemanticsDisagreementReported = false;
  /** Bounds how long active executions keep a stale session (#10663, shared policy #10712). */
  private readonly executionVeto: UnsettledExecutionVeto;
  /**
   * When the previous scan finished (or the monitor started), on the session clock; undefined
   * until started.
   */
  private lastScanSettledAt: number | undefined;
  /** The same instant on the monotonic clock, which does not run while the host sleeps (#10699). */
  private lastScanSettledMonotonic: number | undefined;
  /** The raw wall clock's lead over the monotonic clock at the last reading, for #10962's self-check. */
  private lastRawWallLeadMs: number | undefined;
  /** A running scan has already judged its own lateness; a probe mid-scan would count scan time. */
  private scanInFlight = false;
  /**
   * Releases started by earlier scans that are still tearing down, one per session. A scan never
   * waits on them: one slow teardown must not delay the expiry checks of every other session.
   */
  private readonly reapsInFlight = new Map<string, Promise<void>>();
  /**
   * When each release in progress started, and whether it has been reported as stuck: the
   * monitor's own reaps and every source release (idle, non-terminal or terminal). All are
   * tracked and forced at their stuck deadline. Stuck detection runs over this
   * set, never over the visible sessions, which hide a session once its idle deadline passes.
   */
  private readonly reapStartedAt = new Map<string, TrackedRelease>();
  /**
   * When the non-terminal release of each session being released started, as of this scan
   * (#11554). Heartbeats are refused from that instant, so the session is judged as of it.
   */
  private heartbeatsRefusedSince = new Map<Session, number>();

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
    this.checkIntervalMs = config.checkIntervalMs ?? getSessionHeartbeatCheckIntervalMs();
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
    this.forceStuckRelease = config.forceStuckRelease;
    this.maxCredibleStallMs = config.maxCredibleStallMs ?? MAX_CREDIBLE_DAEMON_STALL_MS;
    this.bunVersionOverride = config.bunVersion;
    // Judged on the session clock, like every other watermark here (#11162).
    this.executionVeto = new UnsettledExecutionVeto(
      executions,
      timer,
      UNSETTLED_EXECUTION_VETO_CEILING_MS,
      () => this.now(),
    );
  }

  start(): void {
    if (this.lastScanSettledAt === undefined) {
      this.lastScanSettledAt = this.now();
      this.lastScanSettledMonotonic = this.monotonicNow();
      this.checkClockSemantics();
    }
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

  /** The session clock (#11080): what session timestamps are stamped with and judged against. */
  private now(): number {
    return this.sessions.sessionNow?.() ?? this.timer.now();
  }

  /** The injected monotonic clock; a timer without one is treated as a host that never sleeps. */
  private monotonicNow(): number {
    return this.timer.monotonicNow?.() ?? this.timer.now();
  }

  /**
   * How the time since the previous scan splits (#10699). `sleptMs` is how far the session clock
   * ran ahead of the monotonic clock: the host was suspended, nothing ran anywhere on it, and that
   * time counts toward idle (the session clock only runs ahead for sleep, never for a wall-clock
   * step except a forward one on darwin, which is indistinguishable from sleep, #11080). `lateMs` is how much later than scheduled the scan fired while the
   * host was awake: the daemon's own event loop stalled, which is never held against an owner.
   * Undefined before the monitor starts, so a manually driven `tick()` has no schedule to be late
   * against.
   */
  private sinceLastScan(
    now: number,
    monotonic: number,
  ): { lateMs: number; sleptMs: number } | undefined {
    if (this.lastScanSettledAt === undefined || this.lastScanSettledMonotonic === undefined) {
      return undefined;
    }
    const gap = splitScheduleGap({
      wallElapsedMs: now - this.lastScanSettledAt,
      monotonicElapsedMs: monotonic - this.lastScanSettledMonotonic,
      scheduledMs: this.checkIntervalMs,
      monotonicIncludesHostSleep: this.timer.monotonicIncludesHostSleep,
      maxCredibleStallMs: this.maxCredibleStallMs,
    });
    this.checkRawWallLead(monotonic);
    return gap;
  }

  /**
   * The session clock ignores the wall clock's lead where the monotonic clock is configured as
   * running through sleep, so #10962's runtime self-check reads the raw wall clock instead: a lead
   * that grew past the stall margin is sleep the monotonic clock paused for.
   */
  private checkRawWallLead(monotonic: number): void {
    const lead = this.timer.now() - monotonic;
    const grewMs = lead - (this.lastRawWallLeadMs ?? lead);
    this.lastRawWallLeadMs = lead;
    if (this.timer.monotonicIncludesHostSleep === true && grewMs > this.stallThresholdMs) {
      this.reportClockSemanticsDisagreement(grewMs);
    }
  }

  private bunVersion(): string | undefined {
    return this.bunVersionOverride ?? process.versions.bun;
  }

  /**
   * Startup self-check (#10962): the platform table behind `monotonicIncludesHostSleep` was
   * verified for one Bun release line. Warn when the running Bun is another one.
   */
  private checkClockSemantics(): void {
    if (this.timer.monotonicIncludesHostSleep === undefined) {
      return;
    }
    const drift = monotonicClockSemanticsDrift(this.bunVersion());
    if (drift) {
      logger.warn(`[SessionHeartbeatMonitor] ${drift}`);
    }
  }

  /**
   * Runtime self-check (#10962): the timer claims its monotonic clock runs through host sleep,
   * yet the wall clock just ran ahead of it, which only a clock that pauses during sleep does.
   */
  private reportClockSemanticsDisagreement(sleptMs: number): void {
    if (this.clockSemanticsDisagreementReported) {
      return;
    }
    this.clockSemanticsDisagreementReported = true;
    logger.warn(
      `[SessionHeartbeatMonitor] The wall clock ran ${sleptMs}ms ahead of the monotonic clock, ` +
        "which pauses during host sleep here, but this platform is configured as running through " +
        `it (Bun ${this.bunVersion() ?? "unknown"}, ${process.platform}); host sleep may be ` +
        "misjudged as a daemon stall. Update monotonicClockIncludesHostSleep (#10962).",
    );
  }

  /**
   * A tick that fires later than scheduled by more than the margin means the daemon's own event
   * loop stalled, so the owners' heartbeats could not have reached it for that long. Never reap
   * on the strength of that alone: the source applies its lease forgiveness rules.
   */
  private forgiveOwnStall(): void {
    this.forgiveStallIfLate();
  }

  /**
   * Idempotent form of the stall check, also run by the session source before each lazy expiry
   * judgement (#10661). Once a stall or sleep is judged, the schedule watermarks are moved so the
   * overdue tick measures only what is still unaccounted for and nothing is forgiven twice.
   *
   * Sleep and stall are told apart by the wall clock running ahead of the monotonic one (#10699),
   * not by length: a daemon stall of any length is forgiven in full for owners live at its start
   * (the daemon could not hear them), while host sleep of any length counts toward the idle
   * deadline (owner policy) and only excuses the heartbeat lease, since no owner on a sleeping
   * host could heartbeat either. Where the monotonic clock runs through sleep (Windows, Linux) the
   * two cannot be told apart and length decides instead (`maxCredibleStallMs`).
   *
   * Full lease forgiveness requires an owner live at the gap start (#11080). The session source
   * also grants capped awake-stall credit to an owner connected at that instant (#11992).
   * The gap is taken to begin as early as it can have: when the previous scan settled.
   */
  private forgiveStallIfLate(): void {
    if (this.scanInFlight) {
      return;
    }
    const now = this.now();
    const monotonic = this.monotonicNow();
    const gap = this.sinceLastScan(now, monotonic);
    if (gap === undefined) {
      return;
    }
    const lateMs = gap.lateMs > this.stallThresholdMs ? gap.lateMs : 0;
    const sleptMs = gap.sleptMs > this.stallThresholdMs ? gap.sleptMs : 0;
    if (lateMs === 0 && sleptMs === 0) {
      return;
    }
    // The earliest the gap can have begun: the previous scan was the last the daemon is known to
    // have run on time, and a stall can start right after it.
    const gapBeganAt = this.lastScanSettledAt ?? now;
    this.lastScanSettledAt = now - this.checkIntervalMs;
    this.lastScanSettledMonotonic = monotonic - this.checkIntervalMs;
    const forgiven = this.sessions.forgiveDaemonStall?.(now, lateMs, sleptMs, gapBeganAt) ?? 0;
    logger.warn(
      `Heartbeat monitor tick fired ${lateMs}ms late after the host slept ${sleptMs}ms; ` +
        `${forgiven} session(s) considered for stall forgiveness (host sleep counts toward idle); ` +
        "lease and idle extension counts are logged by the session manager",
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
      this.forceStuckReleases();
      return this.reapStaleSessions();
    } finally {
      this.scanInFlight = false;
      if (this.lastScanSettledAt !== undefined && this.lastScanSettledMonotonic !== undefined) {
        // Never backwards: a scan judged at an earlier clock reading must not reopen a stall.
        this.lastScanSettledAt = Math.max(this.lastScanSettledAt, this.now());
        this.lastScanSettledMonotonic = Math.max(
          this.lastScanSettledMonotonic,
          this.monotonicNow(),
        );
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
      // A session mid-release has its heartbeats refused, so the time since its release began is
      // not its owner's silence (#11554): judge it as of that instant. A recoverable handoff or a
      // plan's release that outlasts lease plus grace is then never reaped, nor rewritten into a
      // terminal heartbeat loss, while an owner that had already lost its lease is still reaped.
      // Awaiting-owner sessions never receive pre-first-heartbeat grace; judge them solely by
      // the rehydration-owner timeout while they await ownership.
      const now = Math.min(this.now(), this.heartbeatsRefusedSince.get(session) ?? Infinity);
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
        `Session ${session.sessionId} ${STALE_REASON_DESCRIPTION[reason]}, cancelling (reason=${reason})` +
          (reason === "heartbeat-timeout"
            ? `; last heartbeat age=${now - (this.sessions.judgedLeaseHeartbeat?.(session) ?? judgedLeaseHeartbeat(session))}ms, heartbeat timeout=${session.heartbeatTimeoutMs ?? this.defaultHeartbeatTimeoutMs}ms`
            : ""),
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
    const existing = this.reapStartedAt.get(sessionId);
    // Keep sourceRelease so scans forget an ended release even while its join promise unwinds.
    const tracked: TrackedRelease =
      existing?.sourceRelease &&
      this.sessions.isReleaseInProgress?.(sessionId, existing.at) === true
        ? { ...existing }
        : { at: this.now(), reported: false };
    this.reapStartedAt.set(sessionId, tracked);
    void settled.then(() => {
      if (this.reapsInFlight.get(sessionId) === settled) {
        this.reapsInFlight.delete(sessionId);
      }
      if (this.reapStartedAt.get(sessionId) === tracked) {
        this.reapStartedAt.delete(sessionId);
      }
    });
    return logged;
  }

  /**
   * Hold every release in progress to the stuck deadline (#10963), whether or not its session is
   * still visible (#11481): a session past its idle deadline is hidden from `getAllSessions()`
   * and skipped by the idle sweep while it is releasing, so a scan of visible sessions never
   * reached a release that wedged across that deadline, nor any idle release.
   */
  private forceStuckReleases(): void {
    this.trackSourceReleases();
    for (const sessionId of this.reapStartedAt.keys()) {
      this.reportIfStuck(sessionId);
    }
  }

  /**
   * Mirror every source release into {@link reapStartedAt}: idle (#11481), non-terminal (#11554)
   * and terminal releases are tracked and forced at their stuck deadline even when no monitor
   * reap joins them. Only non-terminal releases freeze heartbeat-refused judgement. One that
   * settled, or was forced and so no longer holds its device, is forgotten here; a new release
   * of the same session id starts a new deadline. A reason upgrade keeps the same release's
   * start and reported state, so it is forced once with whatever reason it carries by then. A
   * reap of the monitor's own is left alone: it is already tracked from its own start and
   * forgotten when it settles.
   */
  private trackSourceReleases(): void {
    const nonTerminal = this.sessions.getNonTerminalReleasesInProgress?.() ?? [];
    this.heartbeatsRefusedSince = new Map(
      nonTerminal.map((release) => [release.session, release.startedAtMs]),
    );
    const sourceReleases = [
      nonTerminal,
      this.sessions.getIdleReleasesInProgress?.(),
      this.sessions.getTerminalReleasesInProgress?.(),
    ].flatMap((releases) => releases ?? []);
    const inProgress = new Map(
      sourceReleases.map((release) => [release.sessionId, release.startedAtMs]),
    );
    for (const [sessionId, tracked] of this.reapStartedAt) {
      if (
        tracked.sourceRelease &&
        inProgress.get(sessionId) !== tracked.at &&
        this.sessions.isReleaseInProgress?.(sessionId, tracked.at) !== true
      ) {
        this.reapStartedAt.delete(sessionId);
      }
    }
    for (const [sessionId, startedAtMs] of inProgress) {
      if (!this.reapStartedAt.has(sessionId)) {
        this.reapStartedAt.set(sessionId, {
          at: startedAtMs,
          reported: false,
          sourceRelease: true,
        });
      }
    }
  }

  /** Warn once when a release has been tearing down for {@link STUCK_REAP_WARN_MS} (#10704). */
  private reportIfStuck(sessionId: string): void {
    const started = this.reapStartedAt.get(sessionId);
    if (!started || started.reported) {
      return;
    }
    const now = this.now();
    const elapsedMs = now - started.at;
    if (now < (this.sessions.getReleaseStuckAtMs?.(sessionId) ?? started.at + STUCK_REAP_WARN_MS)) {
      return;
    }
    started.reported = true;
    if (!this.forceStuckRelease) {
      logger.warn(
        `Session ${sessionId} release has not settled after ${elapsedMs}ms; its device stays ` +
          "held until the teardown finishes. Other sessions are still judged on schedule.",
      );
      return;
    }
    logger.warn(
      `Session ${sessionId} release has not settled after ${elapsedMs}ms; forcing its device ` +
        "back to the pool while the session stays fenced (#10963).",
    );
    void this.forceStuckRelease(sessionId).catch((error: unknown) => {
      logger.warn(
        `Forcing the stuck release of session ${sessionId} failed: ${errorMessage(error)}`,
        error,
      );
    });
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
    // A CLI-owned session (issue #6870) is judged on wall-clock idleness, not on
    // the heartbeat lease: the `--cli` process that owns it exits between calls,
    // so nobody is left to heartbeat and a missing first heartbeat says nothing
    // about abandonment. Its `heartbeatTimeoutMs` was widened to the CLI idle
    // timeout when it adopted the policy. Idleness is measured from the last TOOL
    // activity (`lastUsedAt`, stamped at a call's start and end), never from a
    // heartbeat: a `--daemon heartbeat` loop proves liveness, not use, and must
    // not hold the device with no tool calls (owner decision 2026-10-08).
    if (session.livenessPolicy === "cli-idle") {
      // The daemon's own stall is not idleness either (#10835): see `idleStallForgivenAt`. The
      // deadline is the one a late call's admission and the reported `idleReleaseAt` use (#11558).
      return now > sessionIdleDeadline(session) ? "cli-idle-timeout" : undefined;
    }
    return this.heartbeatLeaseStaleReason(session, now);
  }

  /**
   * The heartbeat-lease half of {@link staleReason}: judged on liveness clocks only, never on
   * tool activity (#10703, guarded by `test/lint/livenessActivityClockSeparation.test.ts`).
   */
  private heartbeatLeaseStaleReason(
    session: Session,
    now: number,
  ): SessionHeartbeatReleaseReason | undefined {
    const timeoutMs = session.heartbeatTimeoutMs ?? this.defaultHeartbeatTimeoutMs;
    // The daemon's own stall is never held against the owner (#10051). An owned session that has
    // heartbeated is judged on its owner's own heartbeats: `lastHeartbeat` is also stamped by tool
    // calls from any connection, which must not keep a dead owner's lease alive (#11107). A
    // session no proxy owns keeps the activity-refreshed `lastHeartbeat` fallback.
    const ownHeartbeat = judgedLeaseHeartbeat(session);
    const lastHeartbeat = this.sessions.judgedLeaseHeartbeat?.(session) ?? ownHeartbeat;

    // A later base heartbeat is owner proof even if this label never heartbeated by name (#11722).
    if (!session.hasReceivedHeartbeat && lastHeartbeat === ownHeartbeat) {
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
    return heartbeatLeasePastGrace(now, lastHeartbeat, timeoutMs, suspectGraceMsFor(session))
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

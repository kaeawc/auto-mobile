/**
 * Per-session liveness recovery for an MCP proxy (#10053, epic #10049).
 *
 * A proxy is the only liveness owner of the device sessions it holds. When it stops getting
 * heartbeat acknowledgements for a session it can be in one of two distinct states:
 *
 * - `daemon_stalled`: the daemon's socket is open or reconnectable but heartbeat acks time out.
 * - `proxy_stalled`: the proxy's own heartbeat tick fired later than the lease allows, which it can
 *   only notice after it resumes.
 *
 * Each state gets exactly {@link LIVENESS_RECOVERY_ATTEMPTS} automatic attempts (re-heartbeat with
 * the same owner token; a session the daemon holds as suspect is restored with the same UUID).
 * After that the proxy hands over to the harness with a structured error and does nothing more.
 *
 * Only an answer from the daemon proves a session lost (`proxy_stalled`): a session the daemon says
 * it no longer has, or that another token now owns. A daemon that never answers is stalled
 * (`daemon_stalled`) whichever state recovery started in.
 *
 * Nothing here reaches a daemon manager: the daemon is shared by every harness, so restarting it is
 * a harness action named in the handover, never a proxy one. The only way this module talks to the
 * daemon is the injected {@link LivenessRecoveryDeps.attempt}.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { logger } from "../utils/logger";
import { errorMessage } from "../utils/describeUnknownError";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import type { Timer } from "../utils/SystemTimer";
import { SUSPECT_GRACE_MS } from "./livenessOwnerLease";

const withoutDaemonLifecycle = new AsyncLocalStorage<true>();

/**
 * Run a liveness operation (a heartbeat or a recovery attempt) that must never start, restart or
 * stop the daemon. Any connection it has to establish is observation-only: it fails when the
 * daemon is not reachable instead of launching one, and it skips the version/build reconciliation
 * that can restart a daemon. Other harnesses share that daemon.
 */
export function runWithoutDaemonLifecycle<T>(operation: () => Promise<T>): Promise<T> {
  return withoutDaemonLifecycle.run(true, operation);
}

/** Whether the current async context may manage the daemon's lifecycle when it connects. */
export function daemonLifecycleAllowed(): boolean {
  return withoutDaemonLifecycle.getStore() !== true;
}

/** Automatic recovery attempts per session and per state before the harness is handed over to. */
export const LIVENESS_RECOVERY_ATTEMPTS = 3;

export const DAEMON_STALLED_CODE = "daemon_stalled";
export const PROXY_STALLED_CODE = "proxy_stalled";

export type LivenessStallCode = typeof DAEMON_STALLED_CODE | typeof PROXY_STALLED_CODE;

/**
 * Time left unspent before the daemon would release a session, so the last attempt never ends on
 * the reaper's own boundary.
 */
export const RECOVERY_SAFETY_MARGIN_MS = 1_000;

/** Recovery action named to the harness for each state. */
export const RESTART_DAEMON_THEN_RESUME_ACTION = "restart_daemon_then_resume_by_session_uuid";
export const REACQUIRE_LOST_SESSIONS_ACTION = "reacquire_lost_sessions";

/** How long a session survives without an acknowledged heartbeat: the lease plus its suspect grace. */
export function livenessBudgetMs(leaseMs: number): number {
  return leaseMs + SUSPECT_GRACE_MS;
}

/**
 * The longest a tool call or resource read waits for liveness recovery before it goes ahead (#10508).
 *
 * Recovery spreads its attempts over the whole lease-plus-grace budget, which is right for the
 * session but not for a caller: with a long lease (fault injection sets an hour) one slot alone
 * would outlast any MCP client's request timeout, and the call that would let the daemon resume
 * the session never reaches it. A caller waits for the budget, but never longer than it takes
 * every attempt to get one heartbeat request's answer and one more request's spacing.
 */
export function livenessRecoveryCallWaitMs(leaseMs: number, requestTimeoutMs: number): number {
  return Math.min(livenessBudgetMs(leaseMs), LIVENESS_RECOVERY_ATTEMPTS * 2 * requestTimeoutMs);
}

/**
 * How long a challenger keeps claiming a session whose owner keeps renewing its lease (#10701).
 * A restarted harness's old proxy exits when its stdin closes, normally within seconds of the new
 * proxy starting; a minute covers a slow shutdown. An owner still renewing after that is a live
 * owner, not a handoff in progress, and the challenger gives up.
 */
export const LIVE_OWNER_HANDOFF_ALLOWANCE_MS = 60_000;

/**
 * How far a refusal's reported hold end must move past the latest one seen to count as the owner
 * renewing its lease, rather than request latency jittering the same hold end.
 */
const OWNER_HOLD_RENEWAL_TOLERANCE_MS = 1_000;

/** The owner's hold as a `liveness_owner_conflict` refusal reports it (#10701). */
export interface ReportedOwnerHold {
  /** Milliseconds until the owner's hold (lease plus suspect grace) ends. */
  holdRemainingMs: number;
}

/** A challenger's view of one session's ownership conflict. */
export interface OwnerConflictLeash {
  /** Proxy-clock time of the first refusal. */
  since: number;
  /** Latest proxy-clock time the daemon reported the owner's hold to end. */
  holdEndsAt?: number;
}

/**
 * Fold one refused claim into the conflict's leash and say whether the challenger should give up.
 *
 * The leash follows the daemon's report of the owner's hold, not the challenger's own lease
 * config: a daemon lease longer than the proxy's, or an old owner still stopping, is waited out.
 * Only an owner that renews its hold after the handoff allowance has passed is a live owner the
 * challenger cannot win against. A refusal without a report (an older daemon) falls back to
 * `fallbackLeashMs` from the first refusal.
 */
export function advanceOwnerConflictLeash(
  previous: OwnerConflictLeash | undefined,
  now: number,
  hold: ReportedOwnerHold | undefined,
  fallbackLeashMs: number,
): { leash: OwnerConflictLeash; exhausted: boolean } {
  const since = previous?.since ?? now;
  if (!hold) {
    return { leash: { ...previous, since }, exhausted: now - since >= fallbackLeashMs };
  }
  const reportedEnd = now + hold.holdRemainingMs;
  const seenEnd = previous?.holdEndsAt ?? reportedEnd;
  // A hold that has (all but) run out is the end of the one already seen, not a renewal: the
  // next claim wins.
  if (hold.holdRemainingMs <= OWNER_HOLD_RENEWAL_TOLERANCE_MS) {
    return { leash: { since, holdEndsAt: seenEnd }, exhausted: false };
  }
  const renewed = reportedEnd > seenEnd + OWNER_HOLD_RENEWAL_TOLERANCE_MS;
  return {
    leash: { since, holdEndsAt: Math.max(seenEnd, reportedEnd) },
    exhausted: renewed && now - since >= LIVE_OWNER_HANDOFF_ALLOWANCE_MS,
  };
}

/**
 * How long a proxy keeps retrying a claim another owner refuses (#10050). The other owner's
 * session can stay refused for its whole lease plus the suspect grace window, and the retry that
 * wins lands one heartbeat cadence after the daemon lets go, so all three are covered.
 */
export function ownershipConflictLeashMs(leaseMs: number, intervalMs: number): number {
  return livenessBudgetMs(leaseMs) + intervalMs;
}

/**
 * The time given to each of the recovery attempts for one session, measured from `now`.
 *
 * While a real share of the lease-plus-grace budget after the last acknowledged heartbeat is left,
 * the slots divide it, so all attempts complete inside it whatever the heartbeat cadence. A budget
 * that is already (nearly) spent says nothing about the daemon: after a long proxy stall the
 * daemon may have forgiven its own stall and still hold the session, and an attempt shorter than
 * a normal heartbeat could not tell a slow daemon from a dead one. Each attempt then gets the
 * heartbeat request timeout, the time a regular heartbeat is given to be answered.
 */
export function recoveryAttemptSlotMs(params: {
  leaseMs: number;
  lastAckAt: number;
  now: number;
  /** How long a regular heartbeat is given before it counts as unanswered. */
  requestTimeoutMs: number;
}): number {
  const remaining =
    params.lastAckAt + livenessBudgetMs(params.leaseMs) - RECOVERY_SAFETY_MARGIN_MS - params.now;
  const budgetSlot = Math.floor(remaining / LIVENESS_RECOVERY_ATTEMPTS);
  return budgetSlot >= params.requestTimeoutMs / 2 ? budgetSlot : params.requestTimeoutMs;
}

/** Measures how much later than its cadence a periodic tick fired. */
export class TickLatenessClock {
  private lastTickAt: number | undefined;

  constructor(private readonly intervalMs: number) {}

  /** Record a tick starting at `now`; returns how late it was (0 for the first tick). */
  note(now: number): number {
    const lateness =
      this.lastTickAt === undefined ? 0 : Math.max(0, now - this.lastTickAt - this.intervalMs);
    this.lastTickAt = now;
    return lateness;
  }

  /** Forget the previous tick, e.g. when the keeper stops and a later start is not "late". */
  reset(): void {
    this.lastTickAt = undefined;
  }
}

export interface StalledSession {
  sessionUuid: string;
  /** Null when this proxy never learned the session's device. */
  deviceId: string | null;
  /** Proxy clock reading (ms) of this session's last acknowledged heartbeat. */
  lastAcknowledgedHeartbeatAt: number;
}

/** What the harness receives once automatic recovery has been exhausted. */
export interface LivenessHandover {
  code: LivenessStallCode;
  /** `daemon_stalled`: the sessions that could not be reached. `proxy_stalled`: the lost sessions. */
  sessions: StalledSession[];
  /** Most recovery attempts made for any listed session. */
  attempts: number;
  /** Latest acknowledged heartbeat across the listed sessions (proxy clock, ms). */
  lastAcknowledgedHeartbeatAt: number;
  action: typeof RESTART_DAEMON_THEN_RESUME_ACTION | typeof REACQUIRE_LOST_SESSIONS_ACTION;
  /**
   * What stalled first, when it differs from `code`: a `proxy_stalled` loss reported after a
   * `daemon_stalled` handover came from a daemon stall, not a proxy one (#10991). Message wording
   * only; it is not part of the wire payload.
   */
  stalledBy?: "daemon";
}

function describeSessions(sessions: readonly StalledSession[]): string {
  return sessions
    .map(({ sessionUuid, deviceId }) => (deviceId ? `${sessionUuid} (${deviceId})` : sessionUuid))
    .join(", ");
}

export function livenessHandoverMessage(handover: LivenessHandover): string {
  const sessions = describeSessions(handover.sessions);
  if (handover.code === DAEMON_STALLED_CODE) {
    return (
      `The AutoMobile daemon stopped acknowledging heartbeats for ${sessions}. This proxy made ` +
      `${handover.attempts} automatic recovery attempts (reconnect and re-heartbeat with the same ` +
      `owner token) and has stopped. It never restarts the daemon because other harnesses share ` +
      `it: restart the daemon yourself, then resume each session by passing its sessionUuid.`
    );
  }
  if (handover.stalledBy === "daemon") {
    return (
      `The AutoMobile daemon stalled and stopped acknowledging heartbeats; once it answered again ` +
      `it reported that it released ${sessions} or that another liveness owner has taken them ` +
      `over. This MCP proxy itself did not stall. Reacquire the devices with getAndroid or getApple.`
    );
  }
  return (
    `This MCP proxy stalled for longer than the heartbeat lease and could not restore ${sessions} ` +
    `after ${handover.attempts} automatic attempt(s): the daemon answered that it released them ` +
    `or that another liveness owner has taken them over. Reacquire the devices with getAndroid ` +
    `or getApple.`
  );
}

/** The structured error body returned on a tool call and sent in the MCP notification. */
export function livenessHandoverPayload(handover: LivenessHandover) {
  return {
    error: {
      code: handover.code,
      message: livenessHandoverMessage(handover),
      sessions: handover.sessions.map((session) => ({ ...session })),
      attempts: handover.attempts,
      maxAttempts: LIVENESS_RECOVERY_ATTEMPTS,
      lastAcknowledgedHeartbeatAt: handover.lastAcknowledgedHeartbeatAt,
      retryable: true,
      recovery: { action: handover.action },
    },
  };
}

/** Code of the warning a tool result carries once a handed-over session is resumed (#10989). */
export const DAEMON_STALL_RESUMED_CODE = "daemon_stall_resumed";

/**
 * The warning the first tool call to reach a session resumed after a `daemon_stalled` handover
 * carries: the harness was told the session stalled, and now learns it needs nothing restarted.
 */
export function livenessResumedNotice(handover: LivenessHandover, sessionUuid: string) {
  const session = handover.sessions.find((entry) => entry.sessionUuid === sessionUuid);
  return {
    warning: {
      code: DAEMON_STALL_RESUMED_CODE,
      message:
        `The AutoMobile daemon stopped acknowledging heartbeats for session ${sessionUuid} and ` +
        `this proxy reported ${handover.code}. The daemon answered again and still held the ` +
        `session, so it was resumed with the same UUID: disregard that handover, nothing needs ` +
        `restarting.`,
      sessionUuid,
      deviceId: session?.deviceId ?? null,
      handedOverCode: handover.code,
    },
  };
}

/**
 * - `acknowledged`: the daemon answered the heartbeat; the session is live (or restored).
 * - `session-gone`: the daemon answered that it does not know the session.
 * - `superseded`: the daemon answered that another token now owns the session's liveness, so this
 *   proxy was displaced while it could not heartbeat.
 * - `unreachable`: no acknowledgement (error or the attempt's time slot ran out).
 */
export type RecoveryAttemptOutcome = "acknowledged" | "session-gone" | "superseded" | "unreachable";

export interface LivenessRecoveryDeps {
  timer: Timer;
  /** The heartbeat lease the proxy believes the daemon enforces. */
  leaseMs: number;
  /** How long a regular heartbeat is given before it counts as unanswered. */
  requestTimeoutMs: number;
  lastAckAt(sessionUuid: string): number;
  /** Whether the daemon acknowledged a heartbeat for the session after `sinceMs` (proxy clock). */
  hasAcknowledgedSince(sessionUuid: string, sinceMs: number): boolean;
  deviceIdOf(sessionUuid: string): string | undefined;
  /** False once the session is no longer held or the proxy is closing. */
  isActive(sessionUuid: string): boolean;
  /**
   * One reconnect-if-needed and re-heartbeat with the proxy's owner token. `claimSocketReset`
   * returns true at most once per recovery episode, shared by every session in it: the daemon
   * socket is one connection for all of the proxy's sessions, so only one attempt per episode may
   * replace it.
   */
  attempt(
    sessionUuid: string,
    attemptNumber: number,
    deadlineMs: number,
    claimSocketReset: () => boolean,
  ): Promise<RecoveryAttemptOutcome>;
  onRecovered(info: {
    sessionUuid: string;
    code: LivenessStallCode;
    attempts: number;
    /** The lease had already lapsed, so the daemon held the session as suspect. */
    restoredAfterLapse: boolean;
  }): void;
  /** The daemon answered that a `daemon_stalled` session no longer exists. */
  onSessionGone(sessionUuid: string, code: LivenessStallCode): void;
  onHandover(handover: LivenessHandover): void;
}

/** A session whose automatic recovery failed, held by its episode until the handover. */
interface FailedSession {
  session: StalledSession;
  /** The state to report it under: `proxy_stalled` only when the daemon said it was lost. */
  code: LivenessStallCode;
  attempts: number;
  /** Set when a daemon stall led to this `proxy_stalled` loss (#10991). */
  stalledBy?: "daemon";
  /** Proxy clock reading when recovery gave up on it. */
  failedAt: number;
}

interface Episode {
  pending: number;
  failed: Map<string, FailedSession>;
}

interface AttemptOutcomeContext {
  sessionUuid: string;
  code: LivenessStallCode;
  episode: Episode;
  attempt: number;
  outcome: RecoveryAttemptOutcome;
  restoredAfterLapse: boolean;
  deviceAtStart: string | undefined;
}

const HANDOVER_ORDER: readonly LivenessStallCode[] = [DAEMON_STALLED_CODE, PROXY_STALLED_CODE];

/**
 * Runs bounded recovery for each session that lost its acknowledgements. Sessions entering the same
 * state while it is still open share one episode, so the harness gets one handover naming them all.
 * A session that failed stays held by its episode, and is not recovered again, until that handover.
 */
export class LivenessRecovery {
  private readonly recovering = new Map<string, Promise<void>>();
  private readonly episodes = new Map<LivenessStallCode, Episode>();
  private readonly sleepers = new Set<() => void>();
  private readonly stopSignal = new AbortController();
  private socketResetClaimed = false;
  private stopped = false;
  private busyGeneration = 0;

  constructor(private readonly deps: LivenessRecoveryDeps) {}

  /**
   * Identifies the current stretch of recovery: it changes each time recovery starts while none
   * was running, and stays the same for every session that joins before all of them settle. Lets a
   * caller bound its wait once per stretch rather than once per call (#10508).
   */
  busyEpisode(): number {
    return this.busyGeneration;
  }

  /** Whether the session is being recovered, or failed and awaits its episode's handover. */
  isRecovering(sessionUuid: string): boolean {
    return (
      this.recovering.has(sessionUuid) ||
      [...this.episodes.values()].some((episode) => episode.failed.has(sessionUuid))
    );
  }

  /** Start recovering a session; a no-op while it already is (or awaits a handover). */
  begin(sessionUuid: string, code: LivenessStallCode): void {
    if (this.stopped || this.isRecovering(sessionUuid)) {
      return;
    }
    let episode = this.episodes.get(code);
    if (!episode) {
      episode = { pending: 0, failed: new Map() };
      this.episodes.set(code, episode);
    }
    episode.pending += 1;
    if (this.recovering.size === 0) {
      this.busyGeneration += 1;
    }
    const run = this.run(sessionUuid, code, episode).finally(() => {
      this.recovering.delete(sessionUuid);
      this.finishEpisodeMember(code, episode);
    });
    this.recovering.set(sessionUuid, run);
  }

  /** Abandon all recovery without handing over (the proxy is closing), cutting any wait short. */
  stop(): void {
    this.stopped = true;
    this.stopSignal.abort();
    for (const wake of [...this.sleepers]) {
      wake();
    }
  }

  /** Resolves when every recovery in flight has settled. For tests and shutdown. */
  async settled(): Promise<void> {
    await Promise.all([...this.recovering.values()]);
  }

  private readonly claimSocketReset = (): boolean => {
    if (this.socketResetClaimed) {
      return false;
    }
    this.socketResetClaimed = true;
    return true;
  };

  private async run(sessionUuid: string, code: LivenessStallCode, episode: Episode): Promise<void> {
    const startedAt = this.deps.timer.now();
    // The proxy may forget the session's device while attempts run (a release or not-found
    // answer on the heartbeat tick), but the handover still has to name it (#10991).
    const deviceAtStart = this.deps.deviceIdOf(sessionUuid);
    // Captured first: a successful attempt records a fresh acknowledgement.
    const lastAckBefore = this.deps.lastAckAt(sessionUuid);
    const slotMs = recoveryAttemptSlotMs({
      leaseMs: this.deps.leaseMs,
      lastAckAt: lastAckBefore,
      now: startedAt,
      requestTimeoutMs: this.deps.requestTimeoutMs,
    });
    for (let attempt = 1; attempt <= LIVENESS_RECOVERY_ATTEMPTS; attempt += 1) {
      if (this.stopped || !this.deps.isActive(sessionUuid)) {
        return;
      }
      const outcome = await this.runAttempt(sessionUuid, attempt, slotMs);
      if (this.stopped) {
        return;
      }
      const restoredAfterLapse = startedAt - lastAckBefore > this.deps.leaseMs;
      if (
        this.settle({
          sessionUuid,
          code,
          episode,
          attempt,
          outcome,
          restoredAfterLapse,
          deviceAtStart,
        })
      ) {
        return;
      }
      await this.waitForSlotEnd(startedAt + attempt * slotMs, attempt);
    }
    // No attempt got an answer. A daemon that does not answer is stalled, whatever stalled the
    // proxy first; only an answer from the daemon proves a session lost.
    this.markFailed({
      sessionUuid,
      episode,
      code: DAEMON_STALLED_CODE,
      attempts: LIVENESS_RECOVERY_ATTEMPTS,
      deviceAtStart,
    });
  }

  /** Act on an attempt's outcome; true when recovery for the session is over. */
  private settle(context: AttemptOutcomeContext): boolean {
    const { sessionUuid, code, episode, attempt, outcome } = context;
    if (outcome === "acknowledged") {
      this.deps.onRecovered({
        sessionUuid,
        code,
        attempts: attempt,
        restoredAfterLapse: context.restoredAfterLapse,
      });
      return true;
    }
    if (outcome === "session-gone" && code === DAEMON_STALLED_CODE) {
      this.deps.onSessionGone(sessionUuid, code);
      return true;
    }
    if (outcome === "session-gone" || outcome === "superseded") {
      // The daemon answered that the session is released or now belongs to another owner: the
      // loss the `proxy_stalled` handover reports, with the session fenced.
      this.markFailed({
        sessionUuid,
        episode,
        code: PROXY_STALLED_CODE,
        attempts: attempt,
        deviceAtStart: context.deviceAtStart,
        stalledBy: code === DAEMON_STALLED_CODE ? "daemon" : undefined,
      });
      return true;
    }
    return false;
  }

  private async runAttempt(
    sessionUuid: string,
    attempt: number,
    slotMs: number,
  ): Promise<RecoveryAttemptOutcome> {
    try {
      return await raceWithDeadline(
        () => this.deps.attempt(sessionUuid, attempt, slotMs, this.claimSocketReset),
        {
          timer: this.deps.timer,
          timeoutMs: slotMs,
          signal: this.stopSignal.signal,
          label: "Liveness recovery heartbeat",
        },
      );
    } catch (error) {
      // A rejected or timed-out attempt is the failure this loop exists to count; the handover
      // reports how many were made.
      logger.debug(
        `[LivenessRecovery] attempt ${attempt} for ${sessionUuid} got no acknowledgement: ${errorMessage(error)}`,
      );
      return "unreachable";
    }
  }

  /** Spread attempts over the budget so a fast refusal does not burn all three at once. */
  private async waitForSlotEnd(slotEnd: number, attempt: number): Promise<void> {
    const remaining = slotEnd - this.deps.timer.now();
    if (attempt < LIVENESS_RECOVERY_ATTEMPTS && remaining > 0) {
      await this.sleepUnlessStopped(remaining);
    }
  }

  /** A sleep that {@link stop} cuts short, cancelling its timer. */
  private sleepUnlessStopped(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const wake = () => {
        this.deps.timer.clearTimeout(handle);
        this.sleepers.delete(wake);
        resolve();
      };
      const handle = this.deps.timer.setTimeout(wake, ms);
      this.sleepers.add(wake);
    });
  }

  private markFailed(failure: {
    sessionUuid: string;
    episode: Episode;
    code: LivenessStallCode;
    attempts: number;
    deviceAtStart: string | undefined;
    stalledBy?: "daemon";
  }): void {
    const { sessionUuid, episode, code, attempts, deviceAtStart, stalledBy } = failure;
    episode.failed.set(sessionUuid, {
      ...(stalledBy ? { stalledBy } : {}),
      session: {
        sessionUuid,
        deviceId: this.deps.deviceIdOf(sessionUuid) ?? deviceAtStart ?? null,
        lastAcknowledgedHeartbeatAt: this.deps.lastAckAt(sessionUuid),
      },
      code,
      attempts,
      failedAt: this.deps.timer.now(),
    });
  }

  private finishEpisodeMember(code: LivenessStallCode, episode: Episode): void {
    episode.pending -= 1;
    if (episode.pending > 0) {
      return;
    }
    if (this.episodes.get(code) === episode) {
      this.episodes.delete(code);
    }
    if (this.episodes.size === 0) {
      // The next episode may replace the shared socket once again.
      this.socketResetClaimed = false;
    }
    if (this.stopped) {
      return;
    }
    // A session the daemon acknowledged after it failed is healthy again: fencing it on the
    // strength of a stale failure would strand a live session.
    const failed = [...episode.failed.values()].filter(
      (entry) => !this.deps.hasAcknowledgedSince(entry.session.sessionUuid, entry.failedAt),
    );
    for (const handoverCode of HANDOVER_ORDER) {
      this.handOver(
        handoverCode,
        failed.filter((entry) => entry.code === handoverCode),
      );
    }
  }

  private handOver(code: LivenessStallCode, failed: readonly FailedSession[]): void {
    if (failed.length === 0) {
      return;
    }
    const sessions = failed.map((entry) => entry.session);
    this.deps.onHandover({
      code,
      sessions,
      attempts: Math.max(...failed.map((entry) => entry.attempts)),
      lastAcknowledgedHeartbeatAt: Math.max(
        ...sessions.map((session) => session.lastAcknowledgedHeartbeatAt),
      ),
      action:
        code === DAEMON_STALLED_CODE
          ? RESTART_DAEMON_THEN_RESUME_ACTION
          : REACQUIRE_LOST_SESSIONS_ACTION,
      ...(failed.every((entry) => entry.stalledBy === "daemon") ? { stalledBy: "daemon" } : {}),
    });
  }
}

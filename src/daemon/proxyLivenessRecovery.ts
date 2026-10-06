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

/** The shortest a recovery attempt is given, however little of the budget is left. */
export const MIN_RECOVERY_ATTEMPT_MS = 250;

/** Recovery action named to the harness for each state. */
export const RESTART_DAEMON_THEN_RESUME_ACTION = "restart_daemon_then_resume_by_session_uuid";
export const REACQUIRE_LOST_SESSIONS_ACTION = "reacquire_lost_sessions";

/** How long a session survives without an acknowledged heartbeat: the lease plus its suspect grace. */
export function livenessBudgetMs(leaseMs: number): number {
  return leaseMs + SUSPECT_GRACE_MS;
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
 * The time given to each of the recovery attempts for one session, measured from `now`. The slots
 * divide whatever remains of the lease-plus-grace budget after the last acknowledged heartbeat, so
 * all attempts complete inside it whatever the heartbeat cadence; once the budget is already
 * spent each attempt still gets {@link MIN_RECOVERY_ATTEMPT_MS}.
 */
export function recoveryAttemptSlotMs(params: {
  leaseMs: number;
  lastAckAt: number;
  now: number;
}): number {
  const remaining =
    params.lastAckAt + livenessBudgetMs(params.leaseMs) - RECOVERY_SAFETY_MARGIN_MS - params.now;
  return Math.max(MIN_RECOVERY_ATTEMPT_MS, Math.floor(remaining / LIVENESS_RECOVERY_ATTEMPTS));
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
  return (
    `This MCP proxy stalled for longer than the heartbeat lease and could not restore ${sessions} ` +
    `after ${handover.attempts} automatic attempts: the daemon released them. Reacquire the ` +
    `devices with getAndroid or getApple.`
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

/**
 * - `acknowledged`: the daemon answered the heartbeat; the session is live (or restored).
 * - `session-gone`: the daemon answered that it does not know the session.
 * - `unreachable`: no acknowledgement (error or the attempt's time slot ran out).
 */
export type RecoveryAttemptOutcome = "acknowledged" | "session-gone" | "unreachable";

export interface LivenessRecoveryDeps {
  timer: Timer;
  /** The heartbeat lease the proxy believes the daemon enforces. */
  leaseMs: number;
  lastAckAt(sessionUuid: string): number;
  deviceIdOf(sessionUuid: string): string | undefined;
  /** False once the session is no longer held or the proxy is closing. */
  isActive(sessionUuid: string): boolean;
  /** One reconnect-if-needed and re-heartbeat with the proxy's owner token. */
  attempt(
    sessionUuid: string,
    attemptNumber: number,
    deadlineMs: number,
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

interface Episode {
  pending: number;
  failed: Map<string, StalledSession>;
  attempts: number;
}

/**
 * Runs bounded recovery for each session that lost its acknowledgements. Sessions entering the same
 * state while it is still open share one episode, so the harness gets one handover naming them all.
 */
export class LivenessRecovery {
  private readonly recovering = new Map<string, Promise<void>>();
  private readonly episodes = new Map<LivenessStallCode, Episode>();
  private stopped = false;

  constructor(private readonly deps: LivenessRecoveryDeps) {}

  isRecovering(sessionUuid: string): boolean {
    return this.recovering.has(sessionUuid);
  }

  /** Start recovering a session; a no-op while it already is. */
  begin(sessionUuid: string, code: LivenessStallCode): void {
    if (this.stopped || this.recovering.has(sessionUuid)) {
      return;
    }
    let episode = this.episodes.get(code);
    if (!episode) {
      episode = { pending: 0, failed: new Map(), attempts: 0 };
      this.episodes.set(code, episode);
    }
    episode.pending += 1;
    const run = this.run(sessionUuid, code, episode).finally(() => {
      this.recovering.delete(sessionUuid);
      this.finishEpisodeMember(code, episode);
    });
    this.recovering.set(sessionUuid, run);
  }

  /** Stop all recovery without handing over (the proxy is closing). */
  stop(): void {
    this.stopped = true;
  }

  /** Resolves when every recovery in flight has settled. For tests and shutdown. */
  async settled(): Promise<void> {
    await Promise.all([...this.recovering.values()]);
  }

  private async run(sessionUuid: string, code: LivenessStallCode, episode: Episode): Promise<void> {
    const startedAt = this.deps.timer.now();
    // Captured first: a successful attempt records a fresh acknowledgement.
    const lastAckBefore = this.deps.lastAckAt(sessionUuid);
    const slotMs = recoveryAttemptSlotMs({
      leaseMs: this.deps.leaseMs,
      lastAckAt: lastAckBefore,
      now: startedAt,
    });
    for (let attempt = 1; attempt <= LIVENESS_RECOVERY_ATTEMPTS; attempt += 1) {
      if (this.stopped || !this.deps.isActive(sessionUuid)) {
        return;
      }
      episode.attempts = Math.max(episode.attempts, attempt);
      const outcome = await this.runAttempt(sessionUuid, attempt, slotMs);
      if (this.stopped) {
        return;
      }
      if (outcome === "acknowledged") {
        this.deps.onRecovered({
          sessionUuid,
          code,
          attempts: attempt,
          restoredAfterLapse: startedAt - lastAckBefore > this.deps.leaseMs,
        });
        return;
      }
      if (outcome === "session-gone") {
        this.sessionGone(sessionUuid, code, episode);
        return;
      }
      await this.waitForSlotEnd(startedAt + attempt * slotMs, attempt);
    }
    this.markFailed(sessionUuid, episode);
  }

  private async runAttempt(
    sessionUuid: string,
    attempt: number,
    slotMs: number,
  ): Promise<RecoveryAttemptOutcome> {
    try {
      return await raceWithDeadline(() => this.deps.attempt(sessionUuid, attempt, slotMs), {
        timer: this.deps.timer,
        timeoutMs: slotMs,
        label: "Liveness recovery heartbeat",
      });
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
      await this.deps.timer.sleep(remaining);
    }
  }

  private sessionGone(sessionUuid: string, code: LivenessStallCode, episode: Episode): void {
    if (code === DAEMON_STALLED_CODE) {
      this.deps.onSessionGone(sessionUuid, code);
      return;
    }
    // A proxy that was stalled past lease plus grace finds its session released: that is the
    // loss the `proxy_stalled` handover reports.
    this.markFailed(sessionUuid, episode);
  }

  private markFailed(sessionUuid: string, episode: Episode): void {
    episode.failed.set(sessionUuid, {
      sessionUuid,
      deviceId: this.deps.deviceIdOf(sessionUuid) ?? null,
      lastAcknowledgedHeartbeatAt: this.deps.lastAckAt(sessionUuid),
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
    if (this.stopped || episode.failed.size === 0) {
      return;
    }
    const sessions = [...episode.failed.values()];
    this.deps.onHandover({
      code,
      sessions,
      attempts: episode.attempts,
      lastAcknowledgedHeartbeatAt: Math.max(
        ...sessions.map((session) => session.lastAcknowledgedHeartbeatAt),
      ),
      action:
        code === DAEMON_STALLED_CODE
          ? RESTART_DAEMON_THEN_RESUME_ACTION
          : REACQUIRE_LOST_SESSIONS_ACTION,
    });
  }
}

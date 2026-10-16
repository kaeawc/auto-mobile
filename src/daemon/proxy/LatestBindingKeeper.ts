import type { Timer } from "../../utils/SystemTimer";
import { logger } from "../../utils/logger";
import type { TickLatenessClock } from "../proxyLivenessRecovery";
import type { SingleFlightInterval } from "../SingleFlightInterval";
import type { BoundSessionHeartbeat } from "./BoundSessionHeartbeat";
import type { ProxySessionState } from "./ProxySessionState";

/**
 * Proxy operations the keeper lifecycle shares with transport and idle policy:
 * - isClosing and isTransportLive read the live mutable shutdown and connection state.
 * - heartbeatWithStallDetection shares the stall-detecting heartbeat wrapper with the held-session keeper.
 * - isBoundSessionReplayExpired and retireIdleBinding share the replay-lease policy.
 */
export interface LatestBindingKeeperPort {
  isClosing(): boolean;
  isTransportLive(): boolean;
  heartbeatWithStallDetection(
    sessionUuid: string,
    send: (isCurrent: () => boolean) => Promise<void>,
  ): Promise<void>;
  isBoundSessionReplayExpired(): boolean;
  retireIdleBinding(sessionUuid: string): void;
}

export interface LatestBindingKeeperDependencies {
  timer: Timer;
  state: ProxySessionState;
  keeper: Pick<SingleFlightInterval, "start" | "stop" | "run">;
  tickLateness: Pick<TickLatenessClock, "note" | "reset">;
  boundHeartbeat: Pick<BoundSessionHeartbeat, "sendBoundSessionHeartbeat">;
  heartbeatIntervalMs: number;
  heartbeatLeashMs: number;
  port: LatestBindingKeeperPort;
}

/**
 * Runs the heartbeat keeper for the latest binding and the sessions held beside it: which
 * sessions it has to heartbeat, when it starts and stops, and the latest binding's tick (#11411,
 * #11400).
 */
export class LatestBindingKeeper {
  /** Whether the keeper's recurring interval is running; cleared the moment a stop is requested. */
  started = false;

  private readonly timer: Timer;
  private readonly state: ProxySessionState;
  private readonly keeper: LatestBindingKeeperDependencies["keeper"];
  private readonly tickLateness: LatestBindingKeeperDependencies["tickLateness"];
  private readonly boundHeartbeat: LatestBindingKeeperDependencies["boundHeartbeat"];
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatLeashMs: number;
  private readonly port: LatestBindingKeeperPort;

  constructor(deps: LatestBindingKeeperDependencies) {
    this.timer = deps.timer;
    this.state = deps.state;
    this.keeper = deps.keeper;
    this.tickLateness = deps.tickLateness;
    this.boundHeartbeat = deps.boundHeartbeat;
    this.heartbeatIntervalMs = deps.heartbeatIntervalMs;
    this.heartbeatLeashMs = deps.heartbeatLeashMs;
    this.port = deps.port;
  }

  /**
   * Heartbeat state machine (#11411, #11400). The proxy tracks the LATEST binding
   * (`boundSessionUuid`), the sessions it HOLDS besides it (`otherHeldSessions`) and one terminal
   * FENCE (`terminalBoundSession`); the keeper is one interval for all of them.
   *
   * | state of a session                                   | keeper     | heartbeated | its next call             |
   * | ---------------------------------------------------- | ---------- | ----------- | ------------------------- |
   * | latest, claimable (minted here or startup-declared)  | runs       | every tick  | forwarded                 |
   * | latest, only named in a call's args (#10664)         | for others | never       | forwarded                 |
   * | held                                                 | runs       | every tick  | forwarded                 |
   * | latest or held, inside its not-found window: a       | runs       | once a tick,| forwarded: the daemon     |
   * |   heartbeat was answered not-found with a recoverable|            | claiming, no| restores it or refuses    |
   * |   reason (a daemon restart or shutdown,              |            | socket reset|                           |
   * |   `device-restart:<id>`, #11461), or with any answer |            |             |                           |
   * |   that does not end it as its first on a connection  |            |             |                           |
   * |   that was just established (a restarted daemon that |            |             |                           |
   * |   has not rehydrated it; #11529, #11557, #11570)     |            |             |                           |
   * | latest, stopped: answered not-found past its window, | for others | not until a | forwarded: the daemon     |
   * |   or with no reason on a connection that had answered|            | call reaches| restores it or refuses,   |
   * |   before (asked once more on a fresh one)            |            | it again    | and success re-arms it    |
   * | held, stopped the same way: dropped                  | for others | not until a | forwarded; the daemon's   |
   * |                                                      |            | call uses it| echo of use holds it again|
   * | held, answered not-found with a reason that ends it  | for others | never       | forwarded, daemon refuses |
   * | fenced (the latest, for any release reason that is   | for others | never       | refused locally           |
   * |   not recoverable, an expired replay lease or        |            |             |                           |
   * |   exhausted liveness recovery)                       |            |             |                           |
   *
   * "for others" means the session itself asks for no keeper: the keeper runs exactly when some
   * session in a "runs" row exists ({@link hasHeartbeatTargets}), whatever became of its siblings.
   * A fence never coexists with a latest binding. A release reason is classified in one place,
   * {@link releaseKeepsBinding}, for the release notification and every not-found heartbeat alike,
   * and what a not-found heartbeat answer means is decided in one place,
   * {@link decideNotFoundAnswer}, from that session's own state, whichever heartbeat heard it: a
   * keeper tick, the first heartbeat of a connection or liveness recovery. The whole machine is
   * written out as states and events in test/daemon/proxyHeartbeatStateMachine.property.test.ts.
   * {@link syncHeartbeatKeeper} is the one place that starts the keeper, and the one that stops it
   * because nothing is left to heartbeat. The only other stops are awaited pauses with sessions
   * still held: binding a result-minted session (which syncs again on every way out), a one-shot
   * CLI handing its session to the daemon's idle timeout, and close().
   */
  hasHeartbeatTargets(): boolean {
    return this.state.otherHeldSessions.size > 0 || this.latestBindingHeartbeatable();
  }

  /** The latest binding is claimable and the daemon has not answered not-found for it. */
  latestBindingHeartbeatable(): boolean {
    return (
      this.latestBindingClaimable() && !this.state.notFoundStopped.has(this.state.boundSessionUuid!)
    );
  }

  /**
   * Make the keeper match the table above: stopped once nothing is left to heartbeat, running
   * while anything is. Called wherever the latest binding, the held set or the fence changes. A
   * keeper that lost its transport keeps running: its tick drives the reconnect.
   */
  syncHeartbeatKeeper(): void {
    if (!this.hasHeartbeatTargets()) {
      if (this.started) {
        // Cleared now, not once the tick in flight settles: a session held again meanwhile
        // must find the keeper stopped and restart it.
        this.started = false;
        this.tickLateness.reset();
        void this.keeper.stop();
      }
      return;
    }
    if (this.started || this.port.isClosing() || !this.port.isTransportLive()) {
      return;
    }
    // A fresh cadence, seeded so even its first tick can be recognised as late (#10053).
    this.tickLateness.note(this.timer.now());
    this.keeper.start();
    this.started = true;
  }

  startBoundSessionHeartbeat(): void {
    if (
      this.state.boundSessionUuid &&
      !this.state.terminalBoundSession &&
      // An args-named latest binding is never heartbeated (#10664); the keeper still runs
      // for the sessions this proxy holds besides it.
      (this.latestBindingClaimable() || this.state.otherHeldSessions.size > 0) &&
      this.port.isTransportLive() &&
      !this.port.isClosing()
    ) {
      void this.keeper.run();
      this.syncHeartbeatKeeper();
    }
  }

  async stopBoundSessionHeartbeat(): Promise<boolean> {
    const settled = await this.keeper.stop();
    this.started = false;
    // A later start is a fresh cadence, not a late tick.
    this.tickLateness.reset();
    if (!settled) {
      logger.warn("[DaemonMcpProxy] Bound-session heartbeat did not settle before shutdown");
    }
    return settled;
  }

  /** Every session this proxy heartbeats: the latest binding plus the ones it still holds. */
  heldSessionUuids(): string[] {
    const latest = this.latestBindingClaimable() ? [this.state.boundSessionUuid!] : [];
    return [...latest, ...this.state.otherHeldSessions.keys()];
  }

  /**
   * Whether the latest binding is one this proxy claims and heartbeats: live, and minted by this
   * proxy or configured at startup, never merely named in a tool call's args (#10664).
   */
  latestBindingClaimable(): boolean {
    return (
      this.state.boundSessionUuid !== undefined &&
      !this.state.terminalBoundSession &&
      this.state.claimableSessions.has(this.state.boundSessionUuid)
    );
  }

  isHeldSession(sessionUuid: string): boolean {
    return (
      (sessionUuid === this.state.boundSessionUuid && this.latestBindingClaimable()) ||
      this.state.otherHeldSessions.has(sessionUuid)
    );
  }

  async runLatestBindingHeartbeatTick(): Promise<void> {
    const sessionUuid = this.state.boundSessionUuid;
    if (!sessionUuid || !this.latestBindingClaimable() || this.port.isClosing()) {
      return;
    }
    if (this.state.notFoundStopped.has(sessionUuid)) {
      // The daemon answered that it does not know this session; heartbeating it again cannot help.
      this.retireIdleLatestBinding(sessionUuid);
      return;
    }
    // Heartbeat first, then judge idleness (#10972): the judgement uses this tick's report, and a
    // session the daemon already released answers not-found with its own reason, which the agent
    // then sees instead of the proxy's.
    // A caller that explicitly schedules heartbeats beyond the lease cannot
    // maintain daemon ownership by cadence. Preserve that opt-out's prior
    // single-flight behavior (used by replay-lease tests).
    try {
      if (this.heartbeatIntervalMs >= this.heartbeatLeashMs) {
        await this.boundHeartbeat.sendBoundSessionHeartbeat();
      } else {
        await this.port.heartbeatWithStallDetection(sessionUuid, (isCurrent) =>
          this.boundHeartbeat.sendBoundSessionHeartbeat(isCurrent),
        );
      }
    } finally {
      this.retireIdleLatestBinding(sessionUuid);
    }
  }

  /**
   * Backstop for a missed session-released notification (#10702): an idle binding is retired here,
   * so the keeper stops instead of heartbeating it until the next call arrives.
   */
  private retireIdleLatestBinding(sessionUuid: string): void {
    if (
      this.state.boundSessionUuid === sessionUuid &&
      !this.state.terminalBoundSession &&
      this.port.isBoundSessionReplayExpired()
    ) {
      this.port.retireIdleBinding(sessionUuid);
    }
  }
}

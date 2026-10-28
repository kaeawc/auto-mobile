import type { Timer } from "../../utils/SystemTimer";
import { logger } from "../../utils/logger";
import type { DaemonClientLike } from "../client/client";
import { DAEMON_HEARTBEAT_METHOD } from "../wire/constants";
import {
  DAEMON_LIVENESS_OWNER_SUPERSEDED_CODE,
  DAEMON_LIVENESS_OWNER_UNOWNED_CODE,
  daemonInstanceFromError,
  releaseReasonFromError,
} from "../types";
import {
  advanceOwnerConflictLeash,
  runWithoutDaemonLifecycle,
  type ReportedOwnerHold,
} from "../proxyLivenessRecovery";
import { DaemonBoundSessionExpiredError } from "./DaemonBoundSessionExpiredError";
import { HeldSessionNotFoundError } from "./HeldSessionNotFoundError";
import type { HeldSessionHeartbeatOutcomes } from "./HeldSessionHeartbeatOutcomes";
import type { HeldSessionLosses } from "./HeldSessionLosses";
import type { HeartbeatKeeperPort } from "./HeartbeatKeeper";
import { isLivenessOwnerConflictError, reportedOwnerHold } from "./livenessErrorPredicates";
import {
  RECOVERABLE_NOT_FOUND_HEARTBEAT_WINDOW_MS,
  decideNotFoundAnswer,
  type NotFoundAnswerOutcome,
} from "./notFoundDecision";
import type { LatestHeartbeatAsk, ProxySessionState } from "./ProxySessionState";

const NO_HANDOFFS: ReadonlySet<string> = new Set();

/**
 * Proxy operations the bound-session heartbeat shares with transport, routing and fencing:
 * - requireClient, withRecoverableReconnect and boundSessionHeartbeatParams share transport and wire handling.
 * - answersOwnershipReestablishment and noteHeartbeatDaemonInstance share connection and daemon-process evidence.
 * - noteDaemonIdleEvidence shares the daemon's idle-release reports.
 * - isDaemonSessionNotFoundError shares refusal classification.
 * - isHeldSession and latestBindingClaimable share the current binding and held-session selection.
 * - fenceBoundSessionUuid and dropHeldSession share terminal release policy.
 * - syncHeartbeatKeeper shares keeper reconciliation after a stop or re-arm.
 * - isClosing reads the live mutable shutdown flag.
 */
export interface BoundSessionHeartbeatPort {
  requireClient(): DaemonClientLike;
  boundSessionHeartbeatParams(
    sessionUuid: string,
    claimLivenessOwnership?: boolean,
    reportIdleRelease?: boolean,
  ): Record<string, unknown>;
  answersOwnershipReestablishment(client: DaemonClientLike | null, sessionUuid: string): boolean;
  noteHeartbeatDaemonInstance(sessionUuid: string, daemonInstance: string | undefined): boolean;
  noteDaemonIdleEvidence(sessionUuid: string, ack: unknown): void;
  isDaemonSessionNotFoundError(error: unknown): boolean;
  isHeldSession(sessionUuid: string): boolean;
  latestBindingClaimable(): boolean;
  withRecoverableReconnect: HeartbeatKeeperPort["withRecoverableReconnect"];
  fenceBoundSessionUuid(sessionUuid: string, reason: string): void;
  dropHeldSession(sessionUuid: string, keepHandover?: boolean, keepNotFoundHistory?: boolean): void;
  syncHeartbeatKeeper(): void;
  isClosing(): boolean;
}

export interface BoundSessionHeartbeatDependencies {
  timer: Timer;
  state: ProxySessionState;
  ownedDeviceSessions: Set<string>;
  ownershipConflictLeashMs: number;
  heartbeatOutcomes: Pick<
    HeldSessionHeartbeatOutcomes,
    "noteLivenessOwnerConflict" | "noteLateHeartbeatAck"
  >;
  heldSessionLosses: Pick<HeldSessionLosses, "recordNotFoundLoss">;
  port: BoundSessionHeartbeatPort;
}

/**
 * One heartbeat for a session this proxy holds, and what each answer means: acknowledgement
 * bookkeeping for the latest binding, the not-found decision and its application for the latest
 * binding and held sessions alike, and the ownership refusals with their leash.
 */
export class BoundSessionHeartbeat {
  private readonly timer: Timer;
  private readonly state: ProxySessionState;
  private readonly ownedDeviceSessions: Set<string>;
  private readonly ownershipConflictLeashMs: number;
  private readonly heartbeatOutcomes: BoundSessionHeartbeatDependencies["heartbeatOutcomes"];
  private readonly heldSessionLosses: BoundSessionHeartbeatDependencies["heldSessionLosses"];
  private readonly port: BoundSessionHeartbeatPort;

  constructor(deps: BoundSessionHeartbeatDependencies) {
    this.timer = deps.timer;
    this.state = deps.state;
    this.ownedDeviceSessions = deps.ownedDeviceSessions;
    this.ownershipConflictLeashMs = deps.ownershipConflictLeashMs;
    this.heartbeatOutcomes = deps.heartbeatOutcomes;
    this.heldSessionLosses = deps.heldSessionLosses;
    this.port = deps.port;
  }

  /**
   * One heartbeat on the current connection for a session this proxy holds: the one path for the
   * latest binding and for every session held besides it (#11557). A not-found answer is decided
   * where it arrives ({@link noteNotFoundAnswer}) and raised as {@link HeldSessionNotFoundError},
   * which the reconnect machinery neither resets the shared socket for nor retries.
   *
   * The latest binding passes `asked`: the one outcome that is not about the session
   * (`ask-again`) rethrows the daemon's answer, so the heartbeat is asked once more on a fresh
   * connection. That second answer (`asked.notFound`) is the same daemon's, not a re-established
   * one's ({@link latestHeartbeatAsked}). A held session is never asked again: the socket is its
   * siblings' too.
   */
  askSessionHeartbeat(
    sessionUuid: string,
    claimLivenessOwnership: boolean,
    asked?: LatestHeartbeatAsk,
  ): Promise<void> {
    const client = this.port.requireClient();
    return client
      .callDaemonMethod(
        DAEMON_HEARTBEAT_METHOD,
        this.port.boundSessionHeartbeatParams(sessionUuid, claimLivenessOwnership, true),
      )
      .then(
        (ack) => {
          this.port.answersOwnershipReestablishment(client, sessionUuid);
          this.port.noteDaemonIdleEvidence(sessionUuid, ack);
        },
        (error: unknown) => {
          if (!this.port.isDaemonSessionNotFoundError(error)) {
            this.port.answersOwnershipReestablishment(client, sessionUuid);
            throw error;
          }
          const outcome = this.noteNotFoundAnswer(
            sessionUuid,
            client,
            releaseReasonFromError(error),
            daemonInstanceFromError(error),
            { mayAskAgain: asked?.notFound === false },
          );
          if (asked !== undefined) {
            asked.notFound = true;
            asked.handoff = outcome.kind === "ask-again" && outcome.handoff;
          }
          throw outcome.kind === "ask-again"
            ? error
            : new HeldSessionNotFoundError(sessionUuid, outcome);
        },
      );
  }

  async sendBoundSessionHeartbeat(isCurrent: () => boolean = () => true): Promise<void> {
    const sessionUuid = this.state.boundSessionUuid;
    if (!sessionUuid || !this.port.latestBindingClaimable() || this.port.isClosing()) {
      return;
    }
    const asked: LatestHeartbeatAsk = { notFound: false, handoff: false };
    this.state.latestHeartbeatAsked = asked;
    try {
      const claimLivenessOwnership = !this.state.livenessOwnershipClaimSent;
      await runWithoutDaemonLifecycle(() =>
        this.port.withRecoverableReconnect(
          () => this.askSessionHeartbeat(sessionUuid, claimLivenessOwnership, asked),
          sessionUuid,
          undefined,
          // A replacement daemon has not materialized a persisted session until a
          // device operation reaches recovery. Heartbeat misses before that point
          // are not proof that the UUID is terminal; the first tool call remains
          // responsible for either restoring it or applying the existing fence.
          false,
        ),
      );
      this.recordBoundSessionHeartbeatSuccess(sessionUuid, claimLivenessOwnership, isCurrent);
    } catch (error) {
      if (this.absorbOwnershipRefusal(error, sessionUuid, isCurrent)) {
        return;
      }
      if (error instanceof HeldSessionNotFoundError) {
        if (isCurrent()) {
          this.applyNotFoundOutcome(sessionUuid, error.outcome);
        }
        return;
      }
      if (this.port.isDaemonSessionNotFoundError(error) && isCurrent()) {
        // The answer to ask again could not be asked (the proxy is closing): decided as it stands.
        this.applyNotFoundOutcome(
          sessionUuid,
          this.noteNotFoundAnswer(
            sessionUuid,
            null,
            releaseReasonFromError(error),
            daemonInstanceFromError(error),
          ),
        );
        return;
      }
      if (error instanceof DaemonBoundSessionExpiredError) {
        // Terminal fencing already stopped the keeper; this tick has no further work.
        logger.debug(`[DaemonMcpProxy] Bound-session heartbeat stopped: ${error.message}`);
        return;
      }
      throw error;
    } finally {
      this.endLatestHeartbeatAsk(asked);
    }
  }

  /** The latest binding's heartbeat settled; a later one in flight keeps its own record. */
  private endLatestHeartbeatAsk(asked: LatestHeartbeatAsk): void {
    if (this.state.latestHeartbeatAsked === asked) {
      this.state.latestHeartbeatAsked = undefined;
    }
  }

  /**
   * The daemon answered a heartbeat for `sessionUuid` on `client` with not-found: decide what
   * that means ({@link decideNotFoundAnswer}) from the session's own state, and record the window
   * the answer opens. Every heartbeat path decides here, when its answer arrives: the keeper tick
   * for the latest binding and for each held session, the first heartbeat of a connection, a
   * resume claim and liveness recovery (#11411, #11570). The caller acts on the outcome
   * ({@link applyNotFoundOutcome}) unless its heartbeat was given up on meanwhile; the window is
   * recorded either way, so the heartbeat that takes over (liveness recovery) decides inside it.
   *
   * A release reason is the one a missed notification would have carried (#10972) and is
   * classified as that notification is ({@link releaseKeepsBinding}).
   *
   * `establishes`: the answer is the session's first on a connection that was just established
   * while the proxy held it ({@link ownershipReestablishment}), or the caller knows it is (the
   * first heartbeat of a connection). The daemon behind that connection is the one to wait for,
   * and with no reason it is what a restarted daemon answers until it has rehydrated the session
   * (#11529, #11557). Each session has its own first answer and its own window.
   */
  noteNotFoundAnswer(
    sessionUuid: string,
    client: DaemonClientLike | null,
    releaseReason: string | undefined,
    daemonInstance: string | undefined,
    options: { establishes?: boolean; mayAskAgain?: boolean } = {},
  ): NotFoundAnswerOutcome {
    const answeredByOtherDaemon = this.port.noteHeartbeatDaemonInstance(
      sessionUuid,
      daemonInstance,
    );
    const firstOnConnection = this.port.answersOwnershipReestablishment(client, sessionUuid);
    const window = this.state.notFoundWindows.get(sessionUuid);
    const outcome = decideNotFoundAnswer({
      releaseReason,
      answeredByOtherDaemon,
      owned: this.ownedDeviceSessions.has(sessionUuid),
      establishes: firstOnConnection || options.establishes === true,
      windowSince: window?.since,
      handoffs: window?.handoffs ?? NO_HANDOFFS,
      now: this.timer.now(),
      mayAskAgain: options.mayAskAgain === true,
    });
    const released = releaseReason ?? "no reason, from a daemon just connected to";
    if (outcome.kind !== "awaited") {
      return outcome;
    }
    if (outcome.handoff === undefined) {
      logger.debug(`[DaemonMcpProxy] Session ${sessionUuid} is still not recovered (${released})`);
    } else if (this.port.isHeldSession(sessionUuid)) {
      this.state.notFoundWindows.set(sessionUuid, {
        since: outcome.windowSince,
        handoffs: new Set([...(window?.handoffs ?? NO_HANDOFFS), outcome.handoff]),
      });
      logger.info(
        `[DaemonMcpProxy] The daemon no longer knows session ${sessionUuid} (released: ` +
          `${released}); heartbeating it for up to ${RECOVERABLE_NOT_FOUND_HEARTBEAT_WINDOW_MS}ms ` +
          "in case the daemon is still recovering it",
      );
    }
    return outcome;
  }

  /**
   * Act on what a not-found heartbeat answer means for `sessionUuid`, the latest binding or a
   * held session alike. One session's outcome never touches another session.
   *
   * - `awaited`: it keeps being heartbeated, each heartbeat claiming again (#11461): a restarted
   *   daemon publishes a recovered session waiting for its owner, so an owner that went quiet here
   *   lost it to `rehydration-owner-timeout`.
   * - `ended`: the latest binding is fenced under the daemon's reason; a held session is dropped,
   *   and the daemon refuses its calls under that same reason.
   * - `stopped` (and an `ask-again` that could not be asked): no longer heartbeated, never fenced.
   *   The daemon may still hand the session back (#11400): a tool call that reaches it restores it
   *   and re-arms the heartbeat; otherwise that call reports the loss.
   */
  applyNotFoundOutcome(sessionUuid: string, outcome: NotFoundAnswerOutcome): void {
    // A not-found answer is no idle report: the daemon's instant no longer describes the session.
    this.state.daemonIdleReports.delete(sessionUuid);
    const latest = this.state.boundSessionUuid === sessionUuid && !this.state.terminalBoundSession;
    const held = latest ? undefined : this.state.otherHeldSessions.get(sessionUuid);
    if (!latest && !held) {
      return;
    }
    if (outcome.kind === "awaited") {
      if (held) {
        held.claimSent = false;
      } else {
        this.state.livenessOwnershipClaimSent = false;
      }
      this.port.syncHeartbeatKeeper();
      return;
    }
    if (outcome.kind === "ended" && latest) {
      this.port.fenceBoundSessionUuid(sessionUuid, outcome.reason);
      return;
    }
    if (held) {
      logger.warn(
        `[DaemonMcpProxy] Held session ${sessionUuid} is gone, no longer heartbeating it`,
      );
      this.heldSessionLosses.recordNotFoundLoss(sessionUuid, outcome);
      this.port.dropHeldSession(sessionUuid, false, outcome.kind !== "ended");
    } else if (!this.state.notFoundStopped.has(sessionUuid)) {
      logger.info(
        `[DaemonMcpProxy] The daemon no longer knows session ${sessionUuid}; no longer heartbeating it`,
      );
    }
    if (outcome.kind !== "ended") {
      this.state.notFoundStopped.add(sessionUuid);
    }
    this.port.syncHeartbeatKeeper();
  }

  /**
   * Handle the daemon refusing the latest binding's heartbeat on ownership grounds.
   * Returns true when the refusal was absorbed (no fencing, reconnecting or failing
   * the keeper).
   */
  private absorbOwnershipRefusal(
    error: unknown,
    sessionUuid: string,
    isCurrent: () => boolean,
  ): boolean {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      (error.code === DAEMON_LIVENESS_OWNER_SUPERSEDED_CODE ||
        error.code === DAEMON_LIVENESS_OWNER_UNOWNED_CODE)
    ) {
      // #10115: a refusal proves transport reachability, not ownership. Do not
      // fence or re-claim: that would undo a deliberate handoff. Report the loss
      // visibly once; the local acknowledgement only prevents transport recovery.
      if (!this.state.livenessSupersessionLogged) {
        this.state.livenessSupersessionLogged = true;
        logger.warn(
          `[DaemonMcpProxy] Session ${sessionUuid} liveness ownership lost; this proxy no longer protects its deadline. Stop its keeper or explicitly claim with a fresh token.`,
        );
      }
      this.recordBoundSessionHeartbeatSuccess(sessionUuid, false, isCurrent);
      return true;
    }
    if (isLivenessOwnerConflictError(error)) {
      // Another token owns this session with a live lease. Nothing was recorded
      // (no local acknowledgement either), the claim stays unsent so the next
      // tick retries it, and the keeper is not failed by the refusal.
      this.heartbeatOutcomes.noteLivenessOwnerConflict(sessionUuid);
      this.leashLatestBindingConflict(sessionUuid, isCurrent, reportedOwnerHold(error));
      return true;
    }
    return false;
  }

  /**
   * Give the latest binding the same leash held sessions have (#10664): an owner that keeps
   * renewing past the handoff allowance means this proxy cannot own the session, so it stops
   * claiming and fences the binding instead of inheriting another proxy's session. An owner that
   * stopped is waited out for the hold the daemon reports, however long its lease (#10701).
   */
  private leashLatestBindingConflict(
    sessionUuid: string,
    isCurrent: () => boolean,
    hold: ReportedOwnerHold | undefined,
  ): void {
    if (
      !isCurrent() ||
      this.state.boundSessionUuid !== sessionUuid ||
      this.state.terminalBoundSession
    ) {
      return;
    }
    if (this.state.initialSessionAwaitingFirstCall) {
      // A handoff proxy claimed its initial session at startup while the previous owner still
      // heartbeats it. Keep the binding claimable and keep retrying: the claim lands once the old
      // owner's lease lapses, and the leash starts only when a tool call needs the session.
      this.state.latestBindingConflict = undefined;
      return;
    }
    const { leash, exhausted } = advanceOwnerConflictLeash(
      this.state.latestBindingConflict?.sessionUuid === sessionUuid
        ? this.state.latestBindingConflict
        : undefined,
      this.timer.now(),
      hold,
      this.ownershipConflictLeashMs,
    );
    this.state.latestBindingConflict = { sessionUuid, ...leash };
    if (!exhausted) {
      return;
    }
    logger.warn(
      `[DaemonMcpProxy] Session ${sessionUuid} is owned by another live liveness owner; no longer claiming it`,
    );
    this.port.fenceBoundSessionUuid(sessionUuid, "liveness-owner-conflict");
  }

  recordBoundSessionHeartbeatSuccess(
    sessionUuid: string,
    claimLivenessOwnership: boolean,
    isCurrent: () => boolean,
  ): void {
    if (this.state.boundSessionUuid !== sessionUuid || this.state.terminalBoundSession) {
      return;
    }
    if (!isCurrent()) {
      this.heartbeatOutcomes.noteLateHeartbeatAck(sessionUuid);
      return;
    }
    if (claimLivenessOwnership) {
      this.state.livenessOwnershipClaimSent = true;
    }
    this.state.livenessConflictLogged.delete(sessionUuid);
    this.state.latestBindingConflict = undefined;
    this.state.notFoundWindows.delete(sessionUuid);
    // Only a forwarded call refreshes the replay lease (`boundSessionUuidAt`); an ack proves the
    // daemon still holds the session, not that the agent is using it (#10656).
    this.state.livenessAcks.set(sessionUuid, this.timer.now());
  }
}

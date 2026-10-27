import { type SessionBrokerResult } from "../../devices/sessionBrokerResult";
import type { SessionConfig } from "../../devices/sessionConfig";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { type DaemonClientLike } from "../client";
import {
  CLI_SESSION_LIVENESS_POLICY,
  DAEMON_HEARTBEAT_METHOD,
  DAEMON_TOKEN_OWNED_SESSIONS_METHOD,
  HEARTBEAT_SESSION_LIVENESS_POLICY,
  getCliSessionIdleTimeoutMs,
} from "../wire/constants";
import { BoundSessionHeartbeat } from "../proxy/BoundSessionHeartbeat";
import { HeldSessionHeartbeatOutcomes } from "../proxy/HeldSessionHeartbeatOutcomes";
import { HeldSessionNotFoundError } from "../proxy/HeldSessionNotFoundError";
import { stableLivenessOwnerToken } from "../proxy/heartbeatCadence";
import { DAEMON_STALLED_CODE } from "../proxyLivenessRecovery";
import { daemonInstanceFromError, releaseReasonFromError } from "../types";
import {
  CLI_SESSION_FINALIZATION_TIMEOUT_MS,
  TokenOwnedSession,
  parseTokenOwnedSessions,
} from "./ProxyContracts";
import type { ProxyRuntime } from "./ProxyRuntime";
/** Operations supplied by the proxy's composition root. */
export interface ProxySessionOwnershipPort {
  ensureConnected(): Promise<void>;
  rememberSessionDevice(sessionUuid: string, deviceId: unknown): void;
  noteDaemonIdleEvidence(sessionUuid: string, ack: unknown): void;
}

type Runtime = Pick<
  ProxyRuntime,
  | "boundHeartbeat"
  | "boundSessionUuid"
  | "boundSessionUuidAt"
  | "brokerSessions"
  | "claimableSessions"
  | "cliSessionLivenessDeclared"
  | "client"
  | "closing"
  | "config"
  | "connected"
  | "daemonIdleReports"
  | "errorClassifier"
  | "heartbeatIntervalMs"
  | "heartbeatKeeperStarted"
  | "heartbeatOutcomes"
  | "initialSessionAwaitingFirstCall"
  | "initialSessionBindingConfigured"
  | "latestBindingConflict"
  | "latestBindingKeeper"
  | "latestHeartbeatAsked"
  | "livenessAcks"
  | "livenessConflictLogged"
  | "livenessOwnerToken"
  | "livenessOwnershipClaimSent"
  | "notFoundStopped"
  | "notFoundWindows"
  | "otherHeldSessions"
  | "ownedDeviceSessions"
  | "ownershipReestablishment"
  | "pendingHeldSessionPlatformLosses"
  | "plainRestartSessionLosses"
  | "proxyHeartbeatKeeper"
  | "recoveryNotFoundOutcomes"
  | "sessionDaemonInstances"
  | "sessionDeviceIds"
  | "sessionPlatforms"
  | "stallHandovers"
  | "terminalBoundSession"
  | "timer"
  | "transportLive"
>;

/** SessionOwnership operations on a single proxy runtime. */
export class ProxySessionOwnership {
  constructor(
    private readonly runtime: Runtime,
    private readonly port: ProxySessionOwnershipPort,
  ) {}

  /** Bind a client-declared startup session that this proxy claims and heartbeats from now on. */
  bindStartupSession(sessionUuid: string): void {
    this.runtime.boundSessionUuid = sessionUuid;
    this.runtime.boundSessionUuidAt = this.runtime.timer.now();
    this.runtime.initialSessionBindingConfigured = true;
    this.runtime.initialSessionAwaitingFirstCall = true;
    this.runtime.ownedDeviceSessions.add(sessionUuid);
    this.runtime.claimableSessions.add(sessionUuid);
  }

  /** Bind a ready receipt to the keeper; see {@link BrokerSessions.hold}. */
  async holdBrokerSession(requestId: string, sessionUuid: string): Promise<void> {
    return this.runtime.brokerSessions.hold(requestId, sessionUuid);
  }

  /**
   * Prepare one durable broker request before serving MCP. See {@link BrokerSessions.acquire}.
   */
  async acquireBrokerSession(config: SessionConfig): Promise<SessionBrokerResult> {
    return this.runtime.brokerSessions.acquire(config);
  }

  getSessionBrokerResult(): SessionBrokerResult | undefined {
    return this.runtime.brokerSessions.result;
  }

  /** The terminally released binding, excluding a resumable daemon stall, for reporting surfaces (#11712). */
  getTerminalSessionRelease(): { sessionUuid: string; reason: string } | undefined {
    const terminal = this.runtime.terminalBoundSession;
    return terminal && terminal.reason !== DAEMON_STALLED_CODE
      ? { sessionUuid: terminal.sessionUuid, reason: terminal.reason }
      : undefined;
  }

  /**
   * Adopt the `--initial-session-uuid` session at proxy startup instead of on the first tool call.
   * Connection establishment sends the claiming heartbeat and starts the keeper, so a handoff
   * proxy that has only initialized already owns the session and keeps it alive if the previous
   * owner stops first. A no-op without an initial session binding.
   */
  async claimInitialSession(): Promise<void> {
    const sessionUuid = this.runtime.boundSessionUuid;
    const claimsInitialSession =
      this.runtime.initialSessionBindingConfigured && sessionUuid !== undefined;
    // A stable owner token also connects at startup: connecting resumes every session the token
    // owned before a restart, inside the daemon's owner-disconnect grace (#10990).
    if (
      (!claimsInitialSession && !stableLivenessOwnerToken(this.runtime.config)) ||
      this.runtime.closing
    ) {
      return;
    }
    try {
      await this.port.ensureConnected();
    } catch (error) {
      // Best-effort: the first tool call retries the connection and its claim.
      logger.warn(
        claimsInitialSession
          ? `[DaemonMcpProxy] Startup claim of initial session ${sessionUuid} failed: ${errorMessage(error)}`
          : `[DaemonMcpProxy] Startup resume of this owner token's sessions failed: ${errorMessage(error)}`,
        error,
      );
    }
  }

  /**
   * Deliver the first ownership heartbeat as part of connection establishment for
   * a bound session (issue #5637), then start the recurring keeper.
   *
   * A newly connected client whose session was allocated shortly before startup
   * must reach the daemon with its first heartbeat before the pre-first-heartbeat
   * fast-reclaim (issue #2443) can release it. Awaiting the send here makes the
   * guarantee contractual: once ensureConnected() resolves for a bound session,
   * the daemon has recorded ownership — instead of racing a fire-and-forget
   * dispatch against the reclaim sweep.
   *
   * Only the FIRST establishment sends here: once the keeper is running it owns
   * every subsequent tick, so a later reconnect (which may itself be driven by a
   * keeper tick) defers to the keeper's own coalesced heartbeat rather than
   * emitting a duplicate.
   */
  async establishBoundSessionHeartbeat(established?: DaemonClientLike): Promise<void> {
    if (
      established !== undefined &&
      this.runtime.client === established &&
      this.runtime.heartbeatKeeperStarted
    ) {
      // With or without a latest binding: the sessions held besides it are re-established on
      // this connection by the keeper's next tick too (#11557).
      this.noteOwnershipReestablishment(established);
    }
    if (
      !(
        this.runtime.boundSessionUuid &&
        !this.runtime.terminalBoundSession &&
        this.runtime.transportLive &&
        !this.runtime.closing
      )
    ) {
      this.runtime.latestBindingKeeper.syncHeartbeatKeeper();
      return;
    }
    if (this.runtime.heartbeatKeeperStarted) {
      // Reconnect/rebind: fall back to the keeper's own coalescing run(). If this
      // reconnect is itself driven by a keeper tick, run() shares that in-flight
      // tick instead of emitting a duplicate; otherwise it sends a fresh heartbeat
      // on the new transport, exactly as before this change.
      //
      // Ownership was already recorded by the first establishment, so — unlike the
      // first-heartbeat path (issue #5643) — there is nothing to hold concurrent
      // callers behind. Mark the transport connected BEFORE dispatching the keeper
      // heartbeat: startBoundSessionHeartbeat void-dispatches run(), which re-enters
      // ensureConnected() and must short-circuit on the fast path so the heartbeat
      // lands on the fresh transport before the retried operation (#2737/#4610
      // ordering). doConnect defers this flip only on the first establishment.
      this.runtime.connected = true;
      this.runtime.latestBindingKeeper.startBoundSessionHeartbeat();
      return;
    }
    if (!this.runtime.latestBindingKeeper.latestBindingHeartbeatable()) {
      // Only named in a tool call's args: never claimed or heartbeated (#10664). Or the daemon
      // answered not-found for it: a tool call restores it, not another heartbeat (#10702).
      this.runtime.latestBindingKeeper.syncHeartbeatKeeper();
      return;
    }
    await this.sendFirstBoundSessionHeartbeat();
    // Re-validate after the awaited round-trip: a session-released notification or close()
    // landing mid-send may have fenced this binding. The keeper then runs only for the sessions
    // still held besides it (#11411), never as a no-op interval for a fenced binding. Otherwise it
    // owns every subsequent tick, its reconnect, and terminal fencing. No immediate run(): the
    // direct send above already delivered the first heartbeat, and a second would duplicate it.
    this.runtime.latestBindingKeeper.syncHeartbeatKeeper();
  }

  /**
   * Resume every live session this proxy's stable owner token owns (#10990). A proxy restarted
   * with the same `--liveness-owner-token` asks the daemon which sessions the token owns, holds
   * each one it does not already track, and re-claims them on this connection before the
   * owner-disconnect grace releases them; the keeper heartbeats them from then on. Only the
   * owning token learns its sessions, so another token's sessions stay isolated (#10664).
   * Runs on every connection: after a transport reconnect it finds nothing new.
   */
  async resumeTokenOwnedSessions(client: DaemonClientLike): Promise<void> {
    if (
      !stableLivenessOwnerToken(this.runtime.config) ||
      this.runtime.closing ||
      this.runtime.client !== client
    ) {
      return;
    }
    let owned: TokenOwnedSession[];
    try {
      owned = parseTokenOwnedSessions(
        await client.callDaemonMethod(DAEMON_TOKEN_OWNED_SESSIONS_METHOD, {
          livenessOwnerToken: this.runtime.livenessOwnerToken,
        }),
      );
    } catch (error) {
      // Best-effort: an older daemon does not know the method. Sessions named in tool calls still
      // route, and the connection must not fail over a resume it cannot perform.
      logger.warn(
        `[DaemonMcpProxy] Could not list the sessions this owner token holds: ${errorMessage(error)}`,
        error,
      );
      return;
    }
    const resumed = owned.filter((session) => this.holdTokenOwnedSession(session));
    if (resumed.length === 0) {
      return;
    }
    logger.info(
      `[DaemonMcpProxy] Resuming ${resumed.length} session(s) this owner token holds: ${resumed
        .map((session) => session.sessionId)
        .join(", ")}`,
    );
    await Promise.all(resumed.map((session) => this.sendResumeClaim(client, session.sessionId)));
    this.runtime.latestBindingKeeper.syncHeartbeatKeeper();
  }

  /**
   * Hold a token-owned session this proxy does not track yet; false when there is nothing to do.
   * A session with a pending stall handover is not this resume's to adopt (#11018): only the stall
   * probe, pinned to the daemon process that stalled, or a tool call naming the session resumes
   * it. Otherwise a reconnect to a restarted daemon would re-claim and heartbeat it behind the
   * harness before the probe learns the daemon changed.
   */
  holdTokenOwnedSession(session: TokenOwnedSession): boolean {
    const { sessionId } = session;
    if (sessionId === this.runtime.boundSessionUuid) {
      // The startup-bound session (--initial-session-uuid) is bound without a device, and calls
      // naming it carry none: the daemon's answer is the only place the proxy learns it, and
      // loss reports need it (#11028).
      this.port.rememberSessionDevice(sessionId, session.deviceId);
      if (session.platform !== undefined) {
        this.runtime.sessionPlatforms.set(sessionId, session.platform);
      }
      return false;
    }
    if (
      sessionId === this.runtime.terminalBoundSession?.sessionUuid ||
      this.runtime.otherHeldSessions.has(sessionId) ||
      this.runtime.stallHandovers.has(sessionId)
    ) {
      return false;
    }
    this.runtime.claimableSessions.add(sessionId);
    this.runtime.pendingHeldSessionPlatformLosses.delete(sessionId);
    this.runtime.plainRestartSessionLosses.delete(sessionId);
    this.runtime.ownedDeviceSessions.add(sessionId);
    this.port.rememberSessionDevice(sessionId, session.deviceId);
    if (session.platform !== undefined) {
      this.runtime.sessionPlatforms.set(sessionId, session.platform);
    }
    // Resuming is not use: the held session's idle clock is the daemon's last tool use (#10656).
    this.runtime.otherHeldSessions.set(sessionId, {
      claimSent: false,
      lastUsedAt: session.lastUsedAt,
    });
    return true;
  }

  /**
   * Re-claim one resumed session directly on the connection being established, like the
   * establishment heartbeat: routing it through the reconnect machinery would re-enter the
   * connection attempt still in flight. A failure leaves the claim unsent for the keeper to retry.
   */
  async sendResumeClaim(client: DaemonClientLike, sessionUuid: string): Promise<void> {
    const stopRenewing = this.renewLeaseWhileClaimReplyOutstanding(client, sessionUuid);
    try {
      try {
        this.port.noteDaemonIdleEvidence(
          sessionUuid,
          await client
            .callDaemonMethod(
              DAEMON_HEARTBEAT_METHOD,
              this.boundSessionHeartbeatParams(sessionUuid, true, true),
            )
            .finally(stopRenewing),
        );
      } catch (error) {
        // The daemon listed this session as the token's a moment ago: the answer is about the
        // session, not about a daemon that has yet to rehydrate it.
        throw this.runtime.errorClassifier.isDaemonSessionNotFoundError(error)
          ? new HeldSessionNotFoundError(
              sessionUuid,
              this.runtime.boundHeartbeat.noteNotFoundAnswer(
                sessionUuid,
                null,
                releaseReasonFromError(error),
                daemonInstanceFromError(error),
              ),
            )
          : error;
      }
      this.recordHeldSessionHeartbeatSuccess(sessionUuid, true);
    } catch (error) {
      this.handleHeldSessionHeartbeatError(sessionUuid, true, error);
    }
  }

  /**
   * Heartbeat `sessionUuid` on the keeper's cadence while a claim sent outside the keeper waits
   * for its reply (#11646). The daemon accepts a claim on arrival and answers once the ownership
   * row is written; the accepted claim is the owner's heartbeat, so the lease runs from its
   * arrival. The establishment and resume claims are awaited before the keeper starts, so without
   * this a write slower than lease plus grace releases a session whose owner is live. Each renewal
   * is a plain keeper tick: the daemon stamps the lease when it arrives and answers at once, with
   * no claim and no policy change. Does nothing while the keeper is running, which then ticks for
   * the session itself.
   *
   * Returns what to call when the reply lands. A claim answered before the first renewal leaves
   * nothing behind. One that needed renewals gets a last one on the same cadence, so the lease is
   * renewed between the reply and the keeper's first tick a full interval after it.
   */
  renewLeaseWhileClaimReplyOutstanding(client: DaemonClientLike, sessionUuid: string): () => void {
    let renewed = false;
    let replied = false;
    const stop = () => this.runtime.timer.clearInterval(renewals);
    const renewals = this.runtime.timer.setInterval(() => {
      if (
        this.runtime.closing ||
        this.runtime.client !== client ||
        !this.runtime.latestBindingKeeper.isHeldSession(sessionUuid)
      ) {
        stop();
        return;
      }
      if (replied) {
        stop();
      } else if (this.runtime.heartbeatKeeperStarted) {
        return;
      }
      renewed = true;
      void client
        .callDaemonMethod(DAEMON_HEARTBEAT_METHOD, this.boundSessionHeartbeatParams(sessionUuid))
        .catch((error: unknown) => {
          // Expected while the claim is undecided (refused, or the session is gone): the claim's
          // own reply reports that, and this tick only renews a lease the daemon already granted.
          logger.debug(
            `[DaemonMcpProxy] Heartbeat for session ${sessionUuid} behind its pending claim failed: ${errorMessage(error)}`,
          );
        });
    }, this.runtime.heartbeatIntervalMs);
    // Never the reason a closing proxy's process stays up.
    renewals.unref?.();
    return () => {
      replied = true;
      if (!renewed) {
        stop();
      }
    };
  }

  /**
   * `client` was just connected with the keeper already running, so the keeper's next heartbeat
   * for each session it heartbeats re-establishes ownership on it: the latest binding (#11529)
   * and every session held besides it (#11557).
   */
  noteOwnershipReestablishment(client: DaemonClientLike): void {
    if (
      this.runtime.latestHeartbeatAsked?.notFound === true &&
      !this.runtime.latestHeartbeatAsked.handoff
    ) {
      this.runtime.ownershipReestablishment = undefined;
      return;
    }
    const latest = this.runtime.latestBindingKeeper.latestBindingHeartbeatable()
      ? [this.runtime.boundSessionUuid!]
      : [];
    const sessionUuids = new Set([...latest, ...this.runtime.otherHeldSessions.keys()]);
    this.runtime.ownershipReestablishment =
      sessionUuids.size > 0 ? { client, sessionUuids } : undefined;
  }

  /**
   * The daemon answered a heartbeat for `sessionUuid` on `client`. True for the first answer on a
   * connection that was established to re-assert ownership of that session
   * ({@link ownershipReestablishment}), and only for that one. Each session has its own first
   * answer: one session's says nothing about its siblings'.
   */
  answersOwnershipReestablishment(client: DaemonClientLike | null, sessionUuid: string): boolean {
    const pending = this.runtime.ownershipReestablishment;
    return pending?.client === client && pending.sessionUuids.delete(sessionUuid);
  }

  /**
   * Send the establishment heartbeat directly against the freshly connected
   * client. Deliberately NOT routed through withRecoverableReconnect(): that path
   * re-enters ensureConnected(), which is still in flight during establishment and
   * would deadlock on a reconnect. A transient failure is best-effort — the keeper
   * started next retries within the daemon's pre-first-heartbeat grace, and a
   * genuinely released session is fenced by the keeper's reconnect path or a
   * session-released notification.
   */
  async sendFirstBoundSessionHeartbeat(): Promise<void> {
    const sessionUuid = this.runtime.boundSessionUuid;
    if (
      !sessionUuid ||
      !this.runtime.latestBindingKeeper.latestBindingClaimable() ||
      this.runtime.closing ||
      !this.runtime.client
    ) {
      return;
    }
    try {
      const ack = await this.claimFirstBoundSessionHeartbeat(this.runtime.client, sessionUuid);
      if (this.runtime.boundSessionUuid === sessionUuid && !this.runtime.terminalBoundSession) {
        this.port.noteDaemonIdleEvidence(sessionUuid, ack);
        this.runtime.livenessOwnershipClaimSent = true;
        // A heartbeat ack proves liveness, not use: it must not refresh the replay lease (#10656).
        this.runtime.livenessAcks.set(sessionUuid, this.runtime.timer.now());
      }
    } catch (error) {
      if (
        this.runtime.errorClassifier.isDaemonSessionNotFoundError(error) &&
        this.runtime.boundSessionUuid === sessionUuid
      ) {
        // The first heartbeat is the session's first answer on the connection just established:
        // decided like every other not-found answer, so only a release reason that ends the
        // session fences it. With no reason the daemon may not have rehydrated it yet (#11570).
        this.runtime.boundHeartbeat.applyNotFoundOutcome(
          sessionUuid,
          this.runtime.boundHeartbeat.noteNotFoundAnswer(
            sessionUuid,
            null,
            releaseReasonFromError(error),
            daemonInstanceFromError(error),
            {
              establishes: true,
            },
          ),
        );
        return;
      }
      // Safe to swallow the rest: the establishment heartbeat is best-effort. The
      // keeper started immediately after retries within the pre-first-heartbeat
      // grace — so a transient failure here must not fail connection establishment.
      logger.debug(
        `[DaemonMcpProxy] Initial bound-session heartbeat failed: ${errorMessage(error)}`,
      );
    }
  }

  /** Keep managed claims cancellable and remember exactly which connection acknowledged them. */
  async claimFirstBoundSessionHeartbeat(
    client: DaemonClientLike,
    sessionUuid: string,
  ): Promise<unknown> {
    const stopRenewing = this.renewLeaseWhileClaimReplyOutstanding(client, sessionUuid);
    try {
      const claiming = client.callDaemonMethod(
        DAEMON_HEARTBEAT_METHOD,
        this.boundSessionHeartbeatParams(sessionUuid, true, true),
      );
      const ack = await claiming;
      return ack;
    } finally {
      stopRenewing();
    }
  }

  /**
   * Declare this connection's bound device session CLI-owned (issue #6870).
   *
   * A `--cli` invocation is a one-shot process: it connects, runs one tool and
   * exits, so the recurring keeper above dies with it and the daemon reaps the
   * session after the 10 s heartbeat timeout — roughly the time an agent spends
   * reading the previous result. Sending one heartbeat that also carries
   * {@link CLI_SESSION_LIVENESS_POLICY} records ownership AND moves the session
   * onto a wall-clock idle timeout measured in minutes, so the next invocation
   * still finds it. Returns the declared session uuid, or undefined when there
   * was nothing to declare.
   *
   * Long-lived clients (stdio/HTTP MCP) never call this and keep the strict
   * contract: their keeper can hold it.
   */
  async adoptCliSessionLiveness(): Promise<string | undefined> {
    const sessionUuid = this.runtime.boundSessionUuid;
    if (
      !sessionUuid ||
      this.runtime.terminalBoundSession ||
      this.runtime.closing ||
      !this.runtime.client
    ) {
      return undefined;
    }
    try {
      // A one-shot CLI is leaving, so stop future keeper ticks and wait only a
      // short bounded interval for the current strict-policy heartbeat. This
      // both prevents an older heartbeat from restoring strict policy after
      // the declaration and prevents a completed tool result from being hidden
      // behind a stalled ownership RPC.
      const heartbeatSettled = await this.runtime.latestBindingKeeper.stopBoundSessionHeartbeat();
      if (!heartbeatSettled) {
        return undefined;
      }
      if (
        this.runtime.boundSessionUuid !== sessionUuid ||
        this.runtime.terminalBoundSession ||
        this.runtime.closing
      ) {
        return undefined;
      }
      // Declare before the round-trip: a keeper tick that fires while this call
      // is in flight must already carry the CLI marker, or it would land after
      // the declaration and restore the strict contract.
      this.runtime.cliSessionLivenessDeclared = true;
      this.runtime.livenessOwnershipClaimSent = true;
      await this.runtime.client.callDaemonMethod(
        DAEMON_HEARTBEAT_METHOD,
        {
          sessionId: sessionUuid,
          livenessPolicy: CLI_SESSION_LIVENESS_POLICY,
          livenessOwnerToken: this.runtime.livenessOwnerToken,
          claimLivenessOwnership: true,
          // The daemon resolved its own env at startup and this invocation reuses
          // it, so the override only reaches the daemon by travelling with the
          // declaration (issue #6870 review). The daemon re-validates and bounds it.
          idleTimeoutMs: getCliSessionIdleTimeoutMs(),
        },
        { timeoutMs: CLI_SESSION_FINALIZATION_TIMEOUT_MS },
      );
      return sessionUuid;
    } catch (error) {
      // Best-effort: the tool call already succeeded and its result is the
      // caller's answer. A failed declaration only means the next invocation may
      // have to re-acquire, which is the pre-#6870 behaviour — never a reason to
      // fail the invocation that just ran.
      logger.debug(
        `[DaemonMcpProxy] CLI session liveness declaration failed: ${errorMessage(error)}`,
      );
      return undefined;
    }
  }

  /**
   * Parameters for an ordinary (non-declaring) bound-session heartbeat.
   *
   * A long-lived stdio/HTTP proxy declares `heartbeat` so the daemon restores
   * the strict contract on a session a previous `--cli` invocation widened
   * (issue #6870 review). Once THIS proxy has declared the session CLI-owned,
   * its own remaining heartbeats keep the CLI marker instead, so a keeper tick
   * racing process exit cannot undo the declaration.
   */
  boundSessionHeartbeatParams(
    sessionUuid: string,
    claimLivenessOwnership = false,
    reportIdleRelease = false,
  ): {
    sessionId: string;
    livenessPolicy: string;
    idleTimeoutMs?: number;
    livenessOwnerToken: string;
    claimLivenessOwnership?: true;
    reportIdleRelease?: true;
    reportDaemonInstance?: true;
  } {
    const livenessPolicy = this.runtime.cliSessionLivenessDeclared
      ? CLI_SESSION_LIVENESS_POLICY
      : HEARTBEAT_SESSION_LIVENESS_POLICY;
    return {
      sessionId: sessionUuid,
      livenessPolicy,
      ...(livenessPolicy === CLI_SESSION_LIVENESS_POLICY
        ? { idleTimeoutMs: getCliSessionIdleTimeoutMs() }
        : {}),
      livenessOwnerToken: this.runtime.livenessOwnerToken,
      ...(claimLivenessOwnership ? { claimLivenessOwnership: true } : {}),
      // Ask the daemon to say when it would idle-release the session (#10823), and which process
      // it is, so a stall probe can tell a resumed daemon from a restarted one (#10989).
      ...(reportIdleRelease ? { reportIdleRelease: true, reportDaemonInstance: true } : {}),
    };
  }

  heartbeatHeldSession(sessionUuid: string): Promise<void> {
    return this.runtime.proxyHeartbeatKeeper.heartbeatHeldSession(sessionUuid);
  }

  heartbeatWithStallDetection(
    sessionUuid: string,
    send: (isCurrent: () => boolean) => Promise<void>,
  ): Promise<void> {
    return this.runtime.proxyHeartbeatKeeper.heartbeatWithStallDetection(sessionUuid, send);
  }

  // Kept as named methods: the liveness-clock guard follows the keeper's port to them.
  recordHeldSessionHeartbeatSuccess(
    ...args: Parameters<HeldSessionHeartbeatOutcomes["recordHeldSessionHeartbeatSuccess"]>
  ): void {
    this.runtime.heartbeatOutcomes.recordHeldSessionHeartbeatSuccess(...args);
  }

  handleHeldSessionHeartbeatError(
    ...args: Parameters<HeldSessionHeartbeatOutcomes["handleHeldSessionHeartbeatError"]>
  ): void {
    this.runtime.heartbeatOutcomes.handleHeldSessionHeartbeatError(...args);
  }

  clearNotFoundHistory(sessionUuid: string): void {
    this.runtime.notFoundWindows.delete(sessionUuid);
    this.runtime.notFoundStopped.delete(sessionUuid);
    this.runtime.sessionDaemonInstances.delete(sessionUuid);
  }

  /**
   * Forget what the proxy tracks per session for liveness once it stops heartbeating it. A
   * session handed over for a stall stays resumable by UUID, so its device and the pending
   * handover are kept for the harness's next call. A not-found stop also keeps its handoff and
   * process evidence with stopped membership until acknowledgement, admitted use or termination.
   */
  forgetSessionLivenessState(
    sessionUuid: string,
    keepHandover = false,
    keepNotFoundHistory = false,
  ): void {
    this.runtime.livenessAcks.delete(sessionUuid);
    this.runtime.daemonIdleReports.delete(sessionUuid);
    this.runtime.livenessConflictLogged.delete(sessionUuid);
    this.runtime.recoveryNotFoundOutcomes.delete(sessionUuid);
    if (!keepNotFoundHistory) {
      this.clearNotFoundHistory(sessionUuid);
    }
    // Held again later on this connection, its next heartbeat is not the connection's first.
    this.runtime.ownershipReestablishment?.sessionUuids.delete(sessionUuid);
    if (!keepHandover) {
      this.runtime.sessionDeviceIds.delete(sessionUuid);
      this.runtime.sessionPlatforms.delete(sessionUuid);
      this.runtime.stallHandovers.delete(sessionUuid);
    }
  }

  /** Stop heartbeating a held session; idle the keeper once nothing remains to heartbeat. */
  dropHeldSession(sessionUuid: string, keepHandover = false, keepNotFoundHistory = false): void {
    if (!this.runtime.otherHeldSessions.delete(sessionUuid)) {
      return;
    }
    this.forgetSessionLivenessState(sessionUuid, keepHandover, keepNotFoundHistory);
    this.runtime.latestBindingKeeper.syncHeartbeatKeeper();
  }

  /** The latest binding moves on: its session stays held and keeps its claim state. */
  holdPreviousBinding(nextSessionUuid: string): void {
    const previous = this.runtime.boundSessionUuid;
    this.runtime.pendingHeldSessionPlatformLosses.delete(nextSessionUuid);
    this.runtime.plainRestartSessionLosses.delete(nextSessionUuid);
    this.runtime.otherHeldSessions.delete(nextSessionUuid);
    this.runtime.latestBindingConflict = undefined;
    // Only a session this proxy claims stays held: an args-named one was never heartbeated (#10664).
    if (previous && previous !== nextSessionUuid && this.runtime.claimableSessions.has(previous)) {
      // Held again, it is asked again: its not-found answer may be out of date by now.
      this.runtime.notFoundStopped.delete(previous);
      this.runtime.otherHeldSessions.set(previous, {
        claimSent: this.runtime.livenessOwnershipClaimSent,
        lastUsedAt: this.runtime.boundSessionUuidAt ?? this.runtime.timer.now(),
      });
    }
  }

  // Kept as a named method: the liveness-clock guard follows the first-heartbeat path to it.
  recordBoundSessionHeartbeatSuccess(
    ...args: Parameters<BoundSessionHeartbeat["recordBoundSessionHeartbeatSuccess"]>
  ): void {
    this.runtime.boundHeartbeat.recordBoundSessionHeartbeatSuccess(...args);
  }

  /**
   * The daemon admitted a call under `sessionUuid` and used it, so it knows the session (again):
   * its window is over, and a session the proxy stopped heartbeating on a not-found answer is
   * heartbeated again (#11570). A held session that was dropped for that answer is held again;
   * the latest binding is re-armed where it is bound. Only this echo restores: a read, a refusal
   * or a sessionless call names no admitted use, and never holds a session.
   */
  noteSessionRestoredByCall(sessionUuid: string): void {
    const stopped = this.runtime.notFoundStopped.has(sessionUuid);
    this.clearNotFoundHistory(sessionUuid);
    if (!stopped || this.runtime.closing) {
      return;
    }
    if (
      sessionUuid !== this.runtime.boundSessionUuid &&
      sessionUuid !== this.runtime.terminalBoundSession?.sessionUuid &&
      this.runtime.claimableSessions.has(sessionUuid) &&
      !this.runtime.otherHeldSessions.has(sessionUuid)
    ) {
      this.runtime.otherHeldSessions.set(sessionUuid, {
        claimSent: false,
        lastUsedAt: this.runtime.timer.now(),
      });
      this.runtime.pendingHeldSessionPlatformLosses.delete(sessionUuid);
      this.runtime.plainRestartSessionLosses.delete(sessionUuid);
    }
    this.runtime.latestBindingKeeper.syncHeartbeatKeeper();
  }
}

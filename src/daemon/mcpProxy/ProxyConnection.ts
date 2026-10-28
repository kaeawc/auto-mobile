import { SESSION_OWNER_EXITED_CODE } from "../../devices/sessionBrokerResult";
import { ActionableError } from "../../models";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { DaemonRequestNotDeliveredError } from "../DaemonRequestNotDeliveredError";
import { type BuildIdentity } from "../wire/buildIdentity";
import { DaemonUnavailableError, type DaemonClientLike } from "../client/client";
import {
  DAEMON_CONNECT_ATTEMPT_TIMEOUT_MS,
  DAEMON_RELEASE_SESSION_METHOD,
  DAEMON_STARTUP_TIMEOUT_MS,
  SOCKET_PATH,
} from "../wire/constants";
import { DeviceControlTransportError } from "../deviceControlTransportFailure";
import { type ListChangedKind } from "../listChangedBroadcast";
import { type DaemonRestartResult } from "../manager";
import { applyConnectionPresentationProfile } from "../proxy/ConnectionPresentationProfile";
import { DaemonConnectAttemptStalledError } from "../proxy/DaemonConnectAttemptStalledError";
import { runPreflightTransport } from "../proxy/DaemonLifecycleReconciler";
import {
  DaemonBuildMismatchError,
  DaemonVersionMismatchError,
  LifecycleConnectionInFlightError,
  type BuildMismatchReason,
  type VersionMismatchReason,
} from "../proxy/daemonErrors";
import { stableLivenessOwnerToken } from "../proxy/heartbeatCadence";
import { daemonLifecycleAllowed } from "../proxyLivenessRecovery";
import { BROKER_EXECUTION_RELEASE_TIMEOUT_MS } from "../sessionBroker/provisioning/executionLiveness";
import {
  DAEMON_LIVENESS_OWNER_NOT_OWNER_CODE,
  type DaemonNotification,
  type DaemonStatus,
} from "../types";
import { DaemonMcpProxyCloseOptions, DaemonMcpProxyConfig } from "./ProxyContracts";
import type { ProxyRuntime } from "./ProxyRuntime";
/** Operations supplied by the proxy's composition root. */
export interface ProxyConnectionPort {
  throwIfLivenessHandedOver(): void;
  hasLivenessLifecycleFence(): boolean;
  waitForLivenessRecovery(signal?: AbortSignal): Promise<void>;
  handleDaemonNotification(notification: DaemonNotification, sourceClient: DaemonClientLike): void;
  assertConnectedClient(client: DaemonClientLike): void;
  cancelBackgroundConnectRetry(): void;
  replayResourceSubscriptions(client: DaemonClientLike): Promise<void>;
  applyListChangedSubscription(subscribed: boolean | undefined): void;
  notifyListChanged(kind: ListChangedKind): void;
  establishBoundSessionHeartbeat(established?: DaemonClientLike): Promise<void>;
  resumeTokenOwnedSessions(client: DaemonClientLike): Promise<void>;
  withToolSelectionProfile(args: Record<string, unknown>): Record<string, unknown>;
  rememberToolSelectionProfile(
    name: string,
    requestedArgs: Record<string, unknown>,
    result: unknown,
  ): void;
  invalidateCache(): void;
  connectResourceSubscriptionsInBackground(): void;
  cancelConnectedFallbackReconcile(): void;
  clearBoundSessionUuid(): void;
}

type Runtime = Pick<
  ProxyRuntime,
  | "brokerSessions"
  | "cliSessionLivenessDeclared"
  | "client"
  | "clientFactory"
  | "closeAbort"
  | "closePromise"
  | "closing"
  | "config"
  | "connected"
  | "connecting"
  | "connectingAllowsLifecycle"
  | "connectionAttemptWork"
  | "connectionCloseReject"
  | "connectionClosedUnsubscribe"
  | "daemonAvailabilityProbe"
  | "daemonIdleReports"
  | "daemonShutdownBarrier"
  | "daemonStatusProbe"
  | "executionOwnerLossProbe"
  | "forwardedResultApplier"
  | "latestBindingKeeper"
  | "latestHeartbeatAsked"
  | "lifecycleReconciler"
  | "listPoller"
  | "livenessAcks"
  | "livenessHandoverListeners"
  | "livenessOwnerToken"
  | "livenessRecovery"
  | "notFoundStopped"
  | "notFoundWindows"
  | "notificationUnsubscribe"
  | "otherHeldSessions"
  | "ownedDeviceSessions"
  | "ownershipReestablishment"
  | "pendingHeldSessionPlatformLosses"
  | "pendingSessionLosses"
  | "plainRestartSessionLosses"
  | "reconciliationSnapshot"
  | "recoveryNotFoundOutcomes"
  | "releaseLedger"
  | "resourceSubscriptionSync"
  | "resourceSubscriptions"
  | "resourceUpdatedListeners"
  | "resumedStallNotices"
  | "servedStaticResourceList"
  | "servedStaticToolList"
  | "sessionDaemonInstances"
  | "sessionDeviceIds"
  | "sessionPlatforms"
  | "stallHandovers"
  | "stallResumeProbe"
  | "structuredSessionNotFound"
  | "structuredToolErrorCodes"
  | "terminalBoundSession"
  | "timer"
  | "toolSelectionProfileUuid"
>;

/** Connection operations on a single proxy runtime. */
export class ProxyConnection {
  /** Identifies the live connection attempt; bumping it supersedes a stalled one (#15019). */
  private connectionGeneration = 0;

  constructor(
    private readonly runtime: Runtime,
    private readonly port: ProxyConnectionPort,
  ) {}

  /**
   * Ensure we have a connection to the daemon
   * Will auto-start daemon if configured and daemon is not running
   */
  async ensureConnected(): Promise<void> {
    if (this.runtime.closing) {
      throw new DaemonUnavailableError("MCP proxy is closing");
    }
    const daemonShutdownDisconnect = this.runtime.daemonShutdownBarrier.pending;
    if (daemonShutdownDisconnect) {
      await this.awaitShutdownBarrier(daemonShutdownDisconnect);
      if (this.runtime.closing) {
        throw new DaemonUnavailableError("MCP proxy is closing");
      }
    }
    if (this.runtime.connected && this.runtime.client) {
      return;
    }

    try {
      const connecting = this.connectSingleFlight(this.connectionAllowsLifecycle());
      try {
        await connecting;
      } finally {
        this.clearConnectionAttempt(connecting);
      }
    } catch (error) {
      await this.handleConnectionFailure(error);
    }
  }

  /**
   * #15019: the barrier bounds its own EOF wait and restart window, but a probe inside it that
   * never settles would hold every caller. It only keeps the draining incarnation from being
   * reused, and doConnect re-checks daemon readiness, so give up waiting once the connection
   * attempt bound has passed and connect.
   */
  private async awaitShutdownBarrier(barrier: Promise<void>): Promise<void> {
    const stalled = new DaemonConnectAttemptStalledError(DAEMON_CONNECT_ATTEMPT_TIMEOUT_MS);
    try {
      await raceWithDeadline(barrier, {
        timer: this.runtime.timer,
        timeoutMs: DAEMON_CONNECT_ATTEMPT_TIMEOUT_MS,
        label: "daemon shutdown barrier",
        timeoutError: () => stalled,
      });
    } catch (error) {
      if (error !== stalled) {
        throw error;
      }
      logger.warn(
        `[DaemonMcpProxy] Daemon shutdown barrier did not settle within ${DAEMON_CONNECT_ATTEMPT_TIMEOUT_MS}ms; connecting anyway`,
      );
    }
  }

  /** Release only this process's ordinary heartbeat holds; harness and CLI holds survive exit. */
  async releaseOwnedSessions(client: DaemonClientLike | null): Promise<void> {
    if (
      !client ||
      stableLivenessOwnerToken(this.runtime.config) ||
      this.runtime.config.oneShotCli ||
      this.runtime.cliSessionLivenessDeclared
    ) {
      return;
    }
    const sessions = this.runtime.latestBindingKeeper
      .heldSessionUuids()
      .filter(
        (sessionId) =>
          sessionId !== this.runtime.config.initialSessionUuid?.trim() &&
          !this.runtime.brokerSessions.sessions.has(sessionId) &&
          !this.runtime.releaseLedger.releasedSessionReasons.has(sessionId),
      );
    await Promise.all(
      sessions.map(async (sessionId) => {
        try {
          const result: unknown = await raceWithDeadline(
            () =>
              client.callDaemonMethod(
                DAEMON_RELEASE_SESSION_METHOD,
                { sessionId, livenessOwnerToken: this.runtime.livenessOwnerToken },
                { timeoutMs: BROKER_EXECUTION_RELEASE_TIMEOUT_MS },
              ),
            {
              timer: this.runtime.timer,
              timeoutMs: BROKER_EXECUTION_RELEASE_TIMEOUT_MS,
              label: `Release owned session ${sessionId}`,
            },
          );
          // DaemonClientLike permits arbitrary results; injected clients can resolve refusal envelopes.
          if (result && typeof result === "object" && Reflect.get(result, "success") === false) {
            throw Object.assign(new ActionableError(String(Reflect.get(result, "error"))), {
              code: Reflect.get(result, "code"),
            });
          }
        } catch (error) {
          if (
            error &&
            typeof error === "object" &&
            Reflect.get(error, "code") === DAEMON_LIVENESS_OWNER_NOT_OWNER_CODE
          ) {
            // A successor or explicit handoff owns this session now; its lifecycle must continue.
            logger.debug(
              `[DaemonMcpProxy] Session ${sessionId} no longer belongs to this proxy; keeping it`,
              error,
            );
            return;
          }
          logger.warn(
            `[DaemonMcpProxy] Releasing owned session ${sessionId} failed; falling back to owner-disconnect release: ${errorMessage(error)}`,
            error,
          );
        }
      }),
    );
  }

  connectSingleFlight(allowsLifecycle: boolean): Promise<void> {
    this.assertConnectionPlanCompatible(allowsLifecycle);
    // Serialize socket publication, but never let observation-only work ride a lifecycle attempt.
    if (this.runtime.connecting) {
      return this.runtime.connecting;
    }
    const generation = ++this.connectionGeneration;
    const attempt = this.doConnect(allowsLifecycle, generation);
    this.runtime.connectionAttemptWork = attempt;
    void attempt.then(
      () => this.clearConnectionAttemptWork(attempt),
      () => this.clearConnectionAttemptWork(attempt),
    );
    const connecting = new Promise<void>((resolve, reject) => {
      this.runtime.connectionCloseReject = reject;
      const watchdog = this.runtime.timer.setTimeout(
        () => this.abandonStalledAttempt(generation, reject),
        DAEMON_CONNECT_ATTEMPT_TIMEOUT_MS,
      );
      void attempt.then(
        (value) => {
          this.runtime.timer.clearTimeout(watchdog);
          resolve(value);
        },
        (error: unknown) => {
          this.runtime.timer.clearTimeout(watchdog);
          reject(error);
        },
      );
    });
    this.runtime.connecting = connecting;
    this.runtime.connectingAllowsLifecycle = allowsLifecycle;
    return connecting;
  }

  /**
   * #15019: a connection attempt that never settles would hold the single-flight slot, so every
   * later caller joined it and waited on an unrelated outer deadline. Supersede it: its waiters get
   * a typed unavailable error (callers reconnect from it), its half-built client is closed, and the
   * next call starts a fresh attempt. The stale attempt fences itself on its generation.
   */
  private abandonStalledAttempt(generation: number, reject: (error: unknown) => void): void {
    if (this.connectionGeneration !== generation) {
      return;
    }
    this.connectionGeneration++;
    logger.warn(
      `[DaemonMcpProxy] Daemon connection attempt stalled for ${DAEMON_CONNECT_ATTEMPT_TIMEOUT_MS}ms; abandoning it`,
    );
    reject(new DaemonConnectAttemptStalledError(DAEMON_CONNECT_ATTEMPT_TIMEOUT_MS));
    void this.resetConnection();
  }

  private assertAttemptCurrent(generation: number): void {
    if (this.connectionGeneration !== generation) {
      throw new DaemonConnectAttemptStalledError(DAEMON_CONNECT_ATTEMPT_TIMEOUT_MS);
    }
  }

  clearConnectionAttemptWork(attempt: Promise<void>): void {
    if (this.runtime.connectionAttemptWork === attempt) {
      this.runtime.connectionAttemptWork = null;
    }
  }

  async joinConnectionAttempt(): Promise<void> {
    await this.runtime.connectionAttemptWork?.catch(() => undefined);
  }

  clearConnectionAttempt(connecting: Promise<void>): void {
    // Unpublish the settled attempt before originators or joiners await shared recovery.
    if (this.runtime.connecting === connecting) {
      this.runtime.connecting = null;
      this.runtime.connectionCloseReject = null;
      this.runtime.connectingAllowsLifecycle = false;
    }
  }

  connectionAllowsLifecycle(): boolean {
    const allowed = daemonLifecycleAllowed();
    if (allowed) {
      this.port.throwIfLivenessHandedOver();
    }
    return allowed && !this.port.hasLivenessLifecycleFence();
  }

  assertConnectionPlanCompatible(allowsLifecycle: boolean): void {
    if (this.runtime.connecting && !allowsLifecycle && this.runtime.connectingAllowsLifecycle) {
      throw new LifecycleConnectionInFlightError();
    }
  }

  async handleConnectionFailure(error: unknown): Promise<void> {
    if (!daemonLifecycleAllowed() || !this.port.hasLivenessLifecycleFence()) {
      throw error;
    }
    await this.port.waitForLivenessRecovery();
    this.port.throwIfLivenessHandedOver();
    if (!this.runtime.connected || !this.runtime.client) {
      throw error;
    }
  }

  throwIfClosing(): void {
    if (this.runtime.closing) {
      throw new DaemonUnavailableError("MCP proxy is closing");
    }
  }

  assertDaemonLifecycleUnfenced(): void {
    if (this.port.hasLivenessLifecycleFence()) {
      throw new DaemonUnavailableError(
        "Liveness recovery or handover forbids daemon lifecycle changes",
      );
    }
  }

  /**
   * What connecting must do about the daemon's lifecycle: `start` it (not running, auto-start on),
   * `reconcile` a running one with this client, or only `observe`. Liveness recovery shares the
   * daemon with other harnesses, so a connection it establishes only observes: it fails when the
   * daemon is not reachable and never starts it or reconciles it by restarting it.
   */
  daemonLifecyclePlan(
    isAvailable: boolean,
    allowsLifecycle: boolean,
  ): "start" | "reconcile" | "observe" {
    if (!allowsLifecycle || this.port.hasLivenessLifecycleFence()) {
      if (!isAvailable) {
        throw new DaemonUnavailableError(
          "Daemon is not reachable; liveness recovery never starts or restarts the daemon",
        );
      }
      return "observe";
    }
    if (isAvailable) {
      return "reconcile";
    }
    if (!this.runtime.config.autoStartDaemon) {
      throw new DaemonUnavailableError("Daemon is not running and auto-start is disabled");
    }
    return "start";
  }

  async doConnect(allowsLifecycle: boolean, generation = this.connectionGeneration): Promise<void> {
    this.throwIfClosing();
    this.runtime.reconciliationSnapshot = undefined;
    this.runtime.structuredSessionNotFound = false;
    this.runtime.structuredToolErrorCodes = false;
    // Check if daemon is available
    const socketPath = this.runtime.config.socketPath ?? SOCKET_PATH;
    // This is an observation-only probe (issue #6140: isAvailable never touches
    // the filesystem). A daemon from another checkout may own this namespace's
    // socket without its PID record; cleaning the path before DaemonManager can
    // verify that candidate would sever a live daemon.
    const isAvailable = await this.runtime.daemonAvailabilityProbe(socketPath);

    const lifecycle = this.daemonLifecyclePlan(isAvailable, allowsLifecycle);
    if (lifecycle === "start") {
      logger.info("[DaemonMcpProxy] Daemon not available, starting daemon...");
      await this.startDaemon();
    }
    if (lifecycle !== "observe") {
      await this.ensureVersionMatches();
      await this.ensureAssetVersionPinMatches();
      await this.ensureBuildMatches();
      await this.ensureStartupOptionsMatch();
    }

    // Reuse the socket status already read by reconciliation, after any restart.
    // Custom transports without a socket status probe retain legacy compatibility.
    if (this.runtime.daemonStatusProbe) {
      const status = await this.reconciliationStatus();
      this.runtime.structuredSessionNotFound = status.structuredSessionNotFound === true;
      this.runtime.structuredToolErrorCodes = status.structuredToolErrorCodes === true;
    }

    // Create and connect client
    this.throwIfClosing();
    this.assertAttemptCurrent(generation);
    // A previous attempt may have left a client behind; close it before it is
    // overwritten so the daemon socket is not leaked (#11117).
    const previousClient = this.runtime.client;
    this.runtime.client = this.runtime.clientFactory();
    const client = this.runtime.client;
    this.closePreviousClient(previousClient, client);
    try {
      // Wire daemon-pushed list-changed forwarding (issue #3223) when the client
      // supports it. The handler is registered BEFORE connect so no early frame
      // is dropped; the opt-in subscription request goes out after connect.
      const supportsNotifications = [client.onNotification, client.subscribeToNotifications].every(
        (method) => typeof method === "function",
      );
      if (supportsNotifications) {
        this.runtime.notificationUnsubscribe?.();
        this.runtime.notificationUnsubscribe = client.onNotification!((notification) =>
          this.port.handleDaemonNotification(notification, client),
        );
      }
      this.subscribeToClientConnectionClosed(client);
      await runPreflightTransport(() => client.connect(undefined, this.runtime.closeAbort.signal));
      this.assertAttemptCurrent(generation);
      if (this.runtime.closing) {
        await client.close();
        throw new DaemonUnavailableError("MCP proxy is closing");
      }
      logger.info("[DaemonMcpProxy] Connected to daemon");

      // Start notification opt-in BEFORE awaiting the ownership heartbeat so a
      // shutdown that releases the initial binding during that round trip cannot
      // publish to an unsubscribed socket (#6336). Do not await the subscription
      // yet: it is a best-effort daemon RPC that can stall up to the connection
      // timeout, while the time-critical first heartbeat must still be dispatched
      // immediately to beat the pre-first-heartbeat reclaim grace (#5637).
      const notificationSubscription = supportsNotifications
        ? client.subscribeToNotifications!({ signal: this.runtime.closeAbort.signal }).then(
            () => true,
            (error) => {
              logger.warn(`[DaemonMcpProxy] Failed to subscribe to daemon notifications: ${error}`);
              return false;
            },
          )
        : Promise.resolve(undefined);
      const [firstConnectionStep, secondConnectionStep] =
        this.connectionOwnershipAndPresentationSteps(client);
      await firstConnectionStep();
      this.assertAttemptCurrent(generation);
      await secondConnectionStep();
      this.assertAttemptCurrent(generation);
      // Re-check closing before the deferred flip: the establishment heartbeat awaits a
      // real daemon round-trip, and a close() landing during it already set
      // connected=false and nulled the client. Without this guard doConnect would
      // resume and set connected=true again — leaving a stale connected flag over a
      // closed transport (the old pre-await placement flipped before this await, so
      // close() ran last). Mirrors the closing rechecks above.
      this.throwIfClosing();
      // Fence the flip to the transport this attempt established (#6389): a socket
      // close during the establishment heartbeat already ran resetConnection() and
      // nulled the client, and the best-effort heartbeat swallowed the rejection.
      // Publishing connected=true now would pair the flag with a null client. No
      // request was dispatched on the lost transport, so surface it as a preflight
      // failure that withRecoverableReconnect reconnects from.
      this.port.assertConnectedClient(client);
      this.runtime.connected = true;
      this.port.cancelBackgroundConnectRetry();

      // Connection establishment still waits for the already-running subscription
      // so callers do not race later requests ahead of notification opt-in. Failure
      // was converted to a warning above and preserves the prior best-effort policy.
      const subscribed = await notificationSubscription;
      this.throwIfClosing();
      if (this.runtime.resourceSubscriptions.size > 0) {
        await this.port.replayResourceSubscriptions(client);
      }

      this.notifyStaticListsServedBeforeConnect();
      this.port.applyListChangedSubscription(subscribed);
    } catch (error) {
      // A failed partial connect (e.g. presentation profile rejected) must not
      // leave a live socket or subscriptions behind: the next attempt would
      // overwrite this.client and orphan it (#11117).
      await this.abandonFailedClient(client);
      throw error;
    }
  }

  notifyStaticListsServedBeforeConnect(): void {
    // If a client `tools/list` was served statically before this connection
    // existed (issue #5879), prompt it to re-fetch now that the daemon can
    // return the accurate (session-scoped) list. A no-op in the common case
    // where the static and live lists match; correct when a tool-selection
    // profile filters the live list.
    if (this.runtime.servedStaticToolList) {
      this.runtime.servedStaticToolList = false;
      this.port.notifyListChanged("tools");
    }
    if (this.runtime.servedStaticResourceList) {
      this.runtime.servedStaticResourceList = false;
      this.port.notifyListChanged("resources");
    }
  }

  /**
   * Not awaited: an extra turn in doConnect reorders reconnect timing that quiescence handling
   * (#6336) depends on; a close failure is only logged.
   */
  closePreviousClient(previous: DaemonClientLike | null, current: DaemonClientLike): void {
    if (previous && previous !== current) {
      void previous.close().catch((closeError) => {
        logger.warn(`[DaemonMcpProxy] Failed to close previous daemon client: ${closeError}`);
      });
    }
  }

  async abandonFailedClient(client: DaemonClientLike): Promise<void> {
    if (this.runtime.client === client) {
      await this.resetConnection();
      return;
    }
    await client.close().catch((closeError) => {
      logger.warn(`[DaemonMcpProxy] Failed to close abandoned daemon client: ${closeError}`);
    });
  }

  connectionOwnershipAndPresentationSteps(
    client: DaemonClientLike,
  ): readonly [() => Promise<void>, () => Promise<void>] {
    // Capture this before applying the profile: the first successful write
    // mints and stores the UUID. On first connect the profile must exist before
    // ownership establishment can publish `connected`; on reconnect the UUID is
    // already attached to concurrent calls, so reassert ownership first and
    // reapply the DB-backed presentation writes afterward. Keeping reconnect's
    // heartbeat ahead of those writes preserves the pre-first-heartbeat reclaim
    // grace guarantee (#5637).
    const isFirstPresentationProfileApplication =
      this.runtime.toolSelectionProfileUuid === undefined;
    const applyPresentationProfile = () => this.applyConnectionPresentationProfile(client);

    // On the FIRST establishment mark the proxy `connected` only AFTER the
    // establishment heartbeat lands (issue #5643). ensureConnected()'s fast path
    // returns as soon as `connected && client` is true; setting the flag before the
    // awaited first heartbeat would let a CONCURRENT ensureConnected() (a parallel
    // listTools/callTool during MCP startup) resolve and forward a request in the
    // sub-millisecond window before the daemon has recorded ownership. Deferring the
    // flip holds those concurrent callers on the `connecting` guard until ownership
    // is recorded; the heartbeat guards key off the live transport (`transportLive`),
    // not this flag, so the first heartbeat still fires while it is still false. On a
    // RECONNECT there is no ownership to wait for, so establishBoundSessionHeartbeat
    // flips `connected` itself before dispatching the keeper heartbeat (see there).
    // A stable owner token also resumes the sessions it holds (#10990); without one the
    // establishment step is unchanged.
    const establishBaseOwnership = stableLivenessOwnerToken(this.runtime.config)
      ? async () => {
          await this.port.establishBoundSessionHeartbeat(client);
          await this.port.resumeTokenOwnedSessions(client);
        }
      : () => this.port.establishBoundSessionHeartbeat(client);
    // A broker binding connection that reconnects re-binds the new socket to its binding sessions
    // (#11178); the daemon dropped the old socket's binding when it closed. Other proxies keep
    // their establishment exactly as before.
    const establishOwnership = this.runtime.brokerSessions.heldBinding()
      ? async () => {
          await establishBaseOwnership();
          await this.runtime.brokerSessions.rebindConnection(client);
        }
      : establishBaseOwnership;

    return isFirstPresentationProfileApplication
      ? [applyPresentationProfile, establishOwnership]
      : [establishOwnership, applyPresentationProfile];
  }

  applyConnectionPresentationProfile(client: DaemonClientLike): Promise<void> {
    return applyConnectionPresentationProfile(client, this.runtime.config.daemonOptions, {
      withToolSelectionProfile: (args) => this.port.withToolSelectionProfile(args),
      rememberToolSelectionProfile: (...args) => this.port.rememberToolSelectionProfile(...args),
      hasToolSelectionProfile: () => Boolean(this.runtime.toolSelectionProfileUuid),
    });
  }

  createStatusProbe(config: DaemonMcpProxyConfig): (() => Promise<DaemonStatus>) | undefined {
    return this.runtime.lifecycleReconciler.createStatusProbe(config);
  }

  reconciliationStatus(): Promise<DaemonStatus> {
    return this.runtime.lifecycleReconciler.reconciliationStatus();
  }

  isSameDaemonGeneration(current: DaemonStatus, expected: DaemonStatus): boolean {
    return this.runtime.lifecycleReconciler.isSameDaemonGeneration(current, expected);
  }

  /**
   * A competing client can observe the incumbent during an admitted restart's
   * intentional handoff gap. Wait for a different, running generation instead
   * of treating that gap as a completed reconciliation.
   */
  waitForJoinedRestartSuccessor(expected: DaemonStatus, deadline: number): Promise<DaemonStatus> {
    return this.runtime.lifecycleReconciler.waitForJoinedRestartSuccessor(expected, deadline);
  }

  waitForRunningReconciliationStatus(deadline: number): Promise<DaemonStatus> {
    return this.runtime.lifecycleReconciler.waitForRunningReconciliationStatus(deadline);
  }

  readSocketReconciliationStatus(): Promise<DaemonStatus> {
    return this.runtime.lifecycleReconciler.readSocketReconciliationStatus();
  }

  assertAutomaticRestartAllowed(status: DaemonStatus, reason: string): void {
    return this.runtime.lifecycleReconciler.assertAutomaticRestartAllowed(status, reason);
  }

  /** Newer clients may replace older daemons; mismatches remain a pre-dispatch gate. */
  ensureVersionMatches(
    reconciliationDeadline = this.runtime.timer.now() + DAEMON_STARTUP_TIMEOUT_MS,
    observedStatus?: DaemonStatus,
  ): Promise<void> {
    return this.runtime.lifecycleReconciler.ensureVersionMatches(
      reconciliationDeadline,
      observedStatus,
    );
  }

  verifyRestartedVersion(): Promise<void> {
    return this.runtime.lifecycleReconciler.verifyRestartedVersion();
  }

  requiresVersionRestart(status: DaemonStatus, runningVersion: string): boolean {
    return this.runtime.lifecycleReconciler.requiresVersionRestart(status, runningVersion);
  }

  assertNewerClientVersion(
    status: DaemonStatus,
    runningVersion: string,
    runningBase: string,
    clientBase: string,
    sameRelease: boolean,
  ): void {
    return this.runtime.lifecycleReconciler.assertNewerClientVersion(
      status,
      runningVersion,
      runningBase,
      clientBase,
      sameRelease,
    );
  }

  assertVersionRestartCooldownExpired(status: DaemonStatus, runningVersion: string): void {
    return this.runtime.lifecycleReconciler.assertVersionRestartCooldownExpired(
      status,
      runningVersion,
    );
  }

  versionMismatchError(
    runningVersion: string,
    reason: VersionMismatchReason,
    detail: string,
    retryAfterMs?: number,
    daemonBuild?: BuildIdentity,
  ): DaemonVersionMismatchError {
    return this.runtime.lifecycleReconciler.versionMismatchError(
      runningVersion,
      reason,
      detail,
      retryAfterMs,
      daemonBuild,
    );
  }

  ensureAssetVersionPinMatches(): Promise<void> {
    return this.runtime.lifecycleReconciler.ensureAssetVersionPinMatches();
  }

  /**
   * Ensure the client never attaches to a daemon built from a *different* checkout.
   * The version string alone cannot detect this (two checkouts can both report the
   * same pre-release version), so we compare a content hash of the entry script.
   * On mismatch, restart the daemon from this client's own entrypoint so the live
   * frontend and backend run the same code. Independent of, and complementary to,
   * {@link ensureVersionMatches}.
   */
  ensureBuildMatches(
    reconciliationDeadline = this.runtime.timer.now() + DAEMON_STARTUP_TIMEOUT_MS,
    observedStatus?: DaemonStatus,
  ): Promise<void> {
    return this.runtime.lifecycleReconciler.ensureBuildMatches(
      reconciliationDeadline,
      observedStatus,
    );
  }

  finishBuildRestart(
    restartResult: DaemonRestartResult,
    status: DaemonStatus,
    reconciliationDeadline: number,
  ): Promise<void> {
    return this.runtime.lifecycleReconciler.finishBuildRestart(
      restartResult,
      status,
      reconciliationDeadline,
    );
  }

  buildMismatchError(
    daemon: BuildIdentity,
    reason: BuildMismatchReason,
    detail: string,
    retryAfterMs?: number,
  ): DaemonBuildMismatchError {
    return this.runtime.lifecycleReconciler.buildMismatchError(
      daemon,
      reason,
      detail,
      retryAfterMs,
    );
  }

  ensureStartupOptionsMatch(): Promise<void> {
    return this.runtime.lifecycleReconciler.ensureStartupOptionsMatch();
  }

  /**
   * Start the daemon process
   */
  startDaemon(): Promise<void> {
    return this.runtime.lifecycleReconciler.startDaemon();
  }

  shouldSkipLeaseRefreshForDeviceControlTransportError(error: unknown): boolean {
    return (
      error instanceof DeviceControlTransportError &&
      (error.failure.phase === "connect" || !error.failure.sessionValid)
    );
  }

  async resetConnection(): Promise<void> {
    const shutdownDisconnectResolve = this.runtime.daemonShutdownBarrier.currentResolver;
    const staleClient = this.runtime.client;
    this.runtime.resourceSubscriptionSync = Promise.resolve();
    this.runtime.connected = false;
    this.runtime.client = null;
    this.runtime.ownershipReestablishment = undefined;
    this.runtime.structuredSessionNotFound = false;
    this.runtime.notificationUnsubscribe?.();
    this.runtime.notificationUnsubscribe = null;
    this.runtime.connectionClosedUnsubscribe?.();
    this.runtime.connectionClosedUnsubscribe = null;
    this.runtime.listPoller.markDropped();
    this.port.invalidateCache();

    if (!staleClient) {
      this.runtime.daemonShutdownBarrier.complete(shutdownDisconnectResolve);
      return;
    }

    try {
      await staleClient.close();
    } catch (error) {
      logger.warn(`[DaemonMcpProxy] Failed to close stale daemon client: ${error}`);
    }
    // resetConnection deliberately unregisters the peer-close callback before
    // closing the stale client. Resolve an armed shutdown barrier explicitly so
    // the retry cannot wait forever for a callback that can no longer fire.
    this.runtime.daemonShutdownBarrier.complete(shutdownDisconnectResolve);
  }

  subscribeToClientConnectionClosed(client: DaemonClientLike): void {
    if (typeof client.onConnectionClosed !== "function") {
      return;
    }
    this.runtime.connectionClosedUnsubscribe?.();
    this.runtime.connectionClosedUnsubscribe = client.onConnectionClosed(() => {
      if (this.runtime.client === client) {
        // EOF is the only connection-wide shutdown signal an idle proxy receives,
        // and a subscribed release notification can be lost while the old socket
        // drains. Arm the same successor barrier before reset detaches this client.
        this.runtime.daemonShutdownBarrier.arm();
        this.runtime.daemonShutdownBarrier.complete();
        void this.resetConnection().then(() =>
          this.port.connectResourceSubscriptionsInBackground(),
        );
      }
    });
  }

  /**
   * The live client for an operation closure. A socket close can land between
   * ensureConnected() resolving and the closure running (#6389); report that as
   * a recoverable DaemonUnavailableError rather than a TypeError on null. No
   * client means no request frame was written, so the failure is typed as not
   * delivered: a non-idempotent tool may then be retried on the reconnected
   * client instead of being reported as outcome-unknown (#9996).
   */
  requireClient(): DaemonClientLike {
    if (!this.runtime.client) {
      throw new DaemonRequestNotDeliveredError("Daemon socket connection is not established");
    }
    return this.runtime.client;
  }

  /** The caller's signal, also aborted (with a typed `DaemonUnavailableError`) by {@link close}. */
  untilClosed(signal: AbortSignal | undefined): AbortSignal {
    return signal
      ? AbortSignal.any([signal, this.runtime.closeAbort.signal])
      : this.runtime.closeAbort.signal;
  }

  /**
   * Close the connection to the daemon. Stdin EOF waits for received requests' answers before
   * reaching close (#12049); a signal, a stdout write error, or the EOF hard bound still cancels
   * calls here, before releasing owned sessions and broker grants. Session release is admitted
   * in arrival order on this proxy's socket, behind any call still running there; otherwise
   * release would time out unadmitted and leave the session to owner-disconnect release (#11642).
   * Each caller is answered with a typed `DaemonUnavailableError`, never left waiting. At the
   * EOF hard bound, `OutputGatedTransport` still writes received answers while dropping all
   * unsolicited output; a stdout write error closes that gate fully at once (#11951).
   */
  /**
   * Live owner-liveness check consulted when close begins (#12986). Stdin EOF or a transport
   * close can start the close before the owner watch's next poll notices the owner is gone;
   * asking the owner directly makes owner death win whichever signal arrives first.
   */
  setExecutionOwnerLossProbe(probe: () => boolean): void {
    this.runtime.executionOwnerLossProbe = probe;
  }

  executionOwnerLost(options?: DaemonMcpProxyCloseOptions): boolean {
    if (options?.executionOwnerLost) {
      return true;
    }
    try {
      return this.runtime.executionOwnerLossProbe?.() === true;
    } catch (error) {
      // An unanswerable probe proves nothing: fall back to the ordinary release classification.
      logger.warn(`[DaemonMcpProxy] Execution owner probe failed: ${errorMessage(error)}`, error);
      return false;
    }
  }

  close(options?: DaemonMcpProxyCloseOptions): Promise<void> {
    // EOF and signal/transport shutdown may overlap: keep the socket until the same release settles.
    return (this.runtime.closePromise ??= this.closeOnce(options));
  }

  async closeOnce(options?: DaemonMcpProxyCloseOptions): Promise<void> {
    const connectedClient = this.runtime.connected ? this.runtime.client : null;
    const ownerLost = this.executionOwnerLost(options);
    this.runtime.closing = true;
    const closingError = new DaemonUnavailableError("MCP proxy is closing");
    this.runtime.brokerSessions.abortAcquisition(closingError);
    this.runtime.closeAbort.abort(closingError);
    this.runtime.connected = false;
    this.runtime.livenessRecovery.stop();
    // Not awaited: a probe round waiting on a frozen daemon must not hold up close; `closing`
    // already keeps it from acting on any answer.
    void this.runtime.stallResumeProbe.stop();
    this.runtime.resourceSubscriptions.clear();
    this.runtime.resourceUpdatedListeners.clear();
    this.runtime.structuredSessionNotFound = false;
    this.runtime.structuredToolErrorCodes = false;
    this.runtime.daemonShutdownBarrier.complete();
    this.port.cancelBackgroundConnectRetry();
    this.port.cancelConnectedFallbackReconcile();
    this.runtime.connectionCloseReject?.(new DaemonUnavailableError("MCP proxy is closing"));
    // A completed device-binding task must not bind a session after the release below (#13144).
    await this.runtime.forwardedResultApplier.deviceBindingTasks?.drain(
      BROKER_EXECUTION_RELEASE_TIMEOUT_MS,
    );
    // Before the keeper stops, so the lease stays live until the release lands (#11176).
    await Promise.all([
      this.releaseOwnedSessions(connectedClient),
      this.runtime.brokerSessions.releaseAll(ownerLost ? SESSION_OWNER_EXITED_CODE : undefined),
      this.joinConnectionAttempt(),
    ]);
    await this.runtime.latestBindingKeeper.stopBoundSessionHeartbeat();
    if (this.runtime.client) {
      await this.runtime.client.close();
      this.runtime.client = null;
    }
    this.runtime.notificationUnsubscribe?.();
    this.runtime.notificationUnsubscribe = null;
    this.runtime.connectionClosedUnsubscribe?.();
    this.runtime.connectionClosedUnsubscribe = null;
    this.runtime.listPoller.stop();
    this.runtime.connected = false;
    this.port.clearBoundSessionUuid();
    this.runtime.otherHeldSessions.clear();
    this.runtime.brokerSessions.clear();
    // Every not-found window ends with the proxy: nothing is heartbeated or asked again (#11570).
    this.runtime.notFoundWindows.clear();
    this.runtime.notFoundStopped.clear();
    this.runtime.sessionDaemonInstances.clear();
    this.runtime.recoveryNotFoundOutcomes.clear();
    this.runtime.ownershipReestablishment = undefined;
    this.runtime.latestHeartbeatAsked = undefined;
    this.runtime.livenessAcks.clear();
    this.runtime.daemonIdleReports.clear();
    this.runtime.sessionDeviceIds.clear();
    this.runtime.sessionPlatforms.clear();
    this.runtime.stallHandovers.clear();
    this.runtime.resumedStallNotices.clear();
    this.runtime.pendingSessionLosses.clear();
    this.runtime.pendingHeldSessionPlatformLosses.clear();
    this.runtime.plainRestartSessionLosses.clear();
    this.runtime.livenessHandoverListeners.clear();
    this.runtime.ownedDeviceSessions.clear();
    this.runtime.terminalBoundSession = undefined;
    // Drain the per-UUID release-tracking maps at the close/reconnect boundary.
    // Ordinary completion already evicts each entry when its last in-flight
    // reference drops (issue #4655 / #5412), so these maps are bounded by the
    // count of concurrently in-flight calls. Clearing them on close is the
    // backstop the reference counter does not cover — a proxy closed with calls
    // still in flight, or reused across a reconnect, cannot retain release
    // records across its lifetime (issue #4689).
    this.runtime.releaseLedger.clearReleaseRecords();
    this.port.invalidateCache();
    logger.debug("[DaemonMcpProxy] Disconnected from daemon");
  }
}

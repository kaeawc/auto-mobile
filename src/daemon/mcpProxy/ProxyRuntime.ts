import { isExplicitPin, resolveAssetVersion, resolvePinnedVersion } from "../../constants/release";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { logger } from "../../utils/logger";
import { probeCheckoutMcpServerVersion } from "../../utils/mcpVersion";
import { SingleFlightInterval } from "../SingleFlightInterval";
import { getCurrentBuildIdentity, type BuildIdentity } from "../wire/buildIdentity";
import { DaemonClient, type DaemonClientFactory, type DaemonClientLike } from "../client/client";
import { CONNECTION_TIMEOUT_MS, DAEMON_VERSION, SOCKET_PATH } from "../wire/constants";
import { type ListChangedKind } from "../listChangedBroadcast";
import { DaemonManager, type DaemonManagerLike } from "../manager";
import {
  BoundSessionFenceGate,
  type BoundSessionFenceGatePort,
} from "../proxy/BoundSessionFenceGate";
import {
  BoundSessionHeartbeat,
  type BoundSessionHeartbeatPort,
} from "../proxy/BoundSessionHeartbeat";
import { BrokerSessions } from "../proxy/BrokerSessions";
import { ConnectionRecovery, type ConnectionRecoveryPort } from "../proxy/ConnectionRecovery";
import { DaemonErrorClassifier } from "../proxy/DaemonErrorClassifier";
import {
  DaemonLifecycleReconciler,
  type DaemonLifecycleReconcilerDeps,
} from "../proxy/DaemonLifecycleReconciler";
import { DaemonShutdownBarrier } from "../proxy/DaemonShutdownBarrier";
import { DiscoveryListCache } from "../proxy/DiscoveryListCache";
import { FinalizedRecordingOwners } from "../proxy/FinalizedRecordingOwners";
import { ForwardedResultApplier } from "../proxy/ForwardedResultApplier";
import { HandoverResolution, type HandoverResolutionPort } from "../proxy/HandoverResolution";
import { HeartbeatKeeper, type HeartbeatKeeperPort } from "../proxy/HeartbeatKeeper";
import {
  HeldSessionHeartbeatOutcomes,
  type HeldSessionHeartbeatOutcomesPort,
} from "../proxy/HeldSessionHeartbeatOutcomes";
import {
  HeldSessionLosses,
  type HeldSessionLossesPort,
  type PendingHeldSessionLoss,
} from "../proxy/HeldSessionLosses";
import { LatestBindingKeeper, type LatestBindingKeeperPort } from "../proxy/LatestBindingKeeper";
import {
  ProxySessionState,
  type DaemonIdleReport,
  type LatestHeartbeatAsk,
  type OtherHeldSession,
  type StallHandoverRecord,
  type TerminalBoundSession,
} from "../proxy/ProxySessionState";
import { ReleaseEpochLedger } from "../proxy/ReleaseEpochLedger";
import { ResourceSubscriptions } from "../proxy/ResourceSubscriptions";
import { SessionBinding, type SessionBindingDependencies } from "../proxy/SessionBinding";
import { StallProbe, type StallProbePort } from "../proxy/StallProbe";
import { ToolCallForwarder } from "../proxy/ToolCallForwarder";
import { ToolListPoller } from "../proxy/ToolListPoller";
import {
  heartbeatIntervalMs,
  heartbeatLeashMs,
  resolveLivenessOwnerToken,
} from "../proxy/heartbeatCadence";
import { type NotFoundAnswerOutcome } from "../proxy/notFoundDecision";
import {
  LivenessRecovery,
  TickLatenessClock,
  ownershipConflictLeashMs,
  type DaemonRestartEvidence,
  type LivenessHandover,
  type OwnerConflictLeash,
} from "../proxyLivenessRecovery";
import { getSessionIdleTimeoutMs } from "../wire/sessionLivenessWindows";
import { getStaticToolDefinitions } from "../staticToolDefinitions";
import { type DaemonOptions, type DaemonStatus } from "../types";
import {
  CLI_SESSION_FINALIZATION_TIMEOUT_MS,
  DaemonMcpProxyConfig,
  DaemonProxyProgressCallback,
  ProxiedToolDefinition,
  connectedStaticToolDefinitionsProvider,
  daemonAvailabilityProbe,
} from "./ProxyContracts";

/** Mutable connection and session state shared through narrowed collaborator views. */
export class ProxyRuntime {
  private port!: ProxyRuntimePort;

  boundSessionFenceGate!: BoundSessionFenceGate;

  sessionState = new ProxySessionState();

  lifecycleReconciler!: DaemonLifecycleReconciler;

  resourceSubscriptionManager!: ResourceSubscriptions;

  client: DaemonClientLike | null = null;

  closePromise: Promise<void> | undefined;

  executionOwnerLossProbe: (() => boolean) | undefined;

  config!: DaemonMcpProxyConfig;

  daemonManager!: DaemonManagerLike;

  clientFactory!: DaemonClientFactory;

  daemonStatusProbe?: () => Promise<DaemonStatus>;

  readCheckoutVersion?: () => Promise<string | null>;

  daemonAvailabilityProbe!: (socketPath: string) => Promise<boolean>;

  reconciliationSnapshot?: Promise<DaemonStatus>;

  // Connection-scoped: tools/list_changed invalidates status, but does not replace its daemon.
  structuredSessionNotFound = false;

  structuredToolErrorCodes = false;

  timer!: Timer;

  heartbeatKeeper!: SingleFlightInterval;

  proxyHeartbeatKeeper!: HeartbeatKeeper;

  sessionBinding!: SessionBinding;

  errorClassifier!: DaemonErrorClassifier;

  connectionRecovery!: ConnectionRecovery;

  heartbeatLeashMs!: number;

  heartbeatIntervalMs!: number;

  /**
   * Whether the recurring bound-session heartbeat keeper has been started for the
   * current binding. Gates the awaited establishment heartbeat (issue #5637) to
   * the FIRST connection only: once the keeper is running it owns every
   * subsequent tick, so a later reconnect must not send an extra, un-coalesced
   * heartbeat.
   */
  get heartbeatKeeperStarted(): boolean {
    return this.latestBindingKeeper.started;
  }

  get recoveryNotFoundOutcomes(): Map<
    string,
    { outcome: NotFoundAnswerOutcome; releaseReason: string | undefined }
  > {
    return this.sessionState.recoveryNotFoundOutcomes;
  }

  get notFoundWindows(): Map<string, { since: number; handoffs: Set<string> }> {
    return this.sessionState.notFoundWindows;
  }

  get notFoundStopped(): Set<string> {
    return this.sessionState.notFoundStopped;
  }

  get sessionDaemonInstances(): Map<string, string> {
    return this.sessionState.sessionDaemonInstances;
  }

  /**
   * The connection that was established with sessions already held, and the sessions the daemon
   * has not yet answered a heartbeat for on it: the latest binding (#11529) and every session held
   * besides it (#11557). That first answer comes from the daemon this proxy just connected to, on
   * a socket that has carried nothing else for the session: a not-found there is about the
   * session, never a stale connection.
   */
  ownershipReestablishment: { client: DaemonClientLike; sessionUuids: Set<string> } | undefined;

  get latestHeartbeatAsked(): LatestHeartbeatAsk | undefined {
    return this.sessionState.latestHeartbeatAsked;
  }

  set latestHeartbeatAsked(value: LatestHeartbeatAsk | undefined) {
    this.sessionState.latestHeartbeatAsked = value;
  }

  /**
   * Whether this connection already declared its bound session CLI-owned
   * (issue #6870 review). Once declared, this proxy's remaining heartbeats must
   * keep carrying the CLI marker: an ordinary heartbeat now restores the strict
   * contract on the daemon, and a keeper tick racing process exit would undo the
   * declaration the invocation just made.
   */
  cliSessionLivenessDeclared = false;

  get livenessOwnershipClaimSent(): boolean {
    return this.sessionState.livenessOwnershipClaimSent;
  }

  set livenessOwnershipClaimSent(value: boolean) {
    this.sessionState.livenessOwnershipClaimSent = value;
  }

  get otherHeldSessions(): Map<string, OtherHeldSession> {
    return this.sessionState.otherHeldSessions;
  }

  get livenessSupersessionLogged(): boolean {
    return this.sessionState.livenessSupersessionLogged;
  }

  set livenessSupersessionLogged(value: boolean) {
    this.sessionState.livenessSupersessionLogged = value;
  }

  get livenessConflictLogged(): Set<string> {
    return this.sessionState.livenessConflictLogged;
  }

  /** How long a refused claim keeps retrying: the other owner's lease plus its grace (#10053). */
  ownershipConflictLeashMs!: number;

  /**
   * The daemon's idle window, which retires the remembered binding and evicts abandoned held
   * sessions. Read from the same `AUTOMOBILE_SESSION_IDLE_TIMEOUT_MS` override the daemon reads.
   */
  boundSessionReplayTtlMs = getSessionIdleTimeoutMs();

  get latestBindingConflict(): ({ sessionUuid: string } & OwnerConflictLeash) | undefined {
    return this.sessionState.latestBindingConflict;
  }

  set latestBindingConflict(value: ({ sessionUuid: string } & OwnerConflictLeash) | undefined) {
    this.sessionState.latestBindingConflict = value;
  }

  get initialSessionAwaitingFirstCall(): boolean {
    return this.sessionState.initialSessionAwaitingFirstCall;
  }

  set initialSessionAwaitingFirstCall(value: boolean) {
    this.sessionState.initialSessionAwaitingFirstCall = value;
  }

  get releaseSurfacedFor(): string | undefined {
    return this.sessionState.releaseSurfacedFor;
  }

  set releaseSurfacedFor(value: string | undefined) {
    this.sessionState.releaseSurfacedFor = value;
  }

  /** Held terminal losses awaiting one platform-only control answer, in loss order (#12090). */
  heldSessionLosses!: HeldSessionLosses;

  heartbeatOutcomes!: HeldSessionHeartbeatOutcomes;

  boundHeartbeat!: BoundSessionHeartbeat;

  latestBindingKeeper!: LatestBindingKeeper;

  get pendingHeldSessionPlatformLosses(): Map<string, PendingHeldSessionLoss> {
    return this.heldSessionLosses.pending;
  }

  get plainRestartSessionLosses(): Map<string, string> {
    return this.sessionState.plainRestartSessionLosses;
  }

  /** Bounded per-session recovery when heartbeat acknowledgements stop (#10053). */
  livenessRecovery!: LivenessRecovery;

  /** The call-wait bound of the current stretch of liveness recovery (#10508). */
  livenessRecoveryCallWait: { episode: number; deadline: number } | undefined;

  /** Detects this proxy's own tick firing later than the lease allows. */
  tickLateness!: TickLatenessClock;

  get livenessAcks(): Map<string, number> {
    return this.sessionState.livenessAcks;
  }

  get daemonIdleReports(): Map<string, DaemonIdleReport> {
    return this.sessionState.daemonIdleReports;
  }

  /** Device each held session runs on, learned from acquisition results and explicit calls. */
  sessionDeviceIds = new Map<string, string>();

  /** Platform each acquired session runs on; absent when its result did not describe one. */
  sessionPlatforms = new Map<string, "android" | "ios">();

  get stallHandovers(): Map<string, StallHandoverRecord> {
    return this.sessionState.stallHandovers;
  }

  get resumedStallNotices(): Map<
    string,
    { handover: LivenessHandover; restart?: DaemonRestartEvidence }
  > {
    return this.sessionState.resumedStallNotices;
  }

  get ackedDaemonInstance(): string | undefined {
    return this.sessionState.ackedDaemonInstance;
  }

  set ackedDaemonInstance(value: string | undefined) {
    this.sessionState.ackedDaemonInstance = value;
  }

  /** Keeps probing a daemon that stalled past recovery, so one that resumes is heard (#10989). */
  stallResumeProbe!: SingleFlightInterval;

  stallProbe!: StallProbe;

  handoverResolution!: HandoverResolution;

  toolCallForwarder!: ToolCallForwarder;

  forwardedResultApplier!: ForwardedResultApplier;

  get pendingSessionLosses(): Map<string, LivenessHandover> {
    return this.sessionState.pendingSessionLosses;
  }

  livenessHandoverListeners = new Set<(handover: LivenessHandover) => void>();

  /** Tool calls currently awaiting an answer on each daemon connection. */
  toolCallsInFlight = new WeakMap<DaemonClientLike, number>();

  /** Resolved when the last tool call in flight on a draining connection settles. */
  toolCallsSettled = new WeakMap<DaemonClientLike, PromiseWithResolvers<void>>();

  /**
   * Tool calls forwarded under each session UUID that have not finished yet. A session with a call
   * in flight is in use, so neither the replay lease of the latest binding nor a held session's
   * idle eviction may retire it; the idle clock restarts when its last call ends.
   */
  sessionCallsInFlight = new Map<string, number>();

  /** Connections a liveness attempt saw fail at the transport level: dead, with nothing to lose. */
  deadSocketClients = new WeakSet<DaemonClientLike>();

  /** Stable for this proxy instance, including all transport reconnects. */
  livenessOwnerToken!: string;

  /** Owns this proxy's MCP tasks on the daemon across reconnects (#4668); minted on first use. */
  mintedTaskOwnerKey: string | undefined;

  /** Device-binding calls relayed as MCP tasks, bound once from their completed result (#4668). */
  /** A device-binding task outlasted the close's drain: its late bind must publish nothing (#13155). */
  deviceBindingTasksAbandoned = false;

  buildIdentity!: BuildIdentity;

  get clientVersion(): string {
    return this.config.clientVersion ?? DAEMON_VERSION;
  }

  clientAssetVersion!: string | null;

  connecting: Promise<void> | null = null;

  /** Underlying connection work retained even when close rejects the public single-flight waiter. */
  connectionAttemptWork: Promise<void> | null = null;

  connectingAllowsLifecycle = false;

  connectionCloseReject: ((reason?: unknown) => void) | null = null;

  /**
   * A `daemon-shutdown` release arrives before the old daemon closes its socket.
   * Calls admitted for replacement acquisition wait on this peer-close barrier
   * instead of reconnecting to the still-reachable but quiesced incarnation.
   */
  daemonShutdownBarrier!: DaemonShutdownBarrier;

  /**
   * When the daemon last announced a clean `daemon-shutdown` release (proxy clock). A
   * `daemon_stalled` handover with no acknowledgement since is the expected outcome of that
   * shutdown, not a daemon fault, so it is logged below error level (#11189).
   */
  daemonShutdownAnnouncedAt: number | undefined;

  connected: boolean = false;

  closing: boolean = false;

  get boundSessionUuid(): string | undefined {
    return this.sessionState.boundSessionUuid;
  }

  set boundSessionUuid(value: string | undefined) {
    this.sessionState.boundSessionUuid = value;
  }

  get boundSessionUuidAt(): number | undefined {
    return this.sessionState.boundSessionUuidAt;
  }

  set boundSessionUuidAt(value: number | undefined) {
    this.sessionState.boundSessionUuidAt = value;
  }

  get boundSessionFromResultMint(): boolean {
    return this.sessionState.boundSessionFromResultMint;
  }

  set boundSessionFromResultMint(value: boolean) {
    this.sessionState.boundSessionFromResultMint = value;
  }

  // Every device session this connection has bound over its lifetime and not yet
  // seen released. `boundSessionUuid` only tracks the LATEST binding, so acquiring
  // a second device (e.g. getApple after getAndroid) moves it off the first
  // session. A fresh-screenshot resource read names its session in the URI, and it
  // must route to that owning session — not the latest binding — or the daemon
  // seeds the loopback with the wrong session and denies the just-established
  // owner with SCREENSHOT_ACCESS_DENIED (issue #5663). Membership here is what
  // authorizes owner-routing; a session this connection never bound is absent, so
  // a foreign read still forwards this connection's own binding and stays denied.
  finalizedRecordingOwners = new FinalizedRecordingOwners({
    holdsSession: (id) =>
      id === this.boundSessionUuid ||
      id === this.terminalBoundSession?.sessionUuid ||
      this.ownedDeviceSessions.has(id) ||
      this.claimableSessions.has(id) ||
      this.otherHeldSessions.has(id),
  });

  ownedDeviceSessions = new Set<string>();

  get claimableSessions(): Set<string> {
    return this.sessionState.claimableSessions;
  }

  brokerSessionsInstance: BrokerSessions | undefined;

  /** Built on first use: it reads the timer and liveness owner token the constructor sets. */
  get brokerSessions(): BrokerSessions {
    return (this.brokerSessionsInstance ??= this.port.createBrokerSessions());
  }

  /**
   * Aborts every tool call and resource read this proxy has in flight when it closes (#11642).
   * Each one's daemon request is cancelled on its own socket (`daemon/cancelRequest`), so nothing
   * of this proxy's is left ahead of the managed execution release in the socket's queue.
   */
  closeAbort = new AbortController();

  get terminalBoundSession(): TerminalBoundSession | undefined {
    return this.sessionState.terminalBoundSession;
  }

  set terminalBoundSession(value: TerminalBoundSession | undefined) {
    this.sessionState.terminalBoundSession = value;
  }

  /** A recoverable daemon release needs a replacement transport, not a UUID fence. */
  recoverableBoundSessionHandoff: string | undefined;

  /** Only a device-restart handoff presents the binding on a fresh acquisition. */
  recoverableBoundSessionHandoffIsDeviceRestart = false;

  get initialSessionBindingConfigured(): boolean {
    return this.sessionState.initialSessionBindingConfigured;
  }

  set initialSessionBindingConfigured(value: boolean) {
    this.sessionState.initialSessionBindingConfigured = value;
  }

  // A connection-level tool-selection profile is not a daemon device session. It
  // survives executePlan's device-session release and is forwarded through the
  // socket only when no explicit/remembered routing session is in use.
  toolSelectionProfileUuid: string | undefined;

  // Monotonic release-epoch counter, bumped every time the daemon signals that a
  // session was released (via handleDaemonNotification). `releasedSessionEpochs`
  // records, per released UUID, the epoch at which it was last released. A
  // callTool captures the epoch at forward time; on completion the post-call
  // remember/refresh asks "was the SPECIFIC UUID I forwarded released at a later
  // epoch?" and, if so, declines to resurrect it. Scoping the guard to the
  // forwarded UUID (issue #4655) — rather than a single global generation bumped
  // by ANY binding change (issue #4611's first cut) — means the release of an
  // UNRELATED session mid-call no longer blocks remembering the session THIS call
  // actually forwarded, while a release of the forwarded UUID still preserves.
  releaseLedger = new ReleaseEpochLedger();

  // Supplies the static tool surface for listAdvertisedTools() before a daemon
  // connection exists (issue #5879).
  staticToolDefinitionsProvider!: () => ProxiedToolDefinition[];

  connectedStaticToolDefinitionsProvider!: (
    daemonOptions?: DaemonOptions,
  ) => ProxiedToolDefinition[];

  // Set when listAdvertisedTools() served the static surface without a live
  // connection. On the next successful connect the proxy emits a tools
  // list_changed so the client re-fetches the accurate (session-scoped) list.
  servedStaticToolList = false;

  // Set when listAdvertisedResources()/listAdvertisedResourceTemplates() served
  // a cold (empty/cached) roster without a live connection. On the next connect
  // the proxy emits a resources list_changed so the client re-fetches the real
  // resources (issue #5879 review — a host that enumerates resources on init
  // must not block on a wedged daemon before the first tool call).
  servedStaticResourceList = false;

  backgroundConnectRetry: NodeJS.Timeout | null = null;

  backgroundConnectRetryAttempt = 0;

  connectedFallbackReconcile: NodeJS.Timeout | null = null;

  connectedFallbackReconcileAttempt = 0;

  // Cached definitions from daemon, plus the discovery epoch (issue #4655)
  discovery!: DiscoveryListCache;

  get resourceSubscriptions(): Set<string> {
    return this.resourceSubscriptionManager.resourceSubscriptions;
  }

  get resourceUpdatedListeners(): Set<(uri: string) => void> {
    return this.resourceSubscriptionManager.resourceUpdatedListeners;
  }

  get resourceSubscriptionSync(): Promise<void> {
    return this.resourceSubscriptionManager.resourceSubscriptionSync;
  }

  set resourceSubscriptionSync(value: Promise<void>) {
    this.resourceSubscriptionManager.resourceSubscriptionSync = value;
  }

  // Listeners for daemon-forwarded list-changed notifications (issue #3223),
  // fired after the matching cache is invalidated so a re-fetch is never stale.
  listChangedListeners = new Set<(kind: ListChangedKind) => void>();

  // Polls the daemon lists while its list_changed push is unavailable (#4678).
  listPoller!: ToolListPoller;

  // A token can be reused by concurrent callers, and a new connection can
  // reuse a request id. Scope listeners to the client connection, then match
  // both the daemon request id and echoed caller token.
  progressListeners = new Map<
    DaemonClientLike,
    Map<string, { progressToken: string | number; listener: DaemonProxyProgressCallback }>
  >();

  // Releases this proxy's handler on the current client. Needed because a
  // clientFactory may return a shared/reused client (test fakes do); without it
  // every reconnect would stack another handler on that client.
  notificationUnsubscribe: (() => void) | null = null;

  // A daemon can close an idle socket without any request failing. Keep the
  // proxy's connection state synchronized with that passive transport loss.
  connectionClosedUnsubscribe: (() => void) | null = null;

  /**
   * The daemon transport is live and usable for a heartbeat. Distinct from the
   * public `connected` flag, which is deferred until AFTER the establishment
   * heartbeat lands so concurrent ensureConnected() callers block on ownership
   * (issue #5643). During that window the client has connected but `connected` is
   * still false; the first-heartbeat / keeper guards must treat the transport as
   * usable. Everywhere else `this.client !== null` tracks `connected` (both are
   * set on connect and cleared together on reset/close), so this only widens the
   * guard across the deliberate establishment window.
   */
  get transportLive(): boolean {
    return this.client !== null;
  }
  initialize(config: DaemonMcpProxyConfig, port: ProxyRuntimePort): void {
    this.port = port;
    this.daemonShutdownBarrier = port.createDaemonShutdownBarrier();
    this.discovery = port.createDiscoveryListCache();

    this.config = {
      autoStartDaemon: true,
      socketPath: SOCKET_PATH,
      connectionTimeoutMs: CONNECTION_TIMEOUT_MS,
      ...config,
    };
    this.daemonManager = config.daemonManager ?? new DaemonManager();
    this.clientFactory =
      config.clientFactory ??
      (() => new DaemonClient(this.config.socketPath, this.config.connectionTimeoutMs));
    const proxy = this;
    this.resourceSubscriptionManager = new ResourceSubscriptions({
      get client() {
        return proxy.client;
      },
      get connected() {
        return proxy.connected;
      },
      get closing() {
        return proxy.closing;
      },
      throwIfClosing: () => this.port.throwIfClosing(),
      connectResourceSubscriptionsInBackground: () =>
        this.port.connectResourceSubscriptionsInBackground(),
      assertConnectedClient: (client) => this.port.assertConnectedClient(client),
    });
    this.lifecycleReconciler = new DaemonLifecycleReconciler(
      this.port.createLifecycleReconcilerDeps(),
    );
    this.daemonStatusProbe = this.port.createStatusProbe(config);
    this.readCheckoutVersion =
      config.readCheckoutVersion ??
      (config.clientVersion === undefined && config.buildIdentity === undefined
        ? probeCheckoutMcpServerVersion
        : undefined);
    this.daemonAvailabilityProbe = daemonAvailabilityProbe(config);
    this.timer = config.timer ?? defaultTimer;
    this.listPoller = new ToolListPoller({
      timer: this.timer,
      intervalMs: config.listPollIntervalMs,
      fetchList: (kind) => this.port.pollDaemonList(kind),
      emitListChanged: (kind) => this.port.announceDaemonListChanged(kind),
    });
    this.heartbeatLeashMs = heartbeatLeashMs(config);
    this.heartbeatIntervalMs = heartbeatIntervalMs(config);
    this.ownershipConflictLeashMs = ownershipConflictLeashMs(
      this.heartbeatLeashMs,
      this.heartbeatIntervalMs,
    );
    this.tickLateness = new TickLatenessClock(this.heartbeatIntervalMs);
    this.livenessRecovery = this.port.createLivenessRecovery();
    this.livenessOwnerToken = resolveLivenessOwnerToken(config);
    this.heartbeatOutcomes = new HeldSessionHeartbeatOutcomes({
      timer: this.timer,
      otherHeldSessions: this.sessionState.otherHeldSessions,
      notFoundWindows: this.sessionState.notFoundWindows,
      livenessAcks: this.livenessAcks,
      livenessConflictLogged: this.livenessConflictLogged,
      livenessRecovery: this.livenessRecovery,
      ownershipConflictLeashMs: this.ownershipConflictLeashMs,
      port: this.port.createHeldSessionHeartbeatOutcomesPort(),
    });
    this.errorClassifier = new DaemonErrorClassifier({
      structuredSessionNotFound: () => this.structuredSessionNotFound,
      structuredToolErrorCodes: () => this.structuredToolErrorCodes,
      frontendRegistersTool: (name) => this.port.frontendRegistersTool(name),
    });
    this.connectionRecovery = new ConnectionRecovery(
      this.port.createConnectionRecoveryPort(),
      this.errorClassifier,
    );
    this.heldSessionLosses = new HeldSessionLosses(
      this.sessionPlatforms,
      this.port.createHeldSessionLossesPort(),
    );
    this.boundSessionFenceGate = new BoundSessionFenceGate(
      this.port.createBoundSessionFenceGatePort(),
    );
    this.boundHeartbeat = new BoundSessionHeartbeat({
      timer: this.timer,
      state: this.sessionState,
      ownedDeviceSessions: this.ownedDeviceSessions,
      ownershipConflictLeashMs: this.ownershipConflictLeashMs,
      heartbeatOutcomes: this.heartbeatOutcomes,
      heldSessionLosses: this.heldSessionLosses,
      port: this.port.createBoundSessionHeartbeatPort(),
    });
    this.sessionBinding = new SessionBinding(this.port.createSessionBindingDependencies());
    this.proxyHeartbeatKeeper = new HeartbeatKeeper({
      timer: this.timer,
      state: this.sessionState,
      tickLateness: this.tickLateness,
      livenessRecovery: this.livenessRecovery,
      heartbeatLeashMs: this.heartbeatLeashMs,
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      boundSessionReplayTtlMs: this.boundSessionReplayTtlMs,
      port: this.port.createHeartbeatKeeperPort(),
    });
    this.heartbeatKeeper = new SingleFlightInterval(
      this.timer,
      this.heartbeatIntervalMs,
      () => this.port.runBoundSessionHeartbeatTick(),
      {
        stopTimeoutMs: CLI_SESSION_FINALIZATION_TIMEOUT_MS,
        onError: (error) => {
          logger.warn(`[DaemonMcpProxy] Bound-session heartbeat failed: ${error}`);
        },
      },
    );

    this.initializeKeepers(config);
  }
  private initializeKeepers(config: DaemonMcpProxyConfig): void {
    this.latestBindingKeeper = new LatestBindingKeeper({
      timer: this.timer,
      state: this.sessionState,
      keeper: this.heartbeatKeeper,
      tickLateness: this.tickLateness,
      boundHeartbeat: this.boundHeartbeat,
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      heartbeatLeashMs: this.heartbeatLeashMs,
      port: this.port.createLatestBindingKeeperPort(),
    });
    this.stallProbe = new StallProbe({
      timer: this.timer,
      stallHandovers: this.sessionState.stallHandovers,
      port: this.port.createStallProbePort(),
    });
    this.handoverResolution = new HandoverResolution({
      timer: this.timer,
      state: this.sessionState,
      ownedDeviceSessions: this.ownedDeviceSessions,
      heldSessionLosses: this.heldSessionLosses,
      stallProbe: this.stallProbe,
      port: this.port.createHandoverResolutionPort(),
    });
    this.forwardedResultApplier = this.port.createForwardedResultApplier();
    this.toolCallForwarder = this.port.createToolCallForwarder();
    this.stallResumeProbe = new SingleFlightInterval(
      this.timer,
      this.heartbeatIntervalMs,
      () => this.stallProbe.probeStalledSessions(),
      {
        stopTimeoutMs: CLI_SESSION_FINALIZATION_TIMEOUT_MS,
        onError: (error) => {
          logger.warn(`[DaemonMcpProxy] Stalled-daemon probe failed: ${error}`);
        },
      },
    );
    if (
      typeof config.initialSessionUuid === "string" &&
      config.initialSessionUuid.trim().length > 0
    ) {
      this.port.bindStartupSession(config.initialSessionUuid.trim());
    }
    this.staticToolDefinitionsProvider =
      config.staticToolDefinitionsProvider ?? getStaticToolDefinitions;
    this.connectedStaticToolDefinitionsProvider = connectedStaticToolDefinitionsProvider(config);
    this.buildIdentity = config.buildIdentity ?? getCurrentBuildIdentity();
    this.clientAssetVersion = isExplicitPin() ? resolveAssetVersion(resolvePinnedVersion()) : null;
  }
}
/** Operations supplied by the proxy's composition root. */
export interface ProxyRuntimePort {
  createDaemonShutdownBarrier(): DaemonShutdownBarrier;
  createBrokerSessions(): BrokerSessions;
  createDiscoveryListCache(): DiscoveryListCache;
  throwIfClosing(): void;
  connectResourceSubscriptionsInBackground(): void;
  assertConnectedClient(client: DaemonClientLike): void;
  createLifecycleReconcilerDeps(): DaemonLifecycleReconcilerDeps;
  createStatusProbe(config: DaemonMcpProxyConfig): (() => Promise<DaemonStatus>) | undefined;
  pollDaemonList(kind: ListChangedKind): Promise<unknown>;
  announceDaemonListChanged(kind: ListChangedKind): void;
  createLivenessRecovery(): LivenessRecovery;
  createHeldSessionHeartbeatOutcomesPort(): HeldSessionHeartbeatOutcomesPort;
  frontendRegistersTool(name: string): boolean;
  createConnectionRecoveryPort(): ConnectionRecoveryPort;
  createHeldSessionLossesPort(): HeldSessionLossesPort;
  createBoundSessionFenceGatePort(): BoundSessionFenceGatePort;
  createBoundSessionHeartbeatPort(): BoundSessionHeartbeatPort;
  createSessionBindingDependencies(): SessionBindingDependencies;
  createHeartbeatKeeperPort(): HeartbeatKeeperPort;
  runBoundSessionHeartbeatTick(): Promise<void>;
  createLatestBindingKeeperPort(): LatestBindingKeeperPort;
  createStallProbePort(): StallProbePort;
  createHandoverResolutionPort(): HandoverResolutionPort;
  createForwardedResultApplier(): ForwardedResultApplier;
  createToolCallForwarder(): ToolCallForwarder;
  bindStartupSession(sessionUuid: string): void;
}

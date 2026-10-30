import type { SessionDeviceRebound } from "./sessionDeviceReboundBroadcast";
import { type SessionBrokerResult } from "../devices/sessionBrokerResult";
import type { SessionConfig } from "../devices/sessionConfig";
import { type ListChangedKind } from "./listChangedBroadcast";
import { ProxyCollaborators } from "./mcpProxy/ProxyCollaborators";
import { ProxyConnection } from "./mcpProxy/ProxyConnection";
import type {
  DaemonMcpProxyCloseOptions,
  DaemonMcpProxyConfig,
  DaemonProxyProgressCallback,
  DaemonProxyToolCallOptions,
  ProxiedResourceDefinition,
  ProxiedResourceTemplate,
  ProxiedToolDefinition,
} from "./mcpProxy/ProxyContracts";
import { ProxyDiscovery } from "./mcpProxy/ProxyDiscovery";
import { ProxyLiveness } from "./mcpProxy/ProxyLiveness";
import { ProxyNotifications } from "./mcpProxy/ProxyNotifications";
import { ProxyRuntime } from "./mcpProxy/ProxyRuntime";
import { ProxySessionOwnership } from "./mcpProxy/ProxySessionOwnership";
import { ProxyToolCalls } from "./mcpProxy/ProxyToolCalls";
import { ProxyToolRouting } from "./mcpProxy/ProxyToolRouting";
import type { DaemonMcpProxyTestInternals } from "./proxy/DaemonMcpProxyTestInternals";
import { DEVICE_CLEANUP_WAIT_BUDGET_MS } from "./proxy/DeviceCleanupWait";
import { type OtherHeldSession } from "./proxy/ProxySessionState";
import { type LivenessHandover } from "./proxyLivenessRecovery";
import type { TaskRelayMethod } from "./tasks/taskRelay";
export { DaemonRestartDeferredError } from "./daemonRestartAdmission";
export {
  type DaemonMcpProxyCloseOptions,
  type DaemonMcpProxyConfig,
  type DaemonProxyProgressCallback,
  type DaemonProxyToolCallOptions,
  isDeviceInventoryTool,
  type ProxiedResourceDefinition,
  type ProxiedResourceTemplate,
  type ProxiedToolDefinition,
} from "./mcpProxy/ProxyContracts";
export { resourceUriNamesSession } from "./proxy/BoundSessionFenceGate";
export {
  DaemonAmbiguousSessionSelectorError,
  DaemonAssetVersionMismatchError,
  DaemonBoundSessionExpiredError,
  DaemonBuildMismatchError,
  DaemonConnectionSessionReleasedError,
  DaemonSessionStalledError,
  DaemonToolOutcomeUnknownError,
  DaemonToolUnavailableError,
  DaemonVersionMismatchError,
  LifecycleConnectionInFlightError,
} from "./proxy/daemonErrors";
export {
  decideNotFoundAnswer,
  RECOVERABLE_NOT_FOUND_HEARTBEAT_WINDOW_MS,
  UNREHYDRATED_HANDOFF,
  type NotFoundAnswerFacts,
  type NotFoundAnswerOutcome,
} from "./proxy/notFoundDecision";
export {
  mergeDaemonOptions,
  REUSE_CRITICAL_OPTION_KEYS,
  STARTUP_OPTION_DEFICIT_KEYS,
  startupOptionDeficits,
} from "./proxy/startupOptions";
export { DEVICE_CLEANUP_WAIT_BUDGET_MS };

/** Public MCP proxy; composes connection, session, discovery and forwarding collaborators. */
export class DaemonMcpProxy {
  private readonly runtime = new ProxyRuntime();
  private readonly toolCalls: ProxyToolCalls;
  private readonly connection: ProxyConnection;
  private readonly sessionOwnership: ProxySessionOwnership;
  private readonly liveness: ProxyLiveness;
  private readonly discovery: ProxyDiscovery;
  private readonly notifications: ProxyNotifications;
  private readonly collaborators: ProxyCollaborators;
  private readonly toolRouting: ProxyToolRouting;
  constructor(config: DaemonMcpProxyConfig = {}) {
    this.toolCalls = this.createProxyToolCalls();
    this.connection = this.createProxyConnection();
    this.sessionOwnership = this.createProxySessionOwnership();
    this.liveness = this.createProxyLiveness();
    this.discovery = this.createProxyDiscovery();
    this.notifications = this.createProxyNotifications();
    this.collaborators = this.createProxyCollaborators();
    this.toolRouting = this.createProxyToolRouting();
    this.runtime.initialize(config, {
      createDaemonShutdownBarrier: (...args) =>
        this.collaborators.createDaemonShutdownBarrier(...args),
      createBrokerSessions: (...args) => this.collaborators.createBrokerSessions(...args),
      createDiscoveryListCache: (...args) => this.collaborators.createDiscoveryListCache(...args),
      throwIfClosing: (...args) => this.connection.throwIfClosing(...args),
      connectResourceSubscriptionsInBackground: (...args) =>
        this.discovery.connectResourceSubscriptionsInBackground(...args),
      assertConnectedClient: (...args) => this.discovery.assertConnectedClient(...args),
      createLifecycleReconcilerDeps: (...args) =>
        this.collaborators.createLifecycleReconcilerDeps(...args),
      createStatusProbe: (...args) => this.connection.createStatusProbe(...args),
      pollDaemonList: (...args) => this.discovery.pollDaemonList(...args),
      announceDaemonListChanged: (...args) => this.discovery.announceDaemonListChanged(...args),
      createLivenessRecovery: (...args) => this.liveness.createLivenessRecovery(...args),
      createHeldSessionHeartbeatOutcomesPort: (...args) =>
        this.collaborators.createHeldSessionHeartbeatOutcomesPort(...args),
      frontendRegistersTool: (...args) => this.toolCalls.frontendRegistersTool(...args),
      createConnectionRecoveryPort: (...args) =>
        this.collaborators.createConnectionRecoveryPort(...args),
      createHeldSessionLossesPort: (...args) =>
        this.collaborators.createHeldSessionLossesPort(...args),
      createBoundSessionFenceGatePort: (...args) =>
        this.collaborators.createBoundSessionFenceGatePort(...args),
      createBoundSessionHeartbeatPort: (...args) =>
        this.collaborators.createBoundSessionHeartbeatPort(...args),
      createSessionBindingDependencies: (...args) =>
        this.collaborators.createSessionBindingDependencies(...args),
      createHeartbeatKeeperPort: (...args) => this.collaborators.createHeartbeatKeeperPort(...args),
      runBoundSessionHeartbeatTick: (...args) =>
        this.liveness.runBoundSessionHeartbeatTick(...args),
      createLatestBindingKeeperPort: (...args) =>
        this.collaborators.createLatestBindingKeeperPort(...args),
      createStallProbePort: (...args) => this.collaborators.createStallProbePort(...args),
      createHandoverResolutionPort: (...args) =>
        this.collaborators.createHandoverResolutionPort(...args),
      createForwardedResultApplier: (...args) =>
        this.collaborators.createForwardedResultApplier(...args),
      createToolCallForwarder: (...args) => this.collaborators.createToolCallForwarder(...args),
      bindStartupSession: (...args) => this.sessionOwnership.bindStartupSession(...args),
    });
  }
  protected get otherHeldSessions(): Map<string, OtherHeldSession> {
    return this.runtime.otherHeldSessions;
  }
  protected get sessionDeviceIds(): Map<string, string> {
    return this.runtime.sessionDeviceIds;
  }
  protected get recoverableBoundSessionHandoff(): string | undefined {
    return this.runtime.recoverableBoundSessionHandoff;
  }
  protected set recoverableBoundSessionHandoff(value: string | undefined) {
    this.runtime.recoverableBoundSessionHandoff = value;
  }
  getProgressListenerCountForTesting(): number {
    return this.runtime.progressListeners.size;
  }
  getInternalsForTesting(): DaemonMcpProxyTestInternals {
    const runtime = this.runtime;
    return {
      resetConnection: () => this.connection.resetConnection(),
      handleSessionReleasedNotification: (...args) =>
        this.notifications.handleSessionReleasedNotification(...args),
      get sessionState() {
        return runtime.sessionState;
      },
      get pendingSessionLosses() {
        return runtime.pendingSessionLosses;
      },
      get brokerSessions() {
        return runtime.brokerSessions;
      },
      resourceSubscriptions: runtime.resourceSubscriptions,
      releaseLedger: runtime.releaseLedger,
      sessionOwnership: this.sessionOwnership,
      get proxyHeartbeatKeeper() {
        return runtime.proxyHeartbeatKeeper;
      },
      get latestBindingKeeper() {
        return runtime.latestBindingKeeper;
      },
      get livenessRecovery() {
        return runtime.livenessRecovery;
      },
      get stallHandovers() {
        return runtime.stallHandovers;
      },
      get livenessAcks() {
        return runtime.livenessAcks;
      },
      get sessionDeviceIds() {
        return runtime.sessionDeviceIds;
      },
      get ownedDeviceSessions() {
        return runtime.ownedDeviceSessions;
      },
      get boundSessionUuidAt() {
        return runtime.boundSessionUuidAt;
      },
      get boundSessionUuid() {
        return runtime.boundSessionUuid;
      },
      get notFoundStopped() {
        return runtime.notFoundStopped;
      },
      get otherHeldSessions() {
        return runtime.otherHeldSessions;
      },
      get errorClassifier() {
        return runtime.errorClassifier;
      },
      get structuredToolErrorCodes() {
        return runtime.structuredToolErrorCodes;
      },
      set structuredToolErrorCodes(value: boolean) {
        runtime.structuredToolErrorCodes = value;
      },
      get daemonShutdownBarrier() {
        return runtime.daemonShutdownBarrier;
      },
      runBoundSessionHeartbeatTick: (...args) =>
        this.liveness.runBoundSessionHeartbeatTick(...args),
      heartbeatHeldSession: (...args) => this.sessionOwnership.heartbeatHeldSession(...args),
      heartbeatWithStallDetection: (...args) =>
        this.sessionOwnership.heartbeatWithStallDetection(...args),
      createSessionBindingPort: (...args) => this.collaborators.createSessionBindingPort(...args),
      hasSessionCallInFlight: (...args) => this.toolRouting.hasSessionCallInFlight(...args),
      noteDaemonIdleEvidence: (...args) => this.toolRouting.noteDaemonIdleEvidence(...args),
      recordHeldSessionHeartbeatSuccess: (...args) =>
        this.sessionOwnership.recordHeldSessionHeartbeatSuccess(...args),
      frontendRegistersTool: (...args) => this.toolCalls.frontendRegistersTool(...args),
    };
  }

  /** Test-only seam for building a tool-unavailable error. */
  buildToolUnavailableErrorForTesting(
    name: string,
    daemonRejection?: string,
    daemonGated = false,
  ): Promise<Error> {
    return this.toolCalls.buildToolUnavailableErrorForTesting(name, daemonRejection, daemonGated);
  }

  /**
   * Ensure we have a connection to the daemon
   * Will auto-start daemon if configured and daemon is not running
   */
  ensureConnected(): Promise<void> {
    return this.connection.ensureConnected();
  }

  /** Bind a ready receipt to the keeper; see {@link BrokerSessions.hold}. */
  holdBrokerSession(requestId: string, sessionUuid: string): Promise<void> {
    return this.sessionOwnership.holdBrokerSession(requestId, sessionUuid);
  }

  /**
   * Prepare one durable broker request before serving MCP. See {@link BrokerSessions.acquire}.
   */
  acquireBrokerSession(config: SessionConfig): Promise<SessionBrokerResult> {
    return this.sessionOwnership.acquireBrokerSession(config);
  }

  getSessionBrokerResult(): SessionBrokerResult | undefined {
    return this.sessionOwnership.getSessionBrokerResult();
  }

  /** The terminally released binding, excluding a resumable daemon stall, for reporting surfaces (#11712). */
  getTerminalSessionRelease(): { sessionUuid: string; reason: string } | undefined {
    return this.sessionOwnership.getTerminalSessionRelease();
  }

  /**
   * Adopt the `--initial-session-uuid` session at proxy startup instead of on the first tool call.
   * Connection establishment sends the claiming heartbeat and starts the keeper, so a handoff
   * proxy that has only initialized already owns the session and keeps it alive if the previous
   * owner stops first. A no-op without an initial session binding.
   */
  claimInitialSession(): Promise<void> {
    return this.sessionOwnership.claimInitialSession();
  }

  /**
   * Register a listener for daemon-forwarded list-changed notifications
   * (issue #3223). The proxy invalidates the matching cache before firing, so
   * listeners re-fetching `listTools()`/`listResources()` always see fresh
   * definitions. Returns an unsubscribe function.
   */
  onListChanged(listener: (kind: ListChangedKind) => void): () => void {
    return this.discovery.onListChanged(listener);
  }

  /**
   * Register a listener told when a session this proxy holds was rebound onto another device
   * serial, so a harness can verify the move without an extra read.
   */
  onSessionDeviceRebound(listener: (event: SessionDeviceRebound) => void): () => void {
    return this.notifications.onSessionDeviceRebound(listener);
  }

  /**
   * Register a listener told when automatic liveness recovery was exhausted (#10053), so a harness
   * that is idle between tool calls still learns a session was lost. The same structured error is
   * returned on the next tool call for an affected session.
   */
  onLivenessHandover(listener: (handover: LivenessHandover) => void): () => void {
    return this.liveness.onLivenessHandover(listener);
  }

  onResourceUpdated(listener: (uri: string) => void): () => void {
    return this.discovery.onResourceUpdated(listener);
  }

  subscribeResource(uri: string): Promise<void> {
    return this.discovery.subscribeResource(uri);
  }

  unsubscribeResource(uri: string): Promise<void> {
    return this.discovery.unsubscribeResource(uri);
  }

  /**
   * Serve the tool surface for a client `tools/list` request.
   *
   * When no daemon connection exists yet, this returns the static tool surface
   * (`schemas/tool-definitions.json`) WITHOUT connecting or starting the daemon,
   * and defers the daemon connect/start to the first actual tool call (issue
   * #5879). A wedged or absent daemon therefore never hides the tool surface at
   * `tools/list` time; the client still gets one clear error on first use.
   *
   * Once a connection is established, this returns the daemon's live,
   * session-scoped list for this connection. The static superset is used only
   * for the cold bootstrap above and if the live list fails below. Connection-
   * profile updates and session binding can transiently narrow the live
   * `tools/list` response; the explicit tools `list_changed` notifications and
   * cache invalidation for those updates prompt clients to re-fetch under the
   * current scope, so a stale-superset merge is not needed for completeness.
   *
   * The static path deliberately does NOT call `throwIfBoundSessionUnavailable()`
   * (unlike {@link listTools}): re-coupling `tools/list` to daemon/session state
   * is exactly what issue #5879 removes. A fenced/expired bound session still
   * surfaces its ownership-lost error on the next actual tool call, which routes
   * through {@link callTool}'s gate.
   */
  listAdvertisedTools(): Promise<ProxiedToolDefinition[]> {
    return this.discovery.listAdvertisedTools();
  }

  /**
   * Serve a client `resources/list` request without connecting when no daemon
   * connection exists yet (issue #5879 review). AutoMobile resources are dynamic
   * and daemon-owned (device-session screenshots, per-app navigation graphs), so
   * there is no static cold surface — the cold roster is whatever a prior
   * connection cached, else empty. Deferring the connect keeps a host that
   * enumerates resources during initialization from blocking on a wedged daemon
   * before the first tool call. The first successful connect after a cold serve
   * emits a resources `list_changed` (see {@link doConnect}) so the client
   * re-fetches the real resources.
   */
  listAdvertisedResources(): Promise<ProxiedResourceDefinition[]> {
    return this.discovery.listAdvertisedResources();
  }

  /**
   * Serve a client `resources/templates/list` request without connecting when no
   * daemon connection exists yet. See {@link listAdvertisedResources}.
   */
  listAdvertisedResourceTemplates(): Promise<ProxiedResourceTemplate[]> {
    return this.discovery.listAdvertisedResourceTemplates();
  }

  /**
   * Get list of available tools from daemon
   */
  listTools(): Promise<ProxiedToolDefinition[]> {
    return this.discovery.listTools();
  }

  /**
   * Seed only with the persisted CLI tool-selection profile file's connection-profile UUID.
   * Never pass a device-session UUID: this value is forwarded on every later tool call.
   */
  setToolSelectionProfileUuid(profileUuid: string | undefined): void {
    return this.discovery.setToolSelectionProfileUuid(profileUuid);
  }

  /**
   * Call a tool on the daemon. `progressToken` echoes the external MCP
   * client's own `params._meta.progressToken` (issue #6205); when present it
   * is forwarded to the daemon so `notifications/progress` ticks relayed back
   * over the socket can be routed to `onProgress`, tagged with that SAME
   * token. Omit both to request no progress relay — nothing is fabricated.
   *
   * A call the daemon refuses because a session this proxy holds is suspect is forwarded once
   * more after the liveness recovery the refusal starts has settled, so the client gets that
   * call's result, or the handover/loss error recovery left behind, instead of the refusal.
   */
  callTool(
    name: string,
    args: Record<string, unknown>,
    progressToken?: string | number,
    {
      onProgress,
      ...options
    }: DaemonProxyToolCallOptions & { onProgress?: DaemonProxyProgressCallback } = {},
  ): Promise<any> {
    return this.toolCalls.callTool(name, args, progressToken, { onProgress, ...options });
  }

  /**
   * Relay `tasks/get`, `tasks/update` or `tasks/cancel` (#4668) to the daemon under this proxy's
   * task owner key. The daemon answers from its task store, so a task survives a daemon restart
   * (a restarted daemon reports one it was running as failed); a lost connection is reconnected
   * and the request asked once more. A task touches no session of this proxy, so neither a
   * liveness recovery nor a fenced binding holds the request back. The daemon's JSON-RPC error
   * rejects carrying it as `jsonRpcError`.
   */
  relayTaskMethod(
    method: TaskRelayMethod,
    params: Record<string, unknown>,
    declared: boolean,
    callerSignal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.toolCalls.relayTaskMethod(method, params, declared, callerSignal);
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
  adoptCliSessionLiveness(): Promise<string | undefined> {
    return this.sessionOwnership.adoptCliSessionLiveness();
  }

  /**
   * Get list of available resources from daemon
   */
  listResources(): Promise<ProxiedResourceDefinition[]> {
    return this.discovery.listResources();
  }

  /**
   * Get list of resource templates from daemon
   */
  listResourceTemplates(): Promise<ProxiedResourceTemplate[]> {
    return this.discovery.listResourceTemplates();
  }

  /**
   * Read a resource from the daemon
   */
  readResource(
    uri: string,
    options: { signal?: AbortSignal; _meta?: Record<string, unknown> } = {},
  ): Promise<any> {
    return this.discovery.readResource(uri, options);
  }

  /**
   * Invalidate cached definitions (call when daemon restarts)
   */
  invalidateCache(): void {
    return this.discovery.invalidateCache();
  }

  /**
   * Check if connected to daemon
   */
  isConnected(): boolean {
    return this.discovery.isConnected();
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
    return this.connection.setExecutionOwnerLossProbe(probe);
  }

  close(options?: DaemonMcpProxyCloseOptions): Promise<void> {
    this.notifications.clearSessionDeviceReboundListeners();
    return this.connection.close(options);
  }
  private createProxyToolCalls(): ProxyToolCalls {
    return new ProxyToolCalls(this.runtime, {
      untilClosed: (...args) => this.connection.untilClosed(...args),
      requireClient: (...args) => this.connection.requireClient(...args),
      boundSessionExpiredError: (...args) => this.toolRouting.boundSessionExpiredError(...args),
      heartbeatRequestTimeoutMs: (...args) => this.liveness.heartbeatRequestTimeoutMs(...args),
      withToolSelectionProfile: (...args) => this.toolRouting.withToolSelectionProfile(...args),
      trackToolCallInFlight: (...args) => this.liveness.trackToolCallInFlight(...args),
      sessionUuidFromArgs: (...args) => this.toolRouting.sessionUuidFromArgs(...args),
      shouldSkipLeaseRefreshForDeviceControlTransportError: (...args) =>
        this.connection.shouldSkipLeaseRefreshForDeviceControlTransportError(...args),
    });
  }
  private createProxyConnection(): ProxyConnection {
    return new ProxyConnection(this.runtime, {
      throwIfLivenessHandedOver: (...args) => this.liveness.throwIfLivenessHandedOver(...args),
      hasLivenessLifecycleFence: (...args) => this.liveness.hasLivenessLifecycleFence(...args),
      waitForLivenessRecovery: (...args) => this.liveness.waitForLivenessRecovery(...args),
      handleDaemonNotification: (...args) => this.notifications.handleDaemonNotification(...args),
      assertConnectedClient: (...args) => this.discovery.assertConnectedClient(...args),
      cancelBackgroundConnectRetry: (...args) =>
        this.discovery.cancelBackgroundConnectRetry(...args),
      replayResourceSubscriptions: (...args) => this.discovery.replayResourceSubscriptions(...args),
      applyListChangedSubscription: (...args) =>
        this.discovery.applyListChangedSubscription(...args),
      notifyListChanged: (...args) => this.discovery.notifyListChanged(...args),
      establishBoundSessionHeartbeat: (...args) =>
        this.sessionOwnership.establishBoundSessionHeartbeat(...args),
      resumeTokenOwnedSessions: (...args) =>
        this.sessionOwnership.resumeTokenOwnedSessions(...args),
      withToolSelectionProfile: (...args) => this.toolRouting.withToolSelectionProfile(...args),
      rememberToolSelectionProfile: (...args) =>
        this.toolRouting.rememberToolSelectionProfile(...args),
      invalidateCache: (...args) => this.invalidateCache(...args),
      connectResourceSubscriptionsInBackground: (...args) =>
        this.discovery.connectResourceSubscriptionsInBackground(...args),
      cancelConnectedFallbackReconcile: (...args) =>
        this.discovery.cancelConnectedFallbackReconcile(...args),
      clearBoundSessionUuid: (...args) => this.toolRouting.clearBoundSessionUuid(...args),
    });
  }
  private createProxySessionOwnership(): ProxySessionOwnership {
    return new ProxySessionOwnership(this.runtime, {
      ensureConnected: (...args) => this.ensureConnected(...args),
      rememberSessionDevice: (...args) => this.toolRouting.rememberSessionDevice(...args),
      noteDaemonIdleEvidence: (...args) => this.toolRouting.noteDaemonIdleEvidence(...args),
    });
  }
  private createProxyLiveness(): ProxyLiveness {
    return new ProxyLiveness(this.runtime, {
      resetConnection: (...args) => this.connection.resetConnection(...args),
      ensureConnected: (...args) => this.ensureConnected(...args),
      requireClient: (...args) => this.connection.requireClient(...args),
      boundSessionHeartbeatParams: (...args) =>
        this.sessionOwnership.boundSessionHeartbeatParams(...args),
      noteDaemonIdleEvidence: (...args) => this.toolRouting.noteDaemonIdleEvidence(...args),
      answersOwnershipReestablishment: (...args) =>
        this.sessionOwnership.answersOwnershipReestablishment(...args),
      recordBoundSessionHeartbeatSuccess: (...args) =>
        this.sessionOwnership.recordBoundSessionHeartbeatSuccess(...args),
      recordHeldSessionHeartbeatSuccess: (...args) =>
        this.sessionOwnership.recordHeldSessionHeartbeatSuccess(...args),
      fenceBoundSessionUuid: (...args) => this.toolRouting.fenceBoundSessionUuid(...args),
      dropHeldSession: (...args) => this.sessionOwnership.dropHeldSession(...args),
    });
  }
  private createProxyDiscovery(): ProxyDiscovery {
    return new ProxyDiscovery(this.runtime, {
      listTools: (...args) => this.listTools(...args),
      listResources: (...args) => this.listResources(...args),
      listResourceTemplates: (...args) => this.listResourceTemplates(...args),
      isBoundSessionReplayExpired: (...args) =>
        this.toolRouting.isBoundSessionReplayExpired(...args),
      hasLivenessLifecycleFence: (...args) => this.liveness.hasLivenessLifecycleFence(...args),
      withToolSelectionProfile: (...args) => this.toolRouting.withToolSelectionProfile(...args),
      reconciliationStatus: (...args) => this.connection.reconciliationStatus(...args),
      ensureConnected: (...args) => this.ensureConnected(...args),
      listDuringLivenessFence: (...args) => this.liveness.listDuringLivenessFence(...args),
      discoveryAfterResultMintRelease: (...args) =>
        this.toolRouting.discoveryAfterResultMintRelease(...args),
      untilClosed: (...args) => this.connection.untilClosed(...args),
      waitForLivenessRecovery: (...args) => this.liveness.waitForLivenessRecovery(...args),
      withBoundSessionUuid: (...args) => this.toolRouting.withBoundSessionUuid(...args),
      requireClient: (...args) => this.connection.requireClient(...args),
      sessionUuidFromArgs: (...args) => this.toolRouting.sessionUuidFromArgs(...args),
    });
  }
  private createProxyNotifications(): ProxyNotifications {
    return new ProxyNotifications(this.runtime, {
      handleResourceUpdated: (...args) => this.discovery.handleResourceUpdated(...args),
      invalidateDaemonList: (...args) => this.discovery.invalidateDaemonList(...args),
      announceDaemonListChanged: (...args) => this.discovery.announceDaemonListChanged(...args),
      invalidateCache: (...args) => this.invalidateCache(...args),
      clearNotFoundHistory: (...args) => this.sessionOwnership.clearNotFoundHistory(...args),
      recordHeldSessionTerminalLoss: (...args) =>
        this.toolRouting.recordHeldSessionTerminalLoss(...args),
      dropHeldSession: (...args) => this.sessionOwnership.dropHeldSession(...args),
      fenceBoundSessionUuid: (...args) => this.toolRouting.fenceBoundSessionUuid(...args),
    });
  }
  private createProxyCollaborators(): ProxyCollaborators {
    return new ProxyCollaborators(this.runtime, {
      resetConnection: (...args) => this.connection.resetConnection(...args),
      invalidateCache: (...args) => this.invalidateCache(...args),
      assertDaemonLifecycleUnfenced: (...args) =>
        this.connection.assertDaemonLifecycleUnfenced(...args),
      reconciliationStatus: (...args) => this.connection.reconciliationStatus(...args),
      isSameDaemonGeneration: (...args) => this.connection.isSameDaemonGeneration(...args),
      waitForJoinedRestartSuccessor: (...args) =>
        this.connection.waitForJoinedRestartSuccessor(...args),
      waitForRunningReconciliationStatus: (...args) =>
        this.connection.waitForRunningReconciliationStatus(...args),
      readSocketReconciliationStatus: (...args) =>
        this.connection.readSocketReconciliationStatus(...args),
      assertAutomaticRestartAllowed: (...args) =>
        this.connection.assertAutomaticRestartAllowed(...args),
      ensureVersionMatches: (...args) => this.connection.ensureVersionMatches(...args),
      verifyRestartedVersion: (...args) => this.connection.verifyRestartedVersion(...args),
      requiresVersionRestart: (...args) => this.connection.requiresVersionRestart(...args),
      assertNewerClientVersion: (...args) => this.connection.assertNewerClientVersion(...args),
      assertVersionRestartCooldownExpired: (...args) =>
        this.connection.assertVersionRestartCooldownExpired(...args),
      versionMismatchError: (...args) => this.connection.versionMismatchError(...args),
      ensureBuildMatches: (...args) => this.connection.ensureBuildMatches(...args),
      finishBuildRestart: (...args) => this.connection.finishBuildRestart(...args),
      buildMismatchError: (...args) => this.connection.buildMismatchError(...args),
      recordHeldSessionTerminalLoss: (...args) =>
        this.toolRouting.recordHeldSessionTerminalLoss(...args),
      dropHeldSession: (...args) => this.sessionOwnership.dropHeldSession(...args),
      ensureConnected: (...args) => this.ensureConnected(...args),
      throwIfBoundSessionFenced: (...args) => this.toolRouting.throwIfBoundSessionFenced(...args),
      boundSessionExpiredError: (...args) => this.toolRouting.boundSessionExpiredError(...args),
      fenceBoundSessionUuid: (...args) => this.toolRouting.fenceBoundSessionUuid(...args),
      hasRecoverableBoundSessionHandoff: (...args) =>
        this.notifications.hasRecoverableBoundSessionHandoff(...args),
      releaseKeepsBinding: (...args) => this.notifications.releaseKeepsBinding(...args),
      requireClient: (...args) => this.connection.requireClient(...args),
      boundSessionHeartbeatParams: (...args) =>
        this.sessionOwnership.boundSessionHeartbeatParams(...args),
      answersOwnershipReestablishment: (...args) =>
        this.sessionOwnership.answersOwnershipReestablishment(...args),
      noteHeartbeatDaemonInstance: (...args) =>
        this.toolRouting.noteHeartbeatDaemonInstance(...args),
      noteDaemonIdleEvidence: (...args) => this.toolRouting.noteDaemonIdleEvidence(...args),
      creditRoutedSession: (...args) => this.toolRouting.creditRoutedSession(...args),
      rememberToolSelectionProfile: (...args) =>
        this.toolRouting.rememberToolSelectionProfile(...args),
      rememberActiveDeviceSession: (...args) =>
        this.toolRouting.rememberActiveDeviceSession(...args),
      noteSuspectSessionResult: (...args) => this.toolCalls.noteSuspectSessionResult(...args),
      noteReleaseSurfacedBy: (...args) => this.toolRouting.noteReleaseSurfacedBy(...args),
      hasLivenessLifecycleFence: (...args) => this.liveness.hasLivenessLifecycleFence(...args),
      waitForLivenessRecovery: (...args) => this.liveness.waitForLivenessRecovery(...args),
      withFencedControlDeviceSession: (...args) =>
        this.toolRouting.withFencedControlDeviceSession(...args),
      ownSessionForPlatformSelector: (...args) =>
        this.toolRouting.ownSessionForPlatformSelector(...args),
      refuseAmbiguousSessionSelector: (...args) =>
        this.toolRouting.refuseAmbiguousSessionSelector(...args),
      reportToolSessionLoss: (...args) => this.liveness.reportToolSessionLoss(...args),
      prepareToolRoutingArgs: (...args) => this.toolRouting.prepareToolRoutingArgs(...args),
      sessionUuidFromArgs: (...args) => this.toolRouting.sessionUuidFromArgs(...args),
      withOneShotCliMarker: (...args) => this.toolCalls.withOneShotCliMarker(...args),
      withAcceptanceConfiguration: (...args) => this.toolCalls.withAcceptanceConfiguration(...args),
      withToolSelectionProfile: (...args) => this.toolRouting.withToolSelectionProfile(...args),
      beginSessionCall: (...args) => this.toolRouting.beginSessionCall(...args),
      sessionsUsedByCall: (...args) => this.toolRouting.sessionsUsedByCall(...args),
      endSessionCall: (...args) => this.toolRouting.endSessionCall(...args),
      throwIfForwardedSessionReleasedSince: (...args) =>
        this.toolRouting.throwIfForwardedSessionReleasedSince(...args),
      trackToolCallInFlight: (...args) => this.liveness.trackToolCallInFlight(...args),
      removeProgressListener: (...args) => this.notifications.removeProgressListener(...args),
      toolUnavailableError: (...args) => this.toolCalls.toolUnavailableError(...args),
      withBoundSessionUuid: (...args) => this.toolRouting.withBoundSessionUuid(...args),
      notifyListChanged: (...args) => this.discovery.notifyListChanged(...args),
      sendStalledSessionResumeHeartbeat: (...args) =>
        this.liveness.sendStalledSessionResumeHeartbeat(...args),
      currentHandover: (...args) => this.liveness.currentHandover(...args),
      reportPendingSessionLoss: (...args) => this.liveness.reportPendingSessionLoss(...args),
      notifyLivenessHandoverListeners: (...args) =>
        this.liveness.notifyLivenessHandoverListeners(...args),
      forgetSessionLivenessState: (...args) =>
        this.sessionOwnership.forgetSessionLivenessState(...args),
      heartbeatWithStallDetection: (...args) =>
        this.sessionOwnership.heartbeatWithStallDetection(...args),
      isBoundSessionReplayExpired: (...args) =>
        this.toolRouting.isBoundSessionReplayExpired(...args),
      retireIdleBinding: (...args) => this.toolRouting.retireIdleBinding(...args),
      heartbeatRequestTimeoutMs: (...args) => this.liveness.heartbeatRequestTimeoutMs(...args),
      isSessionlessControlDeviceTool: (...args) =>
        this.toolRouting.isSessionlessControlDeviceTool(...args),
      toolTargetsDevice: (...args) => this.toolRouting.toolTargetsDevice(...args),
      isDeviceReadOnlyTool: (...args) => this.toolRouting.isDeviceReadOnlyTool(...args),
      hasSessionCallInFlight: (...args) => this.toolRouting.hasSessionCallInFlight(...args),
      clearBoundSessionUuid: (...args) => this.toolRouting.clearBoundSessionUuid(...args),
      withOwnedSessionCapabilities: (...args) =>
        this.toolRouting.withOwnedSessionCapabilities(...args),
      namesOwnedSession: (...args) => this.toolRouting.namesOwnedSession(...args),
      bindStartupSession: (...args) => this.sessionOwnership.bindStartupSession(...args),
      establishBoundSessionHeartbeat: (...args) =>
        this.sessionOwnership.establishBoundSessionHeartbeat(...args),
      forwardedSessionReleaseReasonSince: (...args) =>
        this.toolRouting.forwardedSessionReleaseReasonSince(...args),
      fenceReleasedForwardedSession: (...args) =>
        this.toolRouting.fenceReleasedForwardedSession(...args),
      throwIfSessionReleasedSince: (...args) =>
        this.toolRouting.throwIfSessionReleasedSince(...args),
      invalidateListCache: (...args) => this.discovery.invalidateListCache(...args),
      holdPreviousBinding: (...args) => this.sessionOwnership.holdPreviousBinding(...args),
      failureNeverReachedLiveSession: (...args) =>
        this.toolCalls.failureNeverReachedLiveSession(...args),
      toolAcceptsSessionUuid: (...args) => this.toolRouting.toolAcceptsSessionUuid(...args),
      daemonKeepsSessionInUse: (...args) => this.toolRouting.daemonKeepsSessionInUse(...args),
      idleSessionReleaseReason: (...args) => this.toolRouting.idleSessionReleaseReason(...args),
      recordHeldSessionHeartbeatSuccess: (...args) =>
        this.sessionOwnership.recordHeldSessionHeartbeatSuccess(...args),
      handleHeldSessionHeartbeatError: (...args) =>
        this.sessionOwnership.handleHeldSessionHeartbeatError(...args),
    });
  }
  private createProxyToolRouting(): ProxyToolRouting {
    return new ProxyToolRouting(this.runtime, {
      notifyListChanged: (...args) => this.discovery.notifyListChanged(...args),
      noteSessionRestoredByCall: (...args) =>
        this.sessionOwnership.noteSessionRestoredByCall(...args),
      clearNotFoundHistory: (...args) => this.sessionOwnership.clearNotFoundHistory(...args),
    });
  }
}

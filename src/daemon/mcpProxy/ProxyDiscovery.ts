import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { DaemonUnavailableError, type DaemonClientLike } from "../client";
import { DAEMON_BOUND_SESSION_PARAM, DAEMON_RELEASED_SESSION_PARAM } from "../wire/constants";
import { DeviceControlTransportError } from "../deviceControlTransportFailure";
import { type ListChangedKind } from "../listChangedBroadcast";
import { McpOverloadError } from "../wire/McpTimeoutError";
import { isToolOutputResourceUri } from "../proxy/BoundSessionFenceGate";
import {
  DaemonBoundSessionExpiredError,
  DaemonConnectionSessionReleasedError,
} from "../proxy/daemonErrors";
import { DaemonPreflightConnectionError } from "../proxy/DaemonPreflightConnectionError";
import { type DaemonNotification, type DaemonOptions, type DaemonStatus } from "../types";
import {
  COLD_RESOURCE_CONNECT_RETRY_DELAYS_MS,
  isFreshSessionScreenshotUri,
  ProxiedResourceDefinition,
  ProxiedResourceTemplate,
  ProxiedToolDefinition,
} from "./ProxyContracts";
import type { ProxyRuntime } from "./ProxyRuntime";
/** Operations supplied by the proxy's composition root. */
export interface ProxyDiscoveryPort {
  isBoundSessionReplayExpired(): boolean;
  hasLivenessLifecycleFence(): boolean;
  withToolSelectionProfile(args: Record<string, unknown>): Record<string, unknown>;
  reconciliationStatus(): Promise<DaemonStatus>;
  ensureConnected(): Promise<void>;
  listDuringLivenessFence<T>(request: () => Promise<T>, coldList: () => T): Promise<T>;
  discoveryAfterResultMintRelease(): boolean;
  untilClosed(signal: AbortSignal | undefined): AbortSignal;
  waitForLivenessRecovery(signal?: AbortSignal): Promise<void>;
  withBoundSessionUuid(
    args: Record<string, unknown>,
    usesDeviceSelector?: boolean,
    toolName?: string,
  ): Record<string, unknown>;
  requireClient(): DaemonClientLike;
  sessionUuidFromArgs(args: Record<string, unknown>): string | undefined;
  listTools(): Promise<ProxiedToolDefinition[]>;
  listResources(): Promise<ProxiedResourceDefinition[]>;
  listResourceTemplates(): Promise<ProxiedResourceTemplate[]>;
}

type Runtime = Pick<
  ProxyRuntime,
  | "backgroundConnectRetry"
  | "backgroundConnectRetryAttempt"
  | "boundSessionFenceGate"
  | "boundSessionUuid"
  | "client"
  | "closing"
  | "connected"
  | "connectedFallbackReconcile"
  | "connectedFallbackReconcileAttempt"
  | "connectedStaticToolDefinitionsProvider"
  | "connecting"
  | "connectionRecovery"
  | "discovery"
  | "listChangedListeners"
  | "listPoller"
  | "reconciliationSnapshot"
  | "resourceSubscriptionManager"
  | "resourceSubscriptions"
  | "servedStaticResourceList"
  | "servedStaticToolList"
  | "staticToolDefinitionsProvider"
  | "terminalBoundSession"
  | "timer"
  | "toolSelectionProfileUuid"
>;

/** Discovery operations on a single proxy runtime. */
export class ProxyDiscovery {
  constructor(
    private readonly runtime: Runtime,
    private readonly port: ProxyDiscoveryPort,
  ) {}

  // Drop the cached definitions for one list kind. Bumping the discovery epoch
  // makes a discovery request whose response is still in flight decline to
  // repopulate the cache this invalidation just cleared (issue #4655).
  invalidateListCache(kind: ListChangedKind): void {
    this.runtime.discovery.invalidateKind(kind);
  }

  // Invalidate the matching cache and re-emit a list_changed to listeners,
  // mirroring the daemon-pushed invalidation path (see handleDaemonNotification)
  // so a re-fetch is never stale.
  notifyListChanged(kind: ListChangedKind): void {
    this.invalidateListCache(kind);
    this.runtime.listPoller.noteEmitted(kind);
    this.fireListChangedListeners(kind);
  }

  fireListChangedListeners(kind: ListChangedKind): void {
    for (const listener of this.runtime.listChangedListeners) {
      try {
        listener(kind);
      } catch (error) {
        // Best-effort re-emit: a dead/mid-teardown client transport must not
        // break cache invalidation or sibling listeners.
        logger.warn(`[DaemonMcpProxy] list_changed listener failed for ${kind}: ${error}`);
      }
    }
  }

  invalidateDaemonList(kind: ListChangedKind): void {
    this.invalidateListCache(kind);
    if (kind === "tools") {
      this.runtime.reconciliationSnapshot = undefined;
    }
  }

  // A daemon list change, pushed or found by the polling fallback.
  announceDaemonListChanged(kind: ListChangedKind): void {
    this.invalidateDaemonList(kind);
    this.fireListChangedListeners(kind);
  }

  // Poll the daemon lists when it did not acknowledge the push subscription
  // (#4678). A custom transport without notification support (undefined) keeps
  // its previous behaviour. Not awaited: a comparison must not delay connect.
  applyListChangedSubscription(subscribed: boolean | undefined): void {
    if (subscribed === undefined) {
      return;
    }
    void (subscribed
      ? this.runtime.listPoller.onSubscriptionAcknowledged()
      : this.runtime.listPoller.onSubscriptionUnavailable());
  }

  // Discovery's session scope for a poll, or undefined when the poll must skip.
  // Discovery decides how a released or idle binding lists; the poll must not
  // retire, refresh or replay a binding, so it skips rather than decide that.
  listPollParams(): Record<string, unknown> | undefined {
    if (this.runtime.terminalBoundSession || this.port.isBoundSessionReplayExpired()) {
      return undefined;
    }
    const bound = this.runtime.boundSessionUuid;
    return bound ? { sessionUuid: bound, [DAEMON_BOUND_SESSION_PARAM]: bound } : {};
  }

  // Read a daemon list for the polling fallback with discovery's session scope.
  // It only uses the live connection: it never reconnects or starts the daemon.
  async pollDaemonList(kind: ListChangedKind): Promise<unknown> {
    const client = this.runtime.client;
    const params = this.listPollParams();
    if (
      !this.runtime.connected ||
      !client ||
      this.runtime.closing ||
      this.port.hasLivenessLifecycleFence() ||
      !params
    ) {
      return undefined;
    }
    if (kind === "tools") {
      const result = await client.callDaemonMethod(
        "tools/list",
        this.port.withToolSelectionProfile(params),
      );
      return result?.tools ?? [];
    }
    const result = await client.callDaemonMethod("resources/list", params);
    return result?.resources ?? [];
  }

  /**
   * Register a listener for daemon-forwarded list-changed notifications
   * (issue #3223). The proxy invalidates the matching cache before firing, so
   * listeners re-fetching `listTools()`/`listResources()` always see fresh
   * definitions. Returns an unsubscribe function.
   */
  onListChanged(listener: (kind: ListChangedKind) => void): () => void {
    this.runtime.listChangedListeners.add(listener);
    return () => {
      this.runtime.listChangedListeners.delete(listener);
    };
  }

  onResourceUpdated(listener: (uri: string) => void): () => void {
    return this.runtime.resourceSubscriptionManager.onResourceUpdated(listener);
  }

  subscribeResource(uri: string): Promise<void> {
    return this.runtime.resourceSubscriptionManager.subscribeResource(uri);
  }

  unsubscribeResource(uri: string): Promise<void> {
    return this.runtime.resourceSubscriptionManager.unsubscribeResource(uri);
  }

  assertConnectedClient(client: DaemonClientLike): void {
    if (this.runtime.client !== client) {
      throw new DaemonPreflightConnectionError(
        new DaemonUnavailableError("Daemon socket closed during connection establishment"),
      );
    }
  }

  replayResourceSubscriptions(client: DaemonClientLike): Promise<void> {
    return this.runtime.resourceSubscriptionManager.replayResourceSubscriptions(client);
  }

  syncResourceSubscription(uri: string): Promise<void> {
    return this.runtime.resourceSubscriptionManager.syncResourceSubscription(uri);
  }

  handleResourceUpdated(notification: DaemonNotification, sourceClient: DaemonClientLike): void {
    return this.runtime.resourceSubscriptionManager.handleResourceUpdated(
      notification,
      sourceClient,
    );
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
  async listAdvertisedTools(): Promise<ProxiedToolDefinition[]> {
    if (this.port.hasLivenessLifecycleFence()) {
      return this.runtime.discovery.tools ?? this.runtime.staticToolDefinitionsProvider();
    }
    if (!this.runtime.connected || !this.runtime.client) {
      this.runtime.servedStaticToolList = true;
      return this.runtime.staticToolDefinitionsProvider();
    }
    // The live per-connection list is the post-connect contract (#5879); the
    // static fallback is only built when the live call fails, so its cost — a
    // reconciliationStatus() + connectedFallbackDaemonOptions() ide/status RPC —
    // stays off the success path (and can't fail a list whose live call would
    // have succeeded, e.g. daemonManager.status() throwing during a restart).
    try {
      const tools = await this.port.listTools();
      this.runtime.connectedFallbackReconcileAttempt = 0;
      return tools;
    } catch (error) {
      if (
        error instanceof DaemonBoundSessionExpiredError ||
        error instanceof DaemonConnectionSessionReleasedError ||
        error instanceof DeviceControlTransportError ||
        error instanceof McpOverloadError
      ) {
        throw error;
      }
      logger.warn(
        `[DaemonMcpProxy] Live tools/list failed; serving connected static fallback: ${errorMessage(error)}`,
        error,
      );
      this.scheduleConnectedFallbackReconcile();
      const daemonStatus = await this.port.reconciliationStatus();
      const fallbackOptions = await this.connectedFallbackDaemonOptions(daemonStatus);
      return this.runtime.connectedStaticToolDefinitionsProvider(fallbackOptions);
    }
  }

  async connectedFallbackDaemonOptions(daemonStatus: DaemonStatus): Promise<DaemonOptions> {
    return {
      ...daemonStatus.options,
      debug: daemonStatus.effectiveDebug ?? daemonStatus.options?.debug,
    };
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
  async listAdvertisedResources(): Promise<ProxiedResourceDefinition[]> {
    if (this.port.hasLivenessLifecycleFence()) {
      return this.runtime.discovery.resources ?? [];
    }
    if (this.runtime.connected && this.runtime.client) {
      return this.port.listResources();
    }
    this.serveResourcesColdAndConnectInBackground();
    return this.runtime.discovery.resources ?? [];
  }

  /**
   * Serve a client `resources/templates/list` request without connecting when no
   * daemon connection exists yet. See {@link listAdvertisedResources}.
   */
  async listAdvertisedResourceTemplates(): Promise<ProxiedResourceTemplate[]> {
    if (this.port.hasLivenessLifecycleFence()) {
      return this.runtime.discovery.resourceTemplates ?? [];
    }
    if (this.runtime.connected && this.runtime.client) {
      return this.port.listResourceTemplates();
    }
    this.serveResourcesColdAndConnectInBackground();
    return this.runtime.discovery.resourceTemplates ?? [];
  }

  // Resource discovery has no "first use that connects" equivalent — a
  // resource-only client may list resources and never call a tool, so nothing
  // would ever establish the connection that populates its daemon-owned
  // resources (e.g. `automobile:devices/booted`). Kick off a NON-BLOCKING
  // background connect so the daemon connects and the reconciliation
  // `resources/list_changed` fires, WITHOUT blocking this cold discovery
  // response (issue #5879 review). The `connecting` guard in ensureConnected()
  // dedupes concurrent/polled calls, so at most one attempt is in flight.
  serveResourcesColdAndConnectInBackground(): void {
    this.runtime.servedStaticResourceList = true;
    this.connectResourcesInBackground();
  }

  connectResourceSubscriptionsInBackground(): void {
    if (this.runtime.resourceSubscriptions.size > 0 && !this.runtime.connected) {
      this.connectResourcesInBackground();
    }
  }

  connectResourcesInBackground(): void {
    if (this.runtime.connecting || this.runtime.backgroundConnectRetry || this.runtime.closing) {
      return;
    }
    void this.ensureBackgroundResourceConnection();
  }

  async ensureBackgroundResourceConnection(): Promise<void> {
    if (!this.runtime.servedStaticResourceList && this.runtime.resourceSubscriptions.size === 0) {
      return;
    }
    try {
      await this.port.ensureConnected();
    } catch (error) {
      // Best-effort: the cold roster already returned, and the tool surface is
      // visible via tools/list. A wedged/absent daemon must not surface here; the
      // the next actual request still reports the failure to the client. Retry
      // transient failures a bounded number of times for resource-only clients.
      logger.warn("[DaemonMcpProxy] background resource connect failed", error);
      this.scheduleBackgroundConnectRetry();
    }
  }

  scheduleBackgroundConnectRetry(): void {
    if (this.runtime.closing || this.runtime.connected || this.runtime.backgroundConnectRetry) {
      return;
    }
    const delay = COLD_RESOURCE_CONNECT_RETRY_DELAYS_MS[this.runtime.backgroundConnectRetryAttempt];
    if (delay === undefined) {
      return;
    }
    this.runtime.backgroundConnectRetryAttempt += 1;
    this.runtime.backgroundConnectRetry = this.runtime.timer.setTimeout(() => {
      this.runtime.backgroundConnectRetry = null;
      void this.ensureBackgroundResourceConnection();
    }, delay);
  }

  cancelBackgroundConnectRetry(): void {
    if (this.runtime.backgroundConnectRetry) {
      this.runtime.timer.clearTimeout(this.runtime.backgroundConnectRetry);
      this.runtime.backgroundConnectRetry = null;
    }
    this.runtime.backgroundConnectRetryAttempt = 0;
  }

  scheduleConnectedFallbackReconcile(replacingAttempt = false): void {
    const delay =
      COLD_RESOURCE_CONNECT_RETRY_DELAYS_MS[this.runtime.connectedFallbackReconcileAttempt];
    if (this.runtime.closing || !this.runtime.connected || delay === undefined) {
      if (replacingAttempt) {
        this.runtime.connectedFallbackReconcile = null;
        if (!this.runtime.closing && !this.runtime.connected) {
          this.runtime.servedStaticToolList = true;
        }
      }
      return;
    }
    if (this.runtime.connectedFallbackReconcile && !replacingAttempt) {
      return;
    }
    this.runtime.connectedFallbackReconcileAttempt += 1;
    this.runtime.connectedFallbackReconcile = this.runtime.timer.setTimeout(() => {
      void this.attemptConnectedFallbackReconcile();
    }, delay);
  }

  async attemptConnectedFallbackReconcile(): Promise<void> {
    if (this.runtime.closing || !this.runtime.connected) {
      this.runtime.connectedFallbackReconcile = null;
      if (!this.runtime.closing) {
        this.runtime.servedStaticToolList = true;
      }
      return;
    }
    this.invalidateListCache("tools");
    try {
      await this.port.listTools();
      this.runtime.connectedFallbackReconcileAttempt = 0;
      this.runtime.connectedFallbackReconcile = null;
      this.notifyListChanged("tools");
    } catch (error) {
      // Best-effort: callable static schemas were already returned, and the
      // bounded retry can safely wait for the daemon's live list to recover.
      logger.debug(
        `[DaemonMcpProxy] connected static fallback reconciliation failed: ${errorMessage(error)}`,
      );
      this.scheduleConnectedFallbackReconcile(true);
    }
  }

  cancelConnectedFallbackReconcile(): void {
    if (this.runtime.connectedFallbackReconcile) {
      this.runtime.timer.clearTimeout(this.runtime.connectedFallbackReconcile);
      this.runtime.connectedFallbackReconcile = null;
    }
    this.runtime.connectedFallbackReconcileAttempt = 0;
  }

  /**
   * Get list of available tools from daemon
   */
  async listTools(): Promise<ProxiedToolDefinition[]> {
    if (this.port.hasLivenessLifecycleFence()) {
      return this.port.listDuringLivenessFence(
        () => this.runtime.discovery.fetchTools(true),
        () => this.runtime.discovery.tools ?? this.runtime.staticToolDefinitionsProvider(),
      );
    }
    return this.runtime.discovery.fetchTools(this.port.discoveryAfterResultMintRelease());
  }

  /**
   * Seed only with the persisted CLI tool-selection profile file's connection-profile UUID.
   * Never pass a device-session UUID: this value is forwarded on every later tool call.
   */
  setToolSelectionProfileUuid(profileUuid: string | undefined): void {
    this.runtime.toolSelectionProfileUuid = profileUuid;
  }

  /**
   * Get list of available resources from daemon
   */
  async listResources(): Promise<ProxiedResourceDefinition[]> {
    if (this.port.hasLivenessLifecycleFence()) {
      return this.port.listDuringLivenessFence(
        () => this.runtime.discovery.fetchResources(true),
        () => this.runtime.discovery.resources ?? [],
      );
    }
    return this.runtime.discovery.fetchResources(this.port.discoveryAfterResultMintRelease());
  }

  /**
   * Get list of resource templates from daemon
   */
  async listResourceTemplates(): Promise<ProxiedResourceTemplate[]> {
    if (this.port.hasLivenessLifecycleFence()) {
      return this.port.listDuringLivenessFence(
        () => this.runtime.discovery.fetchResourceTemplates(true),
        () => this.runtime.discovery.resourceTemplates ?? [],
      );
    }
    return this.runtime.discovery.fetchResourceTemplates(
      this.port.discoveryAfterResultMintRelease(),
    );
  }

  freshScreenshotOwnerForwardParams(uri: string): Record<string, unknown> | undefined {
    return this.runtime.boundSessionFenceGate.freshScreenshotOwnerForwardParams(uri);
  }

  throwIfResourceSessionHandedOver(uri: string): void {
    return this.runtime.boundSessionFenceGate.throwIfResourceSessionHandedOver(uri);
  }

  isSessionlessResourceRead(uri: string): boolean {
    return this.runtime.boundSessionFenceGate.isSessionlessResourceRead(uri);
  }

  /**
   * Read a resource from the daemon
   */
  async readResource(
    uri: string,
    { signal: callerSignal }: { signal?: AbortSignal } = {},
  ): Promise<any> {
    const signal = this.port.untilClosed(callerSignal);
    signal.throwIfAborted();
    await this.port.waitForLivenessRecovery(signal);
    this.throwIfResourceSessionHandedOver(uri);
    signal?.throwIfAborted();
    const terminalSessionUuid = this.runtime.terminalBoundSession?.sessionUuid;
    // A tool-output artifact read is session-independent, so it survives a
    // terminal release without any session params at all (issue #5917). The
    // fresh-screenshot exemption, by contrast, must still target the released
    // session it belongs to.
    const isToolOutput = isToolOutputResourceUri(uri);
    const isReleasedSessionScreenshot =
      terminalSessionUuid !== undefined && isFreshSessionScreenshotUri(uri, terminalSessionUuid);
    const ownerForwardedParams = isToolOutput
      ? undefined
      : this.freshScreenshotOwnerForwardParams(uri);
    const isSessionless = this.isSessionlessResourceRead(uri);
    const allowReleasedSession =
      isSessionless || isReleasedSessionScreenshot || ownerForwardedParams !== undefined;
    const forwardedParams = isSessionless
      ? {}
      : isReleasedSessionScreenshot
        ? {
            sessionUuid: terminalSessionUuid,
            [DAEMON_BOUND_SESSION_PARAM]: terminalSessionUuid,
            [DAEMON_RELEASED_SESSION_PARAM]: terminalSessionUuid,
          }
        : (ownerForwardedParams ?? this.port.withBoundSessionUuid({}));
    const forwarding = this.runtime.connectionRecovery.withRecoverableReconnect(
      () => this.port.requireClient().readResource(uri, forwardedParams, { signal }),
      this.port.sessionUuidFromArgs(forwardedParams),
      allowReleasedSession,
      true,
      undefined,
      signal,
    );
    // Recovery is shared with siblings; abandon this wait without cancelling it.
    return await raceWithDeadline(forwarding, {
      timer: this.runtime.timer,
      signal,
      label: `Daemon resource ${uri}`,
    });
  }

  /**
   * Invalidate cached definitions (call when daemon restarts)
   */
  invalidateCache(): void {
    this.runtime.discovery.invalidateAll();
  }

  /**
   * Check if connected to daemon
   */
  isConnected(): boolean {
    return this.runtime.connected;
  }
}

import { assertAndroidCtrlProxyDevice } from "./androidCtrlProxyDeviceGuard";
import { AndroidCtrlProxyClientDeps } from "./AndroidCtrlProxyClientDeps";
import { defaultAndroidServiceManagerFactory } from "./AndroidCtrlProxyServices";
export { type AndroidCtrlProxyClientDeps } from "./AndroidCtrlProxyClientDeps";
export type {
  AndroidDisplayTransition,
  InteractionEvent,
  StorageTelemetryInput,
  WebSocketMessage,
} from "./androidCtrlProxyInboundProtocol";
export {
  displayTransitionFromWire,
  normalizeStorageWireValue,
  parseCtrlProxyJson,
  storageTelemetryInputFromWire,
} from "./androidCtrlProxyInboundWire";

import { resetForeignCtrlProxyForwardEvidenceForTesting } from "./foreignCtrlProxyForwardEvidence";

export type { AndroidCtrlProxy, AndroidCtrlProxyClientSurface } from "./AndroidCtrlProxy";
export { CTRL_PROXY_CONNECT_ATTEMPTS } from "./AndroidCtrlProxyPortForwarder";

/**
 * AndroidCtrlProxyClient - Main client for Android accessibility service.
 *
 * This client provides a unified interface to the Android accessibility service
 * via WebSocket connection. It uses composition with delegate modules to handle
 * specific functionality:
 *
 * - CtrlProxyGestures: Swipe, tap, drag, pinch operations
 * - CtrlProxyText: setText, clearText, IME actions, select all
 * - CtrlProxyHierarchy: Hierarchy retrieval, caching, conversion
 * - CtrlProxyStorage: SharedPreferences operations
 * - CtrlProxyCertificates: CA cert install/remove, permissions
 * - CtrlProxyFocus: TalkBack focus, traversal order
 * - CtrlProxyHighlights: Visual highlight overlays
 */

/**
 * AndroidCtrlProxyClient - Main client for Android accessibility service.
 *
 * This client provides a unified interface to the Android accessibility service
 * via WebSocket connection. It uses composition with delegate modules to handle
 * specific functionality:
 *
 * - CtrlProxyGestures: Swipe, tap, drag, pinch operations
 * - CtrlProxyText: setText, clearText, IME actions, select all
 * - CtrlProxyHierarchy: Hierarchy retrieval, caching, conversion
 * - CtrlProxyStorage: SharedPreferences operations
 * - CtrlProxyCertificates: CA cert install/remove, permissions
 * - CtrlProxyFocus: TalkBack focus, traversal order
 * - CtrlProxyHighlights: Visual highlight overlays
 */
import WebSocket from "ws";
import {
  AdbClientFactory,
  defaultAdbClientFactory,
} from "../../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { logger } from "../../../utils/logger";

import {
  MapDeviceClientRegistry,
  type DeviceClientRegistry,
} from "../../../ctrlProxy/deviceClientRegistry";
import { getDeviceDataStreamServer } from "../../../daemon/deviceDataStreamSocketServer";
import { requireBootedDevice } from "../../../devices/requireBootedDevice";
import { ActionableError, BootedDevice, toActionableError } from "../../../models";
import { NoOpPerformanceTracker, PerformanceTracker } from "../../../utils/PerformanceTracker";
import { PortManager } from "../../../utils/PortManager";
import { Timer, defaultTimer } from "../../../utils/SystemTimer";
import { errorMessage } from "../../../utils/describeUnknownError";
import { daemonDeviceAdmissionGate } from "../../../utils/deviceAdmissionGate";
import {
  deviceIncarnationToken,
  registerDeviceIncarnationListener,
} from "../../../utils/deviceIncarnation";
import {
  NETWORK_MOCK_REPORT_TIMEOUT_MS,
  type NetworkMockPushResult,
  type NetworkMockRuleSync,
} from "../../../utils/networkMockRules";
import { raceWithDeadline } from "../../../utils/raceWithDeadline";
import { shellQuote } from "../../../utils/shellQuote";
import type { StorageSubscription } from "../../storage/storageTypes";
import { WebSocketFactory } from "../DeviceServiceClient";
import { ObserverPendingRequestTimeoutError } from "../ObserverPendingRequestTimeoutError";
import { ScreenshotBackoffScheduler } from "../ScreenshotBackoffScheduler";
import { OBSERVE_RECOVERY_WAIT_MS } from "./AndroidServiceRecovery";
import {
  forwardLeaseActivity,
  heldForwardLeaseDeviceIds,
  releaseForwardLeasesForShutdown,
  releaseIdleForwardLease,
  type ForwardLeaseActivity,
  type ForwardLeaseClient,
  type ForwardLeaseClientRegistry,
} from "./CtrlProxyForwardLeaseRegistry";
import { NoForwardClientConnectionProbe } from "./NoForwardClientConnectionProbe";
import { NoOpCtrlProxyForwardLease } from "./NoOpCtrlProxyForwardLease";
import { ctrlProxyRequests, serializeCtrlProxyRequest } from "./ctrlProxyProtocol";
import { pushNetworkMockRules } from "./networkMockRulesPush";

// Import delegates

// Import types
// Import delegates
// Import types
import type { AndroidCtrlProxy } from "./AndroidCtrlProxy";
import { AndroidCtrlProxyTestHooksFacade } from "./AndroidCtrlProxyTestHooksFacade";
import type {
  AccessibilityHierarchy,
  AndroidPerfTiming,
  ObserverHierarchyRequestOptions,
} from "./types";

export type {
  AndroidServiceManagerFactory,
  AndroidServiceRecoveryManager,
} from "./AndroidServiceRecovery";

/**
 * Client for interacting with the AutoMobile Accessibility Service via WebSocket.
 * Uses singleton pattern per device to maintain persistent WebSocket connection.
 */
/** Completes the FUNNEL 2 refusal: "Refusing `<purpose>` on device '<serial>'". */
const CTRL_PROXY_CLIENT_PURPOSE = "to drive the device through CtrlProxy";

export class AndroidCtrlProxyClient
  extends AndroidCtrlProxyTestHooksFacade
  implements AndroidCtrlProxy
{
  protected getLiveLocalPorts(): ReadonlySet<number> {
    return new Set(
      [
        ...AndroidCtrlProxyClient.registry.entries().map(([, client]) => client),
        ...AndroidCtrlProxyClient.activeObservers,
      ]
        .filter((other) => other.device.deviceId === this.device.deviceId && !other.closed)
        .map((other) => other.localPort),
    );
  }

  protected override get clientLogTag(): string {
    return "AndroidCtrlProxyClient";
  }

  // Singleton instances per device
  public static readonly registry: DeviceClientRegistry<AndroidCtrlProxyClient> =
    new MapDeviceClientRegistry<AndroidCtrlProxyClient>();
  private static readonly activeObservers = new Set<AndroidCtrlProxyClient>();

  private incarnationToken: string | undefined;
  // Match the bounded ADB forward-removal confirmation window during teardown.
  private static readonly INBOUND_HANDLER_DRAIN_TIMEOUT_MS = 2000;
  /** A socket must survive this interval before it can rearm a restart. */
  private static readonly RESTART_REARM_STABILITY_MS = 2000;
  public static readonly OBSERVE_RECOVERY_WAIT_MS = OBSERVE_RECOVERY_WAIT_MS;
  // Track whether the device supports accessibility service screenshots (API 30+).
  // null = unknown, true = supported, false = unsupported (fall back to ADB screencap).
  // Only marked unsupported after consecutive failures to avoid disabling on transient timeouts.
  /** @internal Test seam for CtrlProxyClient tests (#7992); not part of the public API. */
  get a11yScreenshotSupported(): boolean | null {
    return this.getScreenshotCapture().a11yScreenshotSupported;
  }
  set a11yScreenshotSupported(value: boolean | null) {
    this.getScreenshotCapture().a11yScreenshotSupported = value;
  }
  private constructor(
    device: BootedDevice,
    adb: AdbExecutor,
    deps: AndroidCtrlProxyClientDeps = {},
  ) {
    super(device, adb, deps);
    this.incarnationToken = AndroidCtrlProxyClient.currentIncarnationToken(device.deviceId);
    AndroidCtrlProxyClient.trackObserver(this);
  }

  private static trackObserver(client: AndroidCtrlProxyClient): void {
    if (client.transientObserver) {
      AndroidCtrlProxyClient.activeObservers.add(client);
    }
  }

  /**
   * Get singleton instance for a device
   */
  /**
   * FUNNEL 2, alongside `AdbClientFactory`: this is the OTHER Android
   * device-client resolution, and it MEMOIZES, so a client built before the
   * quarantine would otherwise be handed straight back and keep driving whichever
   * runtime now answers on the serial without the factory seam ever being crossed
   * again ([#6888](https://github.com/kaeawc/auto-mobile/pull/6888) review).
   */
  public static getInstance(
    device: BootedDevice,
    adbFactory: AdbClientFactory = defaultAdbClientFactory,
  ): AndroidCtrlProxy {
    requireBootedDevice(device, "AndroidCtrlProxyClient.getInstance");
    assertAndroidCtrlProxyDevice(device);
    daemonDeviceAdmissionGate.assertDeviceActionable(device.deviceId, CTRL_PROXY_CLIENT_PURPOSE);
    const deviceId = device.deviceId;
    const registry = AndroidCtrlProxyClient.registry;
    if (registry.isRetired(deviceId)) {
      return registry.get(deviceId, () => {
        const retired = new AndroidCtrlProxyClient(device, adbFactory.create(device));
        retired.closed = true;
        retired.autoReconnectEnabled = false;
        return retired;
      });
    }
    const currentToken = AndroidCtrlProxyClient.currentIncarnationToken(deviceId);
    const existing = registry.peek(deviceId);
    if (
      existing?.incarnationToken !== undefined &&
      currentToken !== undefined &&
      existing.incarnationToken !== currentToken
    ) {
      logger.info(
        `[CTRL_PROXY] Replacing client for ${deviceId}: incarnation ${existing.incarnationToken} -> ${currentToken}`,
      );
      void AndroidCtrlProxyClient.evictAfterDeviceRemoval(deviceId).catch((error) => {
        logger.warn(
          `[CTRL_PROXY] Failed to close old incarnation client for ${deviceId}: ${errorMessage(error)}`,
          error,
        );
      });
    } else if (existing && existing.incarnationToken === undefined) {
      existing.incarnationToken = currentToken;
    }
    return registry.get(deviceId, () => {
      logger.debug(`[CTRL_PROXY] Creating singleton for device: ${deviceId}`);
      return new AndroidCtrlProxyClient(device, adbFactory.create(device));
    });
  }

  private static currentIncarnationToken(deviceId: string): string | undefined {
    // A retired client serves no runtime; preserve its inert resolution path.
    return AndroidCtrlProxyClient.registry.isRetired(deviceId)
      ? undefined
      : deviceIncarnationToken(deviceId);
  }

  public static getExistingInstance(deviceId: string): AndroidCtrlProxyClient | null {
    return AndroidCtrlProxyClient.registry.peek(deviceId) ?? null;
  }

  /** A one-read client; never registers as an owner or recovers the service. */
  public static createForObservationRead(
    device: BootedDevice,
    adbFactory: AdbClientFactory = defaultAdbClientFactory,
    existing?: AndroidCtrlProxyClient,
  ): AndroidCtrlProxyClient {
    requireBootedDevice(device, "AndroidCtrlProxyClient.createForObservationRead");
    assertAndroidCtrlProxyDevice(device);
    return new AndroidCtrlProxyClient(device, adbFactory.create(device), {
      ctrlProxyForwardLease:
        existing?.ctrlProxyForwardLease.fork?.() ?? existing?.ctrlProxyForwardLease,
      transientObserver: true,
    });
  }

  public connectForObservationRead(): Promise<boolean> {
    return super.ensureConnected();
  }

  /** @internal Test seam for CtrlProxyClient tests (#7992); not part of the public API. */
  public static registerForTesting(client: AndroidCtrlProxyClient, deviceId: string): void {
    AndroidCtrlProxyClient.registry.invalidate(deviceId);
    AndroidCtrlProxyClient.registry.get(deviceId, () => client);
  }

  /**
   * @internal Clear registry entries for isolated tests only. This closes
   * nothing and resets no ports, observers, or retired-device state. Unlike
   * resetInstances(), it avoids fire-and-forget close() cleanup that can run
   * real adb/socket work and avoids resetting PortManager's clock/allocations,
   * which some test files configure in beforeAll.
   */
  public static clearInstanceRegistryForTesting(): void {
    resetForeignCtrlProxyForwardEvidenceForTesting();
    AndroidCtrlProxyClient.registry.closeAll();
  }

  /**
   * Evict the singleton for a device from the registry. `close()` disables
   * auto-reconnect permanently, so a detached instance left in the map would be
   * handed back to a device that later reuses the same serial (a re-booted
   * emulator) as a stale, non-reconnecting client. Removing it lets the next
   * `getInstance` build a fresh, auto-reconnect-enabled client.
   */
  public static removeInstance(deviceId: string): void {
    AndroidCtrlProxyClient.registry.invalidate(deviceId);
  }

  public static retireForShutdown(deviceId: string): void {
    AndroidCtrlProxyClient.registry.retire(deviceId);
    const client = AndroidCtrlProxyClient.registry.peek(deviceId);
    if (client) {
      client.closed = true;
      client.autoReconnectEnabled = false;
    }
  }

  public static resumeAfterDeviceStart(deviceId: string): void {
    // An explicit startDevice/setup is a fresh start for forced-restart admission (#11246).
    const registry = AndroidCtrlProxyClient.registry;
    registry.peek(deviceId)?.forcedRestartBudget.rearm("explicit device start");
    if (registry.isRetired(deviceId)) {
      registry.resume(deviceId);
      registry.invalidate(deviceId);
    }
  }

  /** The device re-entered the ready state; rearm only if recovery saw it absent (#11246). */
  public static noteDeviceOnline(deviceId: string): void {
    AndroidCtrlProxyClient.registry.peek(deviceId)?.rearmAfterDeviceOnline();
  }

  private rearmAfterDeviceOnline(): void {
    this.getServiceRecovery().rearmAfterDeviceOnline();
  }

  /** Remove only the singleton captured before asynchronous incarnation cleanup began. */
  public static removeInstanceIfCurrent(deviceId: string, instance: AndroidCtrlProxyClient): void {
    AndroidCtrlProxyClient.registry.invalidate(deviceId, instance);
  }

  /** Close the old guest connection and remove its serial singleton. */
  public static async invalidateForDeviceIncarnation(deviceId: string): Promise<void> {
    const client = AndroidCtrlProxyClient.getExistingInstance(deviceId);
    try {
      await client?.close();
    } finally {
      if (client) {
        AndroidCtrlProxyClient.removeInstanceIfCurrent(deviceId, client);
      }
    }
  }

  /** Evict before asynchronous cleanup so a reused serial gets a new client and port. */
  public static async evictAfterDeviceRemoval(deviceId: string): Promise<void> {
    const client = AndroidCtrlProxyClient.getExistingInstance(deviceId);
    if (!client) {
      return;
    }
    client.invalidateForShutdownRecovery();
    await client.close();
  }

  public isClosed(): boolean {
    return this.closed;
  }

  public beginReadinessHold(): () => void {
    this.readinessHolds++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.readinessHolds--;
      }
    };
  }

  public getForwardFailureCause(): string | undefined {
    if (this.closed) {
      return `CtrlProxy client for ${this.device.deviceId} was closed (forwarding lease released or device removed) before an adb forward was established`;
    }
    return this.forwardSetupFailure;
  }

  /** Devices whose singleton client holds the cross-process forwarding lease. */
  public static getForwardLeaseHeldDeviceIds(): string[] {
    return heldForwardLeaseDeviceIds(AndroidCtrlProxyClient.forwardLeaseRegistry());
  }

  /** CtrlProxy use of a device by this process (#10497); see {@link forwardLeaseActivity}. */
  public static getForwardLeaseActivity(
    deviceId: string,
    timer: Timer = defaultTimer,
  ): ForwardLeaseActivity {
    return forwardLeaseActivity(AndroidCtrlProxyClient.forwardLeaseRegistry(), deviceId, timer);
  }

  /** Give up an idle device's forwarding lease (issue #10497). */
  public static releaseIdleForwardLease(deviceId: string): Promise<void> {
    return releaseIdleForwardLease(AndroidCtrlProxyClient.forwardLeaseRegistry(), deviceId);
  }

  /** Graceful daemon stop: close every client and release its forwarding lease, bounded. */
  public static releaseForwardLeasesForShutdown(timer: Timer, timeoutMs: number): Promise<void> {
    return releaseForwardLeasesForShutdown(
      AndroidCtrlProxyClient.forwardLeaseRegistry(),
      timer,
      timeoutMs,
    );
  }

  /** Lease-bookkeeping view over the static client registry (registry stays here). */
  private static forwardLeaseRegistry(): ForwardLeaseClientRegistry {
    return {
      singletonEntries: () =>
        AndroidCtrlProxyClient.registry
          .entries()
          .map(([deviceId, client]) => [deviceId, client.asForwardLeaseClient()]),
      singleton: (deviceId) =>
        AndroidCtrlProxyClient.registry.peek(deviceId)?.asForwardLeaseClient(),
      observers: () =>
        [...AndroidCtrlProxyClient.activeObservers].map((c) => c.asForwardLeaseClient()),
      evictSingleton: (deviceId) => {
        const client = AndroidCtrlProxyClient.getExistingInstance(deviceId);
        if (!client) {
          return null;
        }
        AndroidCtrlProxyClient.removeInstanceIfCurrent(deviceId, client);
        return client.asForwardLeaseClient();
      },
      clearSingletons: () => {
        AndroidCtrlProxyClient.registry.closeAll();
      },
    };
  }

  private asForwardLeaseClient(): ForwardLeaseClient {
    const client = this;
    return {
      deviceId: client.device.deviceId,
      forwardLease: client.ctrlProxyForwardLease,
      get readinessHolds() {
        return client.readinessHolds;
      },
      getRequestActivity: () => client.getRequestActivity(),
      close: () => client.close(),
      markForwardLeaseForceReleased: () => {
        client.forwardLeaseForceReleased = true;
      },
    };
  }

  /**
   * Evict this client before its asynchronous close can complete. Its port is
   * held so a replacement client cannot share an ADB forward with late cleanup.
   */
  public invalidateForShutdownRecovery(): void {
    AndroidCtrlProxyClient.registry.invalidate(this.device.deviceId, this);
    PortManager.releaseIfAllocated(this.portAllocationId, this.localPort);
    PortManager.holdForCleanup(this.localPort);
    this.cleanupHeldPort = this.localPort;
    // A replacement must recover even if this invalidated client's asynchronous
    // ADB cleanup is wedged. Its held port prevents the replacement from sharing
    // the forward while that cleanup eventually completes.
    this.releaseCtrlProxyForwardLeaseAfterConnectionSettles();
  }

  protected override onSessionRebound(): void {
    // A new session is a fresh owner: do not let a previous session's exhausted budget strand it.
    this.forcedRestartBudget.rearm("new session bound");
  }

  /**
   * Returns the session currently receiving this device's navigation events,
   * or null when the client is unbound.
   */
  public getBoundSessionId(): string | null {
    return this.boundSessionId;
  }

  /**
   * Returns the booted-device identity that constructed this client. Callers
   * use this after teardown to distinguish the original emulator incarnation
   * from a same-ID replacement.
   */
  public getBootedDeviceIdentity(): BootedDevice {
    return { ...this.device };
  }

  /**
   * Reset all instances (for testing)
   */
  public static resetInstances(): void {
    resetForeignCtrlProxyForwardEvidenceForTesting();
    for (const instance of AndroidCtrlProxyClient.registry.closeAll()) {
      instance.close().catch((error) => {
        const logger = instance.loggerInstance;
        // The local alias keeps the injected logger visible to the catch-convention lint rule.
        logger.warn(`[CTRL_PROXY] Instance reset cleanup failed: ${errorMessage(error)}`, error);
      });
    }
    AndroidCtrlProxyClient.activeObservers.clear();
    AndroidCtrlProxyClient.registry.clearRetired();
    PortManager.reset();
    logger.info("[CTRL_PROXY] Reset all singleton instances and port allocations");
  }

  /** Create an instance for testing with injectable dependencies. */
  public static createForTesting(
    device: BootedDevice,
    adb: AdbExecutor,
    deps: AndroidCtrlProxyClientDeps & {
      screenshotBackoffScheduler?: ScreenshotBackoffScheduler;
    } = {},
  ): AndroidCtrlProxyClient {
    const client = new AndroidCtrlProxyClient(device, adb, {
      ...deps,
      ctrlProxyForwardLease: deps.ctrlProxyForwardLease ?? new NoOpCtrlProxyForwardLease(),
      serviceManagerFactory: deps.serviceManagerFactory ?? defaultAndroidServiceManagerFactory,
    });
    // Unit tests never read the real host's TCP table.
    client.forwardClientProbe = new NoForwardClientConnectionProbe();
    // Test-only seam: pre-seed the lazily-built scheduler so tests can assert shared floor
    // accounting (noteCaptureStarted) without the live device-data-stream server. Not exposed on
    // the production getInstance path.
    if (deps.screenshotBackoffScheduler) {
      client.screenshotBackoffScheduler = deps.screenshotBackoffScheduler;
    }
    return client;
  }

  /** @internal Test seam for CtrlProxyClient tests (#7992); not part of the public API. */
  public static createWithFileForwardLeaseForTesting(
    device: BootedDevice,
    adb: AdbExecutor,
    webSocketFactory: WebSocketFactory,
    timer: Timer,
  ): AndroidCtrlProxyClient {
    return new AndroidCtrlProxyClient(device, adb, { webSocketFactory, timer });
  }

  // ===========================================================================
  // DeviceServiceClient abstract method implementations
  // ===========================================================================

  protected getWebSocketUrl(): string {
    return `ws://127.0.0.1:${this.localPort}/ws`;
  }

  protected handleMessage(data: WebSocket.Data): Promise<void> {
    const handler = this.handleWebSocketMessage(data);
    this.inFlightMessageHandlers.add(handler);
    // Observe settlement without wrapping dispatch or moving its synchronous prefix.
    // The existing handleWebSocketMessage catch owns logging handler failures.
    void handler.then(
      () => this.inFlightMessageHandlers.delete(handler),
      () => this.inFlightMessageHandlers.delete(handler),
    );
    return handler;
  }

  /**
   * Defense in depth on top of onConnectionEstablished(): every caller that needs the
   * device connected already routes through ensureConnected() (getLatestHierarchy,
   * requestHierarchySync, etc.), so re-syncing accessibility flags here guarantees the
   * device has the current config before any hierarchy request goes out — regardless of
   * whether this call freshly opened the WebSocket (onConnectionEstablished fires) or
   * reused an already-open one (connectWebSocket's early-return skips it). Cost: the
   * allEnabled early-return in syncAccessibilityFlagsToDevice() skips the send entirely
   * in the common case (all flags default). When a flag IS disabled (e.g. --no-occlusion)
   * it re-sends the config on each call — a small, idempotent, order-preserved message,
   * kept deliberately simple as defense-in-depth so a reused connection can't drift.
   */
  public override async ensureConnected(
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
  ): Promise<boolean> {
    if (this.closed) {
      return false;
    }
    const connected = await super.ensureConnected(perf);
    if (connected) {
      this.syncAccessibilityFlagsToDevice();
    }
    return connected;
  }

  public override async connectWebSocket(
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
  ): Promise<boolean> {
    if (this.closed) {
      return false;
    }
    const connection = super.connectWebSocket(perf);
    this.inFlightConnection = connection;
    try {
      return await connection;
    } finally {
      if (this.inFlightConnection === connection) {
        this.inFlightConnection = null;
      }
      if (this.closed) {
        await this.finishInvalidatedConnectionCleanup();
      }
    }
  }

  protected onConnectionEstablished(): void {
    if (this.transientObserver) {
      return;
    }
    // Reset failure escalation state on every successful connect (issue #7532).
    this.consecutiveConnectionFailures = 0;
    // A newly connected CtrlProxy may be a different runner or service version.
    this.resetA11yScreenshotSupport();
    if (this.restartRearmTimeout) {
      this.timer.clearTimeout(this.restartRearmTimeout);
    }
    this.restartRearmTimeout = this.timer.setTimeout(() => {
      this.restartRearmTimeout = null;
      this.getServiceRecovery().onStabilityTimerFired();
    }, AndroidCtrlProxyClient.RESTART_REARM_STABILITY_MS);
    this.syncNetworkStateToDevice();
    this.syncAccessibilityFlagsToDevice();
    // The runner loses its in-process content observers across a service restart while the desktop
    // Unix stream remains connected. The stream server retains the pane-owned subscriptions and
    // replays them on this new CtrlProxy connection.
    void getDeviceDataStreamServer()?.reapplyStorageSubscriptionsForDevice(this.device.deviceId);
    // Resume the screenshot keepalive after a (re)connect. onConnectionClosed()
    // cancels it; without restarting here, a transient drop on a STATIC screen
    // leaves the live view frozen forever (no UI change to retrigger a capture).
    // Subscriber-gated and idempotent, so this is a no-op when nobody is
    // watching and safe to call on every reconnect.
    this.startScreenshotBackoff();
  }

  /**
   * Push THIS device's mock rules for a `mockNetwork`/`clearMockNetwork` call and wait (bounded)
   * for the rules the app's regex engine rejected (issue #10101). A runner or SDK that does not
   * report resolves to `unconfirmed`; only an undelivered push is a failure.
   */
  async pushNetworkMockRules(
    rules: NetworkMockRuleSync[],
    timeoutMs: number = NETWORK_MOCK_REPORT_TIMEOUT_MS,
  ): Promise<NetworkMockPushResult> {
    return pushNetworkMockRules(
      this.createDelegateContext(),
      rules,
      () =>
        this.sendMessage(
          serializeCtrlProxyRequest(ctrlProxyRequests.setNetworkMockRules({ rules })),
        ),
      timeoutMs,
    );
  }

  /** @internal Test seam for CtrlProxyClient tests (#7992); not part of the public API. */
  public onConnectionClosed(): void {
    const rearmTimerWasArmed = this.restartRearmTimeout !== null;
    if (this.restartRearmTimeout) {
      this.timer.clearTimeout(this.restartRearmTimeout);
      this.restartRearmTimeout = null;
    }
    this.getServiceRecovery().onSocketClosed(rearmTimerWasArmed);
    this._prototypes?.handleDisconnect();
    this.supportedCommands = null;
    this.rejectedCommands.clear();
    this.lateCancelledScreenshotRequestIds.clear();
    this.observerHierarchyRequestIds.clear();
    this.clearHierarchyObservationStreamSuppressions();
    this.cancelScreenshotBackoff();
    this._hierarchy?.rejectAllPendingHierarchy("WebSocket connection closed");
    // Issue #7540: the cache describes device UI state as of the closed connection, and the
    // recomposition-tracking latch describes what the runner's accessibility service instance
    // held. Both are connection-scoped: a runner restart (crash rebind, APK reinstall) behind
    // this close can hand the next connection a service with tracking off, and a stale tree
    // served after reconnect can describe UI state from before whatever triggered the restart.
    // Mirrors IOSCtrlProxyClient.onConnectionClosed() clearing `cachedHierarchy`.
    this.cachedHierarchy = null;
    this._hierarchy?.resetConnectionScopedState();
    // The SDK reports through this link: after a reconnect the app process may be a new one, and a
    // route from before the gap cannot be told apart from the new process's.
    this.clearSdkScreenIdentity();
    if (this.transientObserver) {
      return;
    }
    void this.markInstalledAppsStale("websocket_closed");
    this.deviceConnectionLostNotifier.onDeviceConnectionLost(this.device.deviceId);

    if (this.hierarchyNavigationDetector) {
      this.hierarchyNavigationDetector.dispose();
      this.hierarchyNavigationDetector = null;
    }

    // Revalidate build/device provenance across a disconnect (#4984): while the WS has
    // no client, a package_event has zero listeners, so an app could be replaced
    // unobserved. Invalidate every known app's cached context — clearing the resolved
    // context, the provider's hash cache, and bumping the generation so any in-flight
    // resolution is discarded — so the next nav event after reconnect re-resolves the
    // hash instead of attributing to the pre-update build indefinitely.
    for (const appId of this.knownBuildContextApps()) {
      this.invalidateBuildContext(appId);
    }

    // Stop work profile monitor when connection closes
    this.stopWorkProfileMonitor();
  }

  /**
   * Whether a failed attempt counts toward escalating to service recovery (issue #7532).
   * The shared `DeviceServiceClient.onConnectAttemptFailed` funnel (#7537) calls this once per
   * failed dial AND once per lost open connection, so both refused dials and dropped
   * connections count toward the threshold. Android additionally skips a failure caused by a
   * foreign forwarding-lease conflict.
   */
  protected override shouldCountConnectionFailure(): boolean {
    return !this.isLastConnectionFailureForwardingLeaseConflict();
  }

  protected override onConnectionFailureThresholdReached(): void {
    if (!this.isRecoveringService) {
      this.getServiceRecovery().trigger();
    }
  }

  protected async setupBeforeConnect(perf: PerformanceTracker, signal: AbortSignal): Promise<void> {
    await this.setupPortForwarding(perf, signal);
  }

  async requestHierarchySyncWithoutObservationStreamPush(
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    disableAllFiltering: boolean = false,
    signal?: AbortSignal,
    timeoutMs: number = 10000,
  ): Promise<{ hierarchy: AccessibilityHierarchy; perfTiming?: AndroidPerfTiming[] } | null> {
    const deadline = this.timer.now() + Math.max(0, timeoutMs);
    let suppressedRequestId: string | undefined;
    try {
      return await this.hierarchy.requestHierarchySyncWithOptions({
        perf,
        disableAllFiltering,
        signal,
        timeoutMs,
        observerMode: false,
        onRequestId: (requestId) => {
          // A failed WS send switches to the broadcast's sync_ id. Retire the old token first.
          if (suppressedRequestId) {
            this.removeHierarchyObservationStreamSuppression(suppressedRequestId);
          }
          if (this.closed || signal?.aborted) {
            return;
          }
          suppressedRequestId = requestId;
          this.hierarchyObservationStreamSuppressions.set(
            requestId,
            this.timer.setTimeout(
              () => {
                this.removeHierarchyObservationStreamSuppression(requestId);
              },
              Math.max(0, deadline - this.timer.now()),
            ),
          );
        },
      });
    } finally {
      if (suppressedRequestId) {
        this.removeHierarchyObservationStreamSuppression(suppressedRequestId);
      }
    }
  }

  protected removeHierarchyObservationStreamSuppression(requestId: string): boolean {
    const timeout = this.hierarchyObservationStreamSuppressions.get(requestId);
    if (timeout === undefined) {
      return false;
    }
    this.hierarchyObservationStreamSuppressions.delete(requestId);
    this.timer.clearTimeout(timeout);
    return true;
  }

  private clearHierarchyObservationStreamSuppressions(): void {
    for (const requestId of this.hierarchyObservationStreamSuppressions.keys()) {
      this.removeHierarchyObservationStreamSuppression(requestId);
    }
  }

  async requestHierarchySyncForObserver(
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    disableAllFiltering = false,
    signal?: AbortSignal,
    timeoutMs = 10000,
    display?: number | ObserverHierarchyRequestOptions,
  ): Promise<{ hierarchy: AccessibilityHierarchy; frameContext?: string } | null> {
    const deadline = this.timer.now() + timeoutMs;
    await this.waitForPendingRequests(timeoutMs, signal);
    const remaining = deadline - this.timer.now();
    if (remaining <= 0) {
      throw new ObserverPendingRequestTimeoutError();
    }
    return this.hierarchy.requestHierarchySyncForObserver(
      perf,
      disableAllFiltering,
      signal,
      remaining,
      display,
    );
  }

  async subscribeStorage(
    packageName: string,
    fileName: string,
    timeoutMs?: number,
  ): Promise<StorageSubscription> {
    // A provider call into an app without a process starts that process, and the next subscribe
    // then fails with a misleading "inspection is disabled" (#10246). Decide "not running" here,
    // before any provider call, so a refused subscribe leaves the app stopped.
    if (!(await this.isAppProcessRunning(packageName))) {
      throw new ActionableError(
        `Cannot subscribe to storage: ${packageName} is not running. Launch the app first (launchApp) and subscribe again.`,
      );
    }
    return this.storage.subscribeStorage(packageName, fileName, timeoutMs);
  }

  /** True when the app has a live process; a failed probe counts as not running. */
  private async isAppProcessRunning(packageName: string): Promise<boolean> {
    try {
      const result = await this.adb.executeCommand(`shell pidof ${shellQuote(packageName)}`);
      return result.stdout.trim().length > 0;
    } catch (error) {
      // pidof exits non-zero when no process matches; that is the expected "not running" answer.
      logger.debug(`pidof ${packageName} found no process: ${error}`);
      return false;
    }
  }

  /** Send start_recording for wire compatibility; currently has no effect on the device. */
  notifyRecordingStarted(): void {
    this.sendMessage(serializeCtrlProxyRequest(ctrlProxyRequests.startRecording()));
  }

  /** Send stop_recording for wire compatibility; currently has no effect on the device. */
  notifyRecordingStopped(): void {
    this.sendMessage(serializeCtrlProxyRequest(ctrlProxyRequests.stopRecording()));
  }

  // ===========================================================================
  // Connection Management
  // ===========================================================================

  async close(): Promise<void> {
    // Latch closed BEFORE super.close(): super.close() rejects the in-flight
    // CtrlProxy screenshot request (requestManager.cancelAll), whose catch falls
    // through to captureScreenshotViaAdb("ctrlproxy_exception"). Setting the flag
    // first makes that leaked one-shot fallback short-circuit (#5493).
    this.closed = true;
    this.clearHierarchyObservationStreamSuppressions();
    if (this.restartRearmTimeout) {
      this.timer.clearTimeout(this.restartRearmTimeout);
      this.restartRearmTimeout = null;
    }
    this.getServiceRecovery().failPendingStability("Client closed before stable reconnect");
    try {
      // Stop work profile monitor if running
      this.stopWorkProfileMonitor();

      await super.close();
      await this.drainInFlightMessageHandlers();

      if (this.portForwardingSetup) {
        // Do not claim the forward is gone when adb could not confirm its removal:
        // the next client's reconciliation pass must still be able to reclaim it.
        this.portForwardingSetup = !(await this.removeCtrlProxyPortForward(this.localPort));
      }

      if (this.ownsPortAllocation) {
        PortManager.releaseIfAllocated(this.portAllocationId, this.localPort);
      }
      await this.finishInvalidatedConnectionCleanup();
    } catch (error) {
      logger.warn(`[CTRL_PROXY] Error during cleanup: ${error}`);
    } finally {
      this.lateCancelledScreenshotRequestIds.clear();
      this.releaseCtrlProxyForwardLeaseAfterConnectionSettles();
      AndroidCtrlProxyClient.activeObservers.delete(this);
      // A closed client never reconnects, so leaving it registered would hand a
      // stale client to the next getInstance. Only evict if still current.
      AndroidCtrlProxyClient.registry.invalidate(this.device.deviceId, this);
    }
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  private async drainInFlightMessageHandlers(): Promise<void> {
    if (this.inFlightMessageHandlers.size === 0) {
      return;
    }
    const drainTimeout = Symbol("inbound handler drain timeout");
    try {
      await raceWithDeadline(Promise.allSettled([...this.inFlightMessageHandlers]), {
        timer: this.timer,
        timeoutMs: AndroidCtrlProxyClient.INBOUND_HANDLER_DRAIN_TIMEOUT_MS,
        label: "Inbound handler drain",
        timeoutError: () => drainTimeout,
      });
    } catch (error) {
      if (error !== drainTimeout) {
        throw toActionableError(error, "Failed to drain Android CtrlProxy inbound handlers");
      }
      logger.warn(
        `[CTRL_PROXY] Inbound handler drain timed out after ${AndroidCtrlProxyClient.INBOUND_HANDLER_DRAIN_TIMEOUT_MS}ms; continuing cleanup`,
      );
    }
  }

  private async finishInvalidatedConnectionCleanup(): Promise<void> {
    if (this.inFlightConnection !== null || this.cleanupHeldPort === null) {
      return;
    }
    const heldPort = this.cleanupHeldPort;
    this.cleanupHeldPort = null;
    PortManager.releaseIfAllocated(this.portAllocationId, this.localPort);
    PortManager.releaseCleanupHold(heldPort);
  }

  /**
   * ADB commands may ignore cancellation. Keep the cross-process ownership
   * lease until an in-flight connection (including its forward setup) settles,
   * so its late cleanup cannot remove a replacement process's forward.
   */
  private releaseCtrlProxyForwardLeaseAfterConnectionSettles(): void {
    if (this.ctrlProxyForwardLeaseReleaseScheduled) {
      return;
    }
    this.ctrlProxyForwardLeaseReleaseScheduled = true;

    const releaseLease = (): void => this.ctrlProxyForwardLease.release();
    const inFlightConnection = this.inFlightConnection;
    if (inFlightConnection === null) {
      releaseLease();
      return;
    }
    void inFlightConnection.then(releaseLease, releaseLease);
  }

  /** Resolve request responses only when the runner supplies a truthy request ID. */
  protected resolvePendingResponse<Message extends { requestId?: string | null }, Payload>(
    message: Message,
    buildPayload: (message: Message & { requestId: string }) => Payload,
  ): void {
    if (message.requestId) {
      this.requestManager.resolve<Payload>(
        message.requestId,
        buildPayload(message as Message & { requestId: string }),
      );
    }
  }

  // Cancel only this caller's wait; connection establishment is shared with other operations.
  protected async awaitActionWork<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (!signal) {
      return work();
    }
    return raceWithDeadline(work(), {
      timer: this.timer,
      signal,
      label: "Android CtrlProxy action",
    });
  }

  protected override awaitHandshakePoll(
    work: () => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    return this.awaitActionWork(work, signal);
  }
}

registerDeviceIncarnationListener({
  name: "ctrlproxy-client",
  onDeviceIdentityReplaced: (deviceId) => {
    void AndroidCtrlProxyClient.evictAfterDeviceRemoval(deviceId).catch((error) => {
      logger.warn(
        `[CTRL_PROXY] Failed to close replaced device ${deviceId}: ${errorMessage(error)}`,
        error,
      );
    });
  },
  onDeviceIncarnationChanged: async (deviceId) =>
    await AndroidCtrlProxyClient.invalidateForDeviceIncarnation(deviceId),
});

/**
 * IOSCtrlProxyClient - Main client for iOS CtrlProxy.
 *
 * This client provides a unified interface to the iOS CtrlProxy
 * via WebSocket connection. It uses composition with delegate modules to handle
 * specific functionality:
 *
 * - CtrlProxyGestures: Swipe, tap, drag, pinch operations
 * - CtrlProxyText: setText, clearText, IME actions, select all
 * - CtrlProxyKeyboard: keyboard open, close, detect
 * - CtrlProxyHierarchy: Hierarchy retrieval, caching, conversion
 * - CtrlProxyScreenshot: Screenshot capture
 * - CtrlProxyNavigation: pressHome, pressBack, launchApp
 */

import WebSocket from "ws";
import { TelemetryRecorder } from "../../telemetry/TelemetryRecorder";
import { getFailureRecorder } from "../../failures/FailureRecorder";
import { logger } from "../../../utils/logger";
import {
  BootedDevice,
  HighlightShape,
  ImeAction,
  ViewHierarchyResult,
} from "../../../models";
import { ViewHierarchyQueryOptions } from "../../../models/ViewHierarchyQueryOptions";
import { PerformanceTracker, NoOpPerformanceTracker } from "../../../utils/PerformanceTracker";
import { Timer, defaultTimer } from "../../../utils/SystemTimer";
import { IOS_CTRL_PROXY_RESERVED_PORTS, PortManager } from "../../../utils/PortManager";
import { requireBootedDevice } from "../../../utils/requireBootedDevice";
import { shouldUseHostControl, getHostControlHost } from "../../../utils/hostControlClient";
import { isRunningInDocker } from "../../../utils/dockerEnv";
import { IOSCtrlProxyManager, CtrlProxyIosManager } from "../../../utils/IOSCtrlProxyManager";
import { PlatformDeviceManagerFactory } from "../../../utils/factories/PlatformDeviceManagerFactory";
import { NavigationGraphManager } from "../../navigation/NavigationGraphManager";
import { serverConfig } from "../../../utils/ServerConfig";
import { NetworkState } from "../../../server/NetworkState";
import { buildNetworkMockRules } from "../../../server/networkMockRules";
import { NavigationScreenshotManager } from "../../navigation/NavigationScreenshotManager";
import {
  HierarchyNavigationDetector,
  HierarchyNavigationUpdateMetrics
} from "../../navigation/HierarchyNavigationDetector";
import { AccessibilityHierarchy } from "../../navigation/ScreenFingerprint";
import {
  DeviceServiceClient,
  WebSocketFactory,
  defaultWebSocketFactory,
} from "../DeviceServiceClient";
import {
  observationStreamDeviceConnectionLostNotifier,
  type DeviceConnectionLostNotifier,
} from "../DeviceConnectionLostNotifier";
import type { SetTextOptions } from "../DeviceService";
import type { CtrlProxyClient } from "../interfaces/CtrlProxyClient";
import { getDeviceDataStreamServer, PerformanceStreamData } from "../../../daemon/deviceDataStreamSocketServer";
import { getPerformanceMonitor } from "../../performance/PerformanceMonitor";
import {
  ScreenshotBackoffScheduler,
  DefaultScreenshotBackoffScheduler,
  ScreenshotCaptureResult,
} from "../ScreenshotBackoffScheduler";

/**
 * Factory function type for creating CtrlProxyIosManager instances.
 * Used for testing to inject fake service managers.
 */
export type ServiceManagerFactory = (device: BootedDevice) => CtrlProxyIosManager;

/** Default production factory that delegates to the real singleton. */
const defaultServiceManagerFactory: ServiceManagerFactory = d => IOSCtrlProxyManager.getInstance(d);

/**
 * Function type that returns currently booted devices.
 * Injected for testability — avoids coupling to PlatformDeviceManagerFactory in tests.
 */
export type BootedDeviceLister = () => Promise<BootedDevice[]>;

/** Default production lister that queries the real device manager. */
const defaultBootedDeviceLister: BootedDeviceLister = () =>
  PlatformDeviceManagerFactory.getInstance().getBootedDevices("ios");

/**
 * No-op factory used by createForTesting so that tests which don't supply
 * a factory never trigger real CtrlProxy setup on connection failure.
 */
class NoOpIOSCtrlProxyManager implements CtrlProxyIosManager {
  async setup(): Promise<{ success: false; message: string }> { return { success: false, message: "no-op test stub" }; }
  async isInstalled(): Promise<boolean> { return false; }
  async isRunning(): Promise<boolean> { return false; }
  async isAvailable(): Promise<boolean> { return false; }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  getServicePort(): number { return 0; }
  async getReportedRunnerPort(): Promise<number | null> { return null; }
  setAutoRestart(): void {}
  isAutoRestartEnabled(): boolean { return false; }
  async forceRestart(): Promise<void> {}
}

const noOpServiceManagerFactory: ServiceManagerFactory = () => new NoOpIOSCtrlProxyManager();

// Import delegates
import { CtrlProxyGestures } from "./CtrlProxyGestures";
import { CtrlProxyText } from "./CtrlProxyText";
import { CtrlProxyHierarchy } from "./CtrlProxyHierarchy";
import { CtrlProxyScreenshot } from "./CtrlProxyScreenshot";
import { CtrlProxyNavigation } from "./CtrlProxyNavigation";
import { CtrlProxyClipboard } from "./CtrlProxyClipboard";
import { CtrlProxyStorage } from "./CtrlProxyStorage";
import { CtrlProxyVoiceOver } from "./CtrlProxyVoiceOver";
import { CtrlProxyKeyboard } from "./CtrlProxyKeyboard";
import { CtrlProxyHighlights } from "./CtrlProxyHighlights";
import { CtrlProxyDatabase } from "./CtrlProxyDatabase";

// Import types
import type {
  DelegateContext,
  HierarchyDelegateContext,
  CtrlProxyNode,
  CtrlProxyHierarchy,
  CtrlProxyHierarchyResponse,
  CtrlProxyScreenshotResult,
  CtrlProxySwipeResult,
  CtrlProxyTapResult,
  CtrlProxyDragResult,
  CtrlProxyPinchResult,
  CtrlProxySetTextResult,
  CtrlProxyImeActionResult,
  CtrlProxySelectAllResult,
  CtrlProxyKeyboardResult,
  CtrlProxyPressHomeResult,
  CtrlProxyPressBackResult,
  CtrlProxyShakeResult,
  CtrlProxyPressButtonResult,
  CtrlProxyRecentAppsResult,
  CtrlProxyRotateResult,
  CtrlProxyLaunchAppResult,
  CtrlProxyPerfTiming,
  CtrlProxyPerformanceSnapshot,
  CtrlProxyCachedHierarchy,
  CtrlProxyVoiceOverResult,
  CtrlProxyVoiceOverActionResult,
  CtrlProxyActionResult,
  CtrlProxyClipboardResult,
  CtrlProxyHighlightResult,
  WebSocketMessage,
} from "./types";


/**
 * Interface for CtrlProxy providing iOS UI hierarchy and interaction capabilities
 * via WebSocket connection to iOS CtrlProxy
 */
// eslint-disable-next-line @typescript-eslint/naming-convention -- IOS is an acronym, not a Hungarian-notation interface prefix
export interface IOSCtrlProxy extends CtrlProxyClient {
  getLatestHierarchy(
    waitForFresh?: boolean,
    timeout?: number,
    perf?: PerformanceTracker,
    skipWaitForFresh?: boolean,
    minTimestamp?: number
  ): Promise<CtrlProxyHierarchyResponse>;

  requestHierarchySync(
    perf?: PerformanceTracker,
    disableAllFiltering?: boolean,
    signal?: AbortSignal,
    timeoutMs?: number
  ): Promise<{ hierarchy: CtrlProxyHierarchy; perfTiming?: CtrlProxyPerfTiming } | null>;
  requestAddHighlight(
    id: string,
    shape: HighlightShape,
    timeoutMs?: number,
    perf?: PerformanceTracker
  ): Promise<CtrlProxyHighlightResult>;

  requestHierarchySyncWithoutObservationStreamPush(
    perf?: PerformanceTracker,
    disableAllFiltering?: boolean,
    signal?: AbortSignal,
    timeoutMs?: number
  ): Promise<{ hierarchy: CtrlProxyHierarchy; perfTiming?: CtrlProxyPerfTiming } | null>;

  convertToViewHierarchyResult(hierarchy: CtrlProxyHierarchy): ViewHierarchyResult;

  requestSwipe(
    x1: number, y1: number, x2: number, y2: number,
    duration?: number, timeoutMs?: number, perf?: PerformanceTracker
  ): Promise<CtrlProxySwipeResult>;

  requestTapCoordinates(
    x: number, y: number, duration?: number, timeoutMs?: number, perf?: PerformanceTracker
  ): Promise<CtrlProxyTapResult>;

  requestDrag(
    x1: number, y1: number, x2: number, y2: number,
    pressDurationMs: number, dragDurationMs: number, holdDurationMs: number, timeoutMs: number
  ): Promise<CtrlProxyDragResult>;

  requestPinch(
    centerX: number, centerY: number,
    distanceStart: number, distanceEnd: number, rotationDegrees: number,
    duration?: number, timeoutMs?: number, perf?: PerformanceTracker
  ): Promise<CtrlProxyPinchResult>;

  requestSetText(
    text: string, options?: SetTextOptions
  ): Promise<CtrlProxySetTextResult>;

  requestClearText(
    resourceId?: string, timeoutMs?: number, perf?: PerformanceTracker
  ): Promise<CtrlProxySetTextResult>;

  requestImeAction(
    action: ImeAction,
    timeoutMs?: number, perf?: PerformanceTracker
  ): Promise<CtrlProxyImeActionResult>;

  requestSelectAll(
    timeoutMs?: number, perf?: PerformanceTracker
  ): Promise<CtrlProxySelectAllResult>;

  requestKeyboard(
    action: "open" | "close" | "detect",
    timeoutMs?: number, perf?: PerformanceTracker
  ): Promise<CtrlProxyKeyboardResult>;

  requestClipboard(
    action: "copy" | "paste" | "clear" | "get",
    text?: string, timeoutMs?: number, perf?: PerformanceTracker
  ): Promise<CtrlProxyClipboardResult>;

  requestPressHome(
    timeoutMs?: number, perf?: PerformanceTracker
  ): Promise<CtrlProxyPressHomeResult>;

  requestPressBack(
    timeoutMs?: number, perf?: PerformanceTracker
  ): Promise<CtrlProxyPressBackResult>;

  requestShake(
    timeoutMs?: number, perf?: PerformanceTracker
  ): Promise<CtrlProxyShakeResult>;

  requestPressButton(
    button: string, timeoutMs?: number, perf?: PerformanceTracker
  ): Promise<CtrlProxyPressButtonResult>;

  requestRecentApps(
    timeoutMs?: number, perf?: PerformanceTracker
  ): Promise<CtrlProxyRecentAppsResult>;

  requestRotate(
    orientation: string, timeoutMs?: number, perf?: PerformanceTracker
  ): Promise<CtrlProxyRotateResult>;

  requestLaunchApp(
    bundleId: string, timeoutMs?: number, perf?: PerformanceTracker, coldBoot?: boolean
  ): Promise<CtrlProxyLaunchAppResult>;

  requestScreenshot(
    timeoutMs?: number, perf?: PerformanceTracker
  ): Promise<CtrlProxyScreenshotResult>;

  requestScreenshotWithoutObservationStreamPush(
    timeoutMs?: number, perf?: PerformanceTracker
  ): Promise<CtrlProxyScreenshotResult>;

  requestVoiceOverState(
    timeoutMs?: number, perf?: PerformanceTracker
  ): Promise<CtrlProxyVoiceOverResult>;

  requestVoiceOverActivate(
    label: string, action: "activate" | "long_press", timeoutMs?: number, perf?: PerformanceTracker
  ): Promise<CtrlProxyVoiceOverActionResult>;

  requestAction(
    action: string,
    resourceId?: string,
    label?: string,
    timeoutMs?: number,
    perf?: PerformanceTracker
  ): Promise<CtrlProxyActionResult>;

  requestMultiFingerSwipe(
    x1: number, y1: number, x2: number, y2: number,
    fingerCount: number, duration?: number, timeoutMs?: number, perf?: PerformanceTracker, fingerSpacing?: number
  ): Promise<CtrlProxySwipeResult>;

  clearCache(): void;

  onPushUpdate(callback: (hierarchy: CtrlProxyHierarchy) => void): () => void;
}

/**
 * Command rawValues a *fresh* iOS CtrlProxy runner advertises in its `connected`
 * handshake that the released v0.0.38 runner predates. The runner exposes no
 * version/hash, so presence of all of these in `supportedCommands` is the runner
 * identity used by diagnostics (doctor) and the booted-devices resource to tell a
 * current runner from a stale one.
 */
export const IOS_RUNNER_FEATURE_COMMANDS = [
  "request_shake",
  "request_press_button",
  "request_multi_finger_swipe",
  "add_highlight",
  "execute_sql",
  "set_network_mock_rules",
] as const;

/**
 * IOSCtrlProxyClient - WebSocket client for iOS CtrlProxy
 * Provides iOS UI hierarchy and interaction capabilities matching Android IOSCtrlProxyClient
 *
 * Extends DeviceServiceClient for shared connection lifecycle management.
 */
export class IOSCtrlProxyClient extends DeviceServiceClient implements IOSCtrlProxy {
  private static instances: Map<string, IOSCtrlProxyClient> = new Map();

  // Session binding for multi-agent isolation
  private boundSessionId: string | null = null;

  // Default port matches CtrlProxy on iOS
  public static readonly DEFAULT_PORT = 8765;

  /**
   * NOT using TTLCache: "fresh" state managed by push updates + minTimestamp
   * validation, not simple TTL expiration. The cache is invalidated based on
   * WebSocket push events and explicit invalidateCache() calls after actions.
   */
  private cachedHierarchy: CtrlProxyCachedHierarchy | null = null;
  private static readonly CACHE_FRESH_TTL_MS = 500;
  private hierarchyNavigationDetector: HierarchyNavigationDetector | null = null;
  private readonly hierarchyObservationStreamSuppressions: Map<string, NodeJS.Timeout> = new Map();

  // Push update callbacks
  private onPushUpdateCallbacks: Set<(hierarchy: CtrlProxyHierarchy) => void> = new Set();
  private supportedCommands: Set<string> | null = null;

  // Track last foreground bundle for performance monitoring
  private lastForegroundBundleId: string | null = null;

  // Platform-specific dependencies
  private readonly device: BootedDevice;
  private port: number;

  // Delegate instances (lazy initialized)
  private _gestures: CtrlProxyGestures | null = null;
  private _text: CtrlProxyText | null = null;
  private _hierarchy: CtrlProxyHierarchy | null = null;
  private _screenshot: CtrlProxyScreenshot | null = null;
  private _navigation: CtrlProxyNavigation | null = null;
  private _clipboard: CtrlProxyClipboard | null = null;
  private _voiceOver: CtrlProxyVoiceOver | null = null;
  private _storage: CtrlProxyStorage | null = null;
  private _keyboard: CtrlProxyKeyboard | null = null;
  private _highlights: CtrlProxyHighlights | null = null;
  private _database: CtrlProxyDatabase | null = null;

  // Logging tag for base class
  protected readonly logTag = "IOSCtrlProxyClient";

  // Screenshot backoff scheduler for real-time screenshot streaming
  private screenshotBackoffScheduler: ScreenshotBackoffScheduler | null = null;
  private cachedScreenDimensions: { width: number; height: number } | null = null;

  // Connection failure tracking for auto-restart
  private consecutiveConnectionFailures: number = 0;
  private isRequestingServiceRestart: boolean = false;
  private static readonly MAX_FAILURES_BEFORE_RESTART = 3;
  private static readonly CONNECTION_RESET_MS = 2000;

  // Auto-setup on connection failure
  private readonly serviceManagerFactory: ServiceManagerFactory;
  private readonly bootedDeviceLister: BootedDeviceLister;
  private readonly deviceConnectionLostNotifier: DeviceConnectionLostNotifier;
  private isAttemptingAutoSetup: boolean = false;

  private constructor(
    device: BootedDevice,
    port: number = IOSCtrlProxyClient.DEFAULT_PORT,
    wsFactory: WebSocketFactory = defaultWebSocketFactory,
    timer: Timer = defaultTimer,
    serviceManagerFactory: ServiceManagerFactory = defaultServiceManagerFactory,
    bootedDeviceLister: BootedDeviceLister = defaultBootedDeviceLister,
    deviceConnectionLostNotifier: DeviceConnectionLostNotifier = observationStreamDeviceConnectionLostNotifier
  ) {
    super(timer, wsFactory, { connectionResetMs: IOSCtrlProxyClient.CONNECTION_RESET_MS });
    this.device = device;
    this.port = port;
    this.serviceManagerFactory = serviceManagerFactory;
    this.bootedDeviceLister = bootedDeviceLister;
    this.deviceConnectionLostNotifier = deviceConnectionLostNotifier;
  }

  /**
   * Get singleton instance for a device
   */
  public static getInstance(
    device: BootedDevice,
    port?: number
  ): IOSCtrlProxyClient {
    requireBootedDevice(device, "IOSCtrlProxyClient.getInstance");
    const resolvedPort = port ?? (
      device.platform === "ios"
        ? PortManager.allocate(device.deviceId, { reservedPorts: IOS_CTRL_PROXY_RESERVED_PORTS })
        : IOSCtrlProxyClient.DEFAULT_PORT
    );
    const key = device.deviceId;
    const existing = IOSCtrlProxyClient.instances.get(key);
    if (existing) {
      existing.updatePort(resolvedPort);
      return existing;
    }

    const client = new IOSCtrlProxyClient(device, resolvedPort);
    IOSCtrlProxyClient.instances.set(key, client);
    return client;
  }

  /**
   * Return the existing client for a device without creating one (or allocating a
   * port). Hot paths that only want a connection-free read of cached state — e.g.
   * the booted-devices resource reading `getCachedSupportedCommands()` — use this
   * so listing devices never spins up a client or reserves a port as a side effect.
   */
  public static getExistingInstance(deviceId: string): IOSCtrlProxyClient | null {
    return IOSCtrlProxyClient.instances.get(deviceId) ?? null;
  }

  /**
   * Build a throwaway client that is NOT registered in the singleton map. Used by
   * short-lived diagnostics (doctor) that must open a connection, read, and close
   * without leaving anything behind: because it is never cached, a later
   * `getExistingInstance` can't rediscover a closed probe and mistake it for a
   * live session (which would reconnect and leak the socket/SDK polling timer).
   * Identical to `getInstance` otherwise — same port allocation and production
   * defaults — just unregistered.
   */
  public static createDetached(device: BootedDevice): IOSCtrlProxyClient {
    requireBootedDevice(device, "IOSCtrlProxyClient.createDetached");
    const port = device.platform === "ios"
      ? PortManager.allocate(device.deviceId, { reservedPorts: IOS_CTRL_PROXY_RESERVED_PORTS })
      : IOSCtrlProxyClient.DEFAULT_PORT;
    return new IOSCtrlProxyClient(device, port);
  }

  /**
   * Diagnostic accessor for doctor: reports the host port this client will use
   * for the runner WebSocket without opening any additional connection.
   */
  public getConnectionPortForDiagnostics(): number {
    return this.port;
  }

  /**
   * Bind this client to a session for multi-agent NavigationGraphManager isolation.
   */
  public bindSession(sessionId: string): void {
    if (this.boundSessionId !== sessionId) {
      this.boundSessionId = sessionId;
      // Invalidate cached hierarchy detector so it picks up the new session's NavigationGraphManager
      if (this.hierarchyNavigationDetector) {
        this.hierarchyNavigationDetector.dispose();
        this.hierarchyNavigationDetector = null;
      }
    }
  }

  /**
   * Get the NavigationGraphManager for the bound session, or the global singleton.
   */
  private getNavigationGraphManager(): NavigationGraphManager {
    return this.boundSessionId
      ? NavigationGraphManager.getInstanceForSession(this.boundSessionId)
      : NavigationGraphManager.getInstance();
  }

  /**
   * Create instance for testing with injected dependencies
   */
  public static createForTesting(
    device: BootedDevice,
    port: number,
    wsFactory: WebSocketFactory,
    timer: Timer,
    serviceManagerFactory: ServiceManagerFactory = noOpServiceManagerFactory,
    bootedDeviceLister?: BootedDeviceLister,
    deviceConnectionLostNotifier?: DeviceConnectionLostNotifier
  ): IOSCtrlProxyClient {
    // Default test lister always reports the device as booted so existing tests
    // are unaffected. Tests that verify boot-check behavior supply their own lister.
    const lister = bootedDeviceLister ?? (async () => [device]);
    return new IOSCtrlProxyClient(
      device,
      port,
      wsFactory,
      timer,
      serviceManagerFactory,
      lister,
      deviceConnectionLostNotifier
    );
  }

  /**
   * Reset all instances (for testing)
   */
  public static resetInstances(): void {
    for (const instance of IOSCtrlProxyClient.instances.values()) {
      void instance.close();
    }
    IOSCtrlProxyClient.instances.clear();
  }

  // ===========================================================================
  // Auto-setup on connection failure
  // ===========================================================================

  /**
   * Override ensureConnected to automatically set up CtrlProxy when
   * the WebSocket connection fails. This covers all tool calls (observe, tap, etc.).
   */
  public override async ensureConnected(
    perf: PerformanceTracker = new NoOpPerformanceTracker()
  ): Promise<boolean> {
    const connected = await super.ensureConnected(perf);
    if (connected) {
      return true;
    }

    if (this.getReconnectStatus()) {
      return false;
    }

    // Prevent re-entry during auto-setup
    if (this.isAttemptingAutoSetup) {
      return false;
    }

    this.isAttemptingAutoSetup = true;
    try {
      const manager = this.serviceManagerFactory(this.device);

      // If the service is already running (health endpoint responds), the WebSocket
      // failure is transient (e.g. service just restarted by hot-reload). Skip the
      // full setup/download cycle — just reset attempts and retry the connection.
      const alreadyRunning = await manager.isRunning();
      if (alreadyRunning) {
        logger.info(`[IOSCtrlProxyClient] Service is running but WebSocket failed — transient issue, retrying connection`);
        this.syncPortFromManager(manager);
        this.connectionAttempts = 0;
        return await super.ensureConnected(perf);
      }

      // Check if the target simulator is still booted before attempting auto-setup.
      // Without this check, xcodebuild test-without-building will re-boot the simulator
      // as a side effect, causing phantom simulators.
      try {
        const bootedDevices = await this.bootedDeviceLister();
        const stillBooted = bootedDevices.some(d => d.deviceId === this.device.deviceId);
        if (!stillBooted) {
          logger.info(`[IOSCtrlProxyClient] Target simulator ${this.device.deviceId} is no longer booted, skipping auto-setup`);
          return false;
        }
      } catch (error) {
        logger.warn(`[IOSCtrlProxyClient] Failed to check simulator boot state: ${error}`);
        // Proceed with auto-setup on failure to check — better to attempt than to silently skip
      }

      logger.info(`[IOSCtrlProxyClient] WebSocket connection failed, attempting auto-setup of CtrlProxy`);
      const result = await manager.setup(true, perf);

      if (!result.success) {
        logger.warn(`[IOSCtrlProxyClient] Auto-setup failed: ${result.message}`);
        return false;
      }

      this.syncPortFromManager(manager);

      logger.info(`[IOSCtrlProxyClient] Auto-setup succeeded, retrying WebSocket connection`);
      // Reset connection attempts to allow fresh connection attempts
      this.connectionAttempts = 0;
      return await super.ensureConnected(perf);
    } catch (error) {
      logger.warn(`[IOSCtrlProxyClient] Auto-setup error: ${error}`);
      return false;
    } finally {
      this.isAttemptingAutoSetup = false;
    }
  }

  private syncPortFromManager(manager: CtrlProxyIosManager): void {
    this.updatePort(manager.getServicePort());
  }

  private updatePort(port: number): void {
    if (port !== this.port) {
      logger.info(`[IOSCtrlProxyClient] CtrlProxy service port changed from ${this.port} to ${port}`);
      this.port = port;
      if (this.ws) {
        logger.info("[IOSCtrlProxyClient] Closing stale WebSocket after CtrlProxy service port change");
        const staleSocket = this.ws;
        this.ws = null;
        this.stopHealthCheck();
        this.requestManager.cancelAll(new Error("CtrlProxy service port changed"));
        staleSocket.removeAllListeners();
        staleSocket.close();
      }
    }
  }

  // ===========================================================================
  // Delegate Context Factories
  // ===========================================================================

  private createDelegateContext(): DelegateContext {
    return {
      getWebSocket: () => this.ws,
      requestManager: this.requestManager,
      timer: this.timer,
      ensureConnected: perf => this.ensureConnected(perf),
      getReconnectStatus: () => this.getReconnectStatus(),
      isCommandSupported: messageType => this.isCommandSupported(messageType),
      unsupportedCommandError: messageType => this.buildUnsupportedCommandError(messageType),
      cancelScreenshotBackoff: () => this.cancelScreenshotBackoff(),
    };
  }

  private createHierarchyDelegateContext(): HierarchyDelegateContext {
    return {
      ...this.createDelegateContext(),
      cacheFreshTtlMs: IOSCtrlProxyClient.CACHE_FRESH_TTL_MS,
      getCachedHierarchy: () => this.cachedHierarchy,
      setCachedHierarchy: h => { this.cachedHierarchy = h; },
      suppressHierarchyObservationStreamPush: (requestId, timeoutMs) =>
        this.suppressHierarchyObservationStreamPush(requestId, timeoutMs),
    };
  }

  // ===========================================================================
  // Delegate Getters (lazy initialization)
  // ===========================================================================

  private get gestures(): CtrlProxyGestures {
    if (!this._gestures) {
      this._gestures = new CtrlProxyGestures(this.createDelegateContext());
    }
    return this._gestures;
  }

  private get text(): CtrlProxyText {
    if (!this._text) {
      this._text = new CtrlProxyText(this.createDelegateContext());
    }
    return this._text;
  }

  private get hierarchy(): CtrlProxyHierarchy {
    if (!this._hierarchy) {
      this._hierarchy = new CtrlProxyHierarchy(this.createHierarchyDelegateContext());
    }
    return this._hierarchy;
  }

  private get screenshot(): CtrlProxyScreenshot {
    if (!this._screenshot) {
      this._screenshot = new CtrlProxyScreenshot(this.createDelegateContext());
    }
    return this._screenshot;
  }

  private get navigation(): CtrlProxyNavigation {
    if (!this._navigation) {
      this._navigation = new CtrlProxyNavigation(this.createDelegateContext());
    }
    return this._navigation;
  }

  private get clipboard(): CtrlProxyClipboard {
    if (!this._clipboard) {
      this._clipboard = new CtrlProxyClipboard(this.createDelegateContext());
    }
    return this._clipboard;
  }

  private get voiceOver(): CtrlProxyVoiceOver {
    if (!this._voiceOver) {
      this._voiceOver = new CtrlProxyVoiceOver(this.createDelegateContext());
    }
    return this._voiceOver;
  }

  private get storage(): CtrlProxyStorage {
    if (!this._storage) {
      this._storage = new CtrlProxyStorage(this.createDelegateContext());
    }
    return this._storage;
  }

  private get keyboard(): CtrlProxyKeyboard {
    if (!this._keyboard) {
      this._keyboard = new CtrlProxyKeyboard(this.createDelegateContext());
    }
    return this._keyboard;
  }

  private get highlights(): CtrlProxyHighlights {
    if (!this._highlights) {
      this._highlights = new CtrlProxyHighlights(this.createDelegateContext());
    }
    return this._highlights;
  }

  private get database(): CtrlProxyDatabase {
    if (!this._database) {
      this._database = new CtrlProxyDatabase(this.createDelegateContext());
    }
    return this._database;
  }

  // ===========================================================================
  // DeviceServiceClient abstract method implementations
  // ===========================================================================

  protected getWebSocketUrl(): string {
    const wsHost = this.resolveWebSocketHost();
    return `ws://${wsHost}:${this.port}/ws`;
  }

  protected handleMessage(data: WebSocket.Data): void {
    try {
      const message = JSON.parse(data.toString()) as WebSocketMessage;
      this.processMessage(message);
    } catch (error) {
      logger.warn(`[IOSCtrlProxyClient] Failed to parse message: ${error}`);
    }
  }

  private sdkEventPollInterval: ReturnType<typeof setInterval> | null = null;

  protected onConnectionEstablished(): void {
    // Reset failure counter on successful connection
    this.consecutiveConnectionFailures = 0;
    this.isRequestingServiceRestart = false;
    logger.info(`[IOSCtrlProxyClient] Connection established, reset failure counter`);

    this.syncNetworkMockRulesToDevice();

    // Start polling for SDK events from the CtrlProxy HTTP endpoint
    this.startSdkEventPolling();

    // Resume the screenshot keepalive after a (re)connect. onConnectionClosed()
    // cancels it; without restarting here, a transient drop on a STATIC screen
    // leaves the live view frozen forever. Subscriber-gated and idempotent.
    this.startScreenshotBackoff();
  }

  private syncNetworkMockRulesToDevice(): void {
    if (!serverConfig.isNetworkMockableEnabled()) {
      return;
    }

    try {
      // Always sync mock rules on reconnect. Sending an empty list clears
      // stale rules that may linger in the iOS SDK after a CtrlProxy restart.
      const rules = buildNetworkMockRules(NetworkState.getInstance());
      this.sendMessage(JSON.stringify({ type: "set_network_mock_rules", rules }));
    } catch (e) {
      logger.warn(`[IOSCtrlProxyClient] Failed to sync network mock rules on reconnect: ${e}`);
    }
  }

  protected onConnectionClosed(): void {
    this.cancelScreenshotBackoff();
    this.stopSdkEventPolling();
    this.cachedHierarchy = null;
    this.supportedCommands = null;
    this.deviceConnectionLostNotifier.onDeviceConnectionLost(this.device.deviceId);

    if (this.hierarchyNavigationDetector) {
      this.hierarchyNavigationDetector.dispose();
      this.hierarchyNavigationDetector = null;
    }

    // Track connection failure and potentially trigger service restart
    this.consecutiveConnectionFailures++;
    logger.info(`[IOSCtrlProxyClient] Connection closed (failure count: ${this.consecutiveConnectionFailures})`);

    if (this.consecutiveConnectionFailures > 0 &&
        this.consecutiveConnectionFailures % IOSCtrlProxyClient.MAX_FAILURES_BEFORE_RESTART === 0 &&
        !this.isRequestingServiceRestart) {
      this.triggerServiceRestart();
    }
  }

  private startSdkEventPolling(): void {
    this.stopSdkEventPolling();
    const host = this.resolveWebSocketHost();
    const url = `http://${host}:${this.port}/sdk-events`;
    this.sdkEventPollInterval = this.timer.setInterval(async () => {
      try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(2000) });
        if (!resp.ok) {return;}
        const batches = await resp.json() as Array<{
          bundleId?: string;
          events?: Array<{ eventType: string; payload: string }>;
        }>;
        for (const batch of batches) {
          if (!batch.events) {continue;}
          for (const envelope of batch.events) {
            try {
              // SDK envelopes have base64-encoded payload
              const payloadJson = Buffer.from(envelope.payload, "base64").toString("utf-8");
              const payload = JSON.parse(payloadJson) as Record<string, unknown>;
              const timestamp = (payload.timestamp as number) ?? Date.now();
              await this.recordSdkEvent(
                { type: envelope.eventType, timestamp, payload },
                batch.bundleId ?? null,
              );
            } catch { /* skip malformed */ }
          }
        }
      } catch {
        // Polling failure is non-fatal
      }
    }, 2000);
  }

  private stopSdkEventPolling(): void {
    if (this.sdkEventPollInterval) {
      this.timer.clearInterval(this.sdkEventPollInterval);
      this.sdkEventPollInterval = null;
    }
  }

  private async recordSdkEvent(event: { type: string; timestamp: number; payload: Record<string, unknown> }, applicationId: string | null): Promise<void> {
    try {
      const recorder = TelemetryRecorder.getInstance();
      // Save and restore context to avoid race with Android device context
      const prevContext = recorder.getContext();
      recorder.setContext(this.device.deviceId, null);
      const ts = event.timestamp;
      const p = event.payload;

      try {
        switch (event.type) {
          case "network_request":
            await recorder.recordNetworkEvent({
              timestamp: ts, applicationId,
              url: (p.url as string) ?? "", method: (p.method as string) ?? "GET",
              statusCode: (p.statusCode as number) ?? 0, durationMs: (p.durationMs as number) ?? 0,
              requestBodySize: (p.requestBodySize as number) ?? -1, responseBodySize: (p.responseBodySize as number) ?? -1,
              protocol: (p.protocol as string) ?? null, host: (p.host as string) ?? null,
              path: (p.path as string) ?? null, error: (p.error as string) ?? null,
              requestHeaders: (p.requestHeaders as Record<string, string>) ?? null,
              responseHeaders: (p.responseHeaders as Record<string, string>) ?? null,
              requestBody: (p.requestBody as string) ?? null, responseBody: (p.responseBody as string) ?? null,
              contentType: (p.contentType as string) ?? null,
            });
            break;
          case "log":
            await recorder.recordLogEvent({
              timestamp: ts, applicationId,
              level: (p.level as number) ?? 0, tag: (p.tag as string) ?? "",
              message: (p.message as string) ?? "", filterName: (p.filterName as string) ?? "",
            });
            break;
          case "lifecycle":
            await recorder.recordOsEvent({
              timestamp: ts, applicationId,
              category: "lifecycle", kind: (p.state as string) ?? "unknown",
              details: { state: (p.state as string) ?? "", bundleId: (p.bundleId as string) ?? "" },
            });
            break;
          case "navigation": {
            const destination = (p.destination as string) ?? "unknown";
            const navSource = (p.source as string) ?? null;
            const navArgs = (p.arguments as Record<string, string>) ?? null;
            const navMeta = (p.metadata as Record<string, string>) ?? null;
            let screenshotUri: string | null = null;
            if (applicationId && destination) {
              await this.getNavigationGraphManager().recordNavigationEvent({
                applicationId, destination, source: navSource,
                arguments: navArgs ?? {}, metadata: navMeta ?? {},
                triggeringInteraction: null,
              });

              if (serverConfig.isNavigationScreenshotsEnabled()) {
                try {
                  const path = await this.captureNavigationScreenshot(applicationId, destination);
                  if (path) {
                    await this.getNavigationGraphManager().updateNodeScreenshot(applicationId, destination, path);
                    try {
                      const { getDatabase } = await import("../../../db");
                      const db = getDatabase();
                      const node = await db
                        .selectFrom("navigation_nodes")
                        .select(["id"])
                        .where("app_id", "=", applicationId)
                        .where("screen_name", "=", destination)
                        .executeTakeFirst();
                      if (node) {
                        screenshotUri = `automobile:navigation/nodes/${node.id}/screenshot`;
                      }
                    } catch { /* non-fatal */ }
                  }
                } catch { /* non-fatal */ }
              }
            }
            await recorder.recordNavigationEvent({
              timestamp: ts, applicationId,
              destination, source: navSource, arguments: navArgs, metadata: navMeta,
              screenshotUri,
            });
            break;
          }
          case "custom": {
            // Custom events are merged into log events
            const customName = (p.name as string) ?? "custom";
            const customProps = (p.properties as Record<string, string>) ?? {};
            const propsStr = Object.keys(customProps).length > 0 ? ` ${JSON.stringify(customProps)}` : "";
            await recorder.recordLogEvent({
              timestamp: ts, applicationId,
              level: 4, tag: "CustomEvent", message: `${customName}${propsStr}`, filterName: "custom",
            });
            break;
          }
          case "handled_exception": {
            const failureRecorder = getFailureRecorder();
            const exType = (p.exceptionClass as string) ?? (p.errorDomain as string) ?? "unknown";
            const exMsg = (p.exceptionMessage as string) ?? (p.message as string) ?? "Handled exception";
            const stackStr = (p.stackTrace as string) ?? "";
            const stackFrames = stackStr.split("\n").filter(Boolean).map(line => ({
              className: "", methodName: line.trim(), fileName: null as string | null, lineNumber: null as number | null,
              isAppCode: line.includes(applicationId ?? ""),
            }));
            await failureRecorder.recordNonFatal({
              exceptionType: exType, exceptionMessage: exMsg,
              stackTrace: stackFrames,
              customMessage: (p.customMessage as string) ?? undefined,
              deviceId: this.device.deviceId,
              deviceModel: "iOS Simulator", os: "iOS",
              appVersion: "1.0", sessionId: `ios-${this.device.deviceId}-${ts}`,
              currentScreen: (p.currentScreen as string) ?? (p.screen as string) ?? undefined,
            });
            break;
          }
          case "crash": {
            const crashRecorder = getFailureRecorder();
            const crashType = (p.exceptionClass as string) ?? (p.errorDomain as string) ?? "unknown";
            const crashMsg = (p.exceptionMessage as string) ?? (p.message as string) ?? "Crash";
            const crashStack = ((p.stackTrace as string) ?? "").split("\n").filter(Boolean).map(line => ({
              className: "", methodName: line.trim(), fileName: null as string | null, lineNumber: null as number | null,
              isAppCode: line.includes(applicationId ?? ""),
            }));
            await crashRecorder.recordCrash({
              exceptionType: crashType, exceptionMessage: crashMsg,
              stackTrace: crashStack,
              deviceId: this.device.deviceId,
              deviceModel: "iOS Simulator", os: "iOS",
              appVersion: "1.0", sessionId: `ios-${this.device.deviceId}-${ts}`,
              currentScreen: (p.currentScreen as string) ?? (p.screen as string) ?? undefined,
            });
            break;
          }
          case "hang":
            await recorder.recordOsEvent({
              timestamp: ts, applicationId,
              category: "hang", kind: `${(p.durationMs as number) ?? 0}ms`,
              details: { durationMs: String((p.durationMs as number) ?? 0) },
            });
            break;
          case "storage_changed":
            await recorder.recordStorageEvent({
              timestamp: ts, applicationId,
              fileName: (p.suiteName as string) ?? "", key: (p.key as string) ?? "",
              value: (p.value as string) ?? "", operation: (p.operation as string) ?? "write",
            });
            break;
          default:
          // Record unknown types as log events
            await recorder.recordLogEvent({
              timestamp: ts, applicationId,
              level: 4, tag: "UnknownEvent", message: `${event.type}: ${JSON.stringify(p).substring(0, 1000)}`, filterName: "custom",
            });
        }
      } finally {
        // Restore previous context so Android events aren't affected
        recorder.setContext(prevContext.deviceId, prevContext.sessionId);
      }
    } catch {
      // Non-fatal
    }
  }

  /** Capture and store a screenshot for an iOS navigation event. Returns the stored path or null. */
  private async captureNavigationScreenshot(applicationId: string, destination: string): Promise<string | null> {
    try {
      const result = await this.requestScreenshot(3000);
      if (result?.data) {
        const screenshotManager = NavigationScreenshotManager.getInstance();
        const bytes = Buffer.from(result.data, "base64");
        return await screenshotManager.storeScreenshot(applicationId, destination, bytes, result.format ?? "png");
      }
    } catch (error) {
      logger.debug(`[IOSCtrlProxyClient] iOS nav screenshot capture skipped: ${error}`);
    }
    return null;
  }

  /** Record a layout telemetry event from converted iOS hierarchy (ViewHierarchyResult format) */
  private recordLayoutTelemetryEvent(hierarchy: ViewHierarchyResult): void {
    try {
      const recorder = TelemetryRecorder.getInstance();
      const prevContext = recorder.getContext();
      recorder.setContext(this.device.deviceId, null);
      const nodeCount = this.countViewHierarchyNodes(hierarchy.hierarchy);
      // Use the converted ViewHierarchyResult format — same data as the observation stream
      const hierarchyJson = JSON.stringify({
        nodeCount,
        packageName: hierarchy.packageName,
        hierarchy: hierarchy.hierarchy,
        windows: hierarchy.windows,
        updatedAt: hierarchy.updatedAt,
      });
      void recorder.recordLayoutEvent({
        timestamp: Date.now(),
        applicationId: hierarchy.packageName ?? null,
        subType: "hierarchy_change",
        composableName: null,
        composableId: null,
        recompositionCount: nodeCount,
        durationMs: null,
        likelyCause: null,
        detailsJson: hierarchyJson.length < 200000 ? hierarchyJson : JSON.stringify({ nodeCount, truncated: true }),
        screenName: hierarchy.packageName ?? null,
      });
      recorder.setContext(prevContext.deviceId, prevContext.sessionId);
    } catch {
      // Non-fatal — telemetry recording should never break observation
    }
  }

  private countViewHierarchyNodes(node: unknown): number {
    if (!node || typeof node !== "object") { return 0; }
    const obj = node as Record<string, unknown>;
    let count = 0;
    if (obj["$"] || obj["node"]) { count = 1; }
    const children = obj["node"];
    if (Array.isArray(children)) {
      for (const child of children) {
        count += this.countViewHierarchyNodes(child);
      }
    }
    return count;
  }

  /**
   * Trigger CtrlProxy restart through the manager.
   * This is called when repeated WebSocket connection failures indicate
   * that the CtrlProxy process may have crashed.
   */
  private triggerServiceRestart(): void {
    if (this.isRequestingServiceRestart) {
      return;
    }

    this.isRequestingServiceRestart = true;
    logger.info(`[IOSCtrlProxyClient] Triggering CtrlProxy restart after ${this.consecutiveConnectionFailures} connection failures`);

    const manager = this.serviceManagerFactory(this.device);

    // Check if service is actually not running before restarting
    void manager.isRunning().then(running => {
      if (!running) {
        logger.info(`[IOSCtrlProxyClient] CtrlProxy not running, requesting restart`);
        void manager.forceRestart().then(() => {
          logger.info(`[IOSCtrlProxyClient] CtrlProxy restart completed`);
          this.consecutiveConnectionFailures = 0;
          this.isRequestingServiceRestart = false;
        }).catch(error => {
          logger.warn(`[IOSCtrlProxyClient] CtrlProxy restart failed: ${error}`);
          this.isRequestingServiceRestart = false;
        });
      } else {
        logger.info(`[IOSCtrlProxyClient] CtrlProxy is running, connection issue may be transient`);
        this.isRequestingServiceRestart = false;
      }
    }).catch(error => {
      logger.warn(`[IOSCtrlProxyClient] Failed to check CtrlProxy status: ${error}`);
      this.isRequestingServiceRestart = false;
    });
  }

  protected async setupBeforeConnect(_perf: PerformanceTracker): Promise<void> {
    // No port forwarding needed for iOS simulator
    // For real devices, iproxy may be needed in the future
  }

  // ===========================================================================
  // Platform-specific methods
  // ===========================================================================

  private resolveWebSocketHost(): string {
    if (shouldUseHostControl() && isRunningInDocker()) {
      return getHostControlHost();
    }
    return "localhost";
  }

  private processMessage(message: WebSocketMessage): void {
    const { type, requestId } = message;

    // Handle push messages (no requestId)
    if (type === "connected") {
      this.supportedCommands = Array.isArray(message.supportedCommands)
        ? new Set(message.supportedCommands)
        : null;
      logger.info(`[IOSCtrlProxyClient] Received connected message`);
      return;
    }

    if (type === "hierarchy_update" && message.data) {
      this.handleHierarchyUpdateForNavigation(message.data, message.perfTiming);
      // Record layout telemetry event using converted hierarchy (same format as observation stream)
      const converted = this.convertToViewHierarchyResult(message.data);
      this.recordLayoutTelemetryEvent(converted);
      // Only push to observation stream for request-response updates (with requestId).
      // Push messages (no requestId) are handled in the dedicated push-message branch below
      // to avoid duplicate hierarchy events.
      if (requestId) {
        const suppressObservationStreamPush = this.consumeHierarchyObservationStreamSuppression(requestId);
        if (!suppressObservationStreamPush) {
          this.pushHierarchyToObservationStream(converted);
        } else {
          logger.debug("[IOSCtrlProxyClient] Suppressed hierarchy observation stream push for explicit initial-frame request");
        }
      }
    }

    // Handle request/response messages (with requestId) first
    if (requestId) {
      // Build result based on message type
      let result: unknown;

      switch (type) {
        case "hierarchy_update":
          result = {
            hierarchy: message.data,
            perfTiming: message.perfTiming
          };
          break;

        case "screenshot":
          result = {
            success: true,
            data: message.data,
            format: message.format ?? "png",
            timestamp: message.timestamp
          };
          break;

        case "tap_coordinates_result":
        case "swipe_result":
        case "drag_result":
        case "pinch_result":
        case "set_text_result":
        case "clear_text_result":
        case "select_all_result":
        case "press_button_result":
        case "press_home_result":
        case "press_back_result":
        case "recent_apps_result":
        case "launch_app_result":
          result = {
            success: message.success ?? true,
            totalTimeMs: message.totalTimeMs ?? 0,
            error: message.error,
            perfTiming: message.perfTiming
          };
          break;

        case "keyboard_result":
          result = {
            success: message.success ?? true,
            open: message.open ?? false,
            totalTimeMs: message.totalTimeMs ?? 0,
            error: message.error,
            perfTiming: message.perfTiming
          };
          break;

        case "rotate_result":
          result = {
            success: message.success ?? true,
            totalTimeMs: message.totalTimeMs ?? 0,
            error: message.error,
            perfTiming: message.perfTiming,
            previousOrientation: message.previousOrientation ?? "",
            currentOrientation: message.currentOrientation ?? "",
            value: message.value ?? 0,
            rotationPerformed: message.rotationPerformed ?? false,
          };
          break;

        case "ime_action_result":
        case "action_result":
          result = {
            success: message.success ?? true,
            action: (message as { action?: string }).action,
            totalTimeMs: message.totalTimeMs ?? 0,
            error: message.error,
            perfTiming: message.perfTiming
          };
          break;

        case "voiceover_state_result":
          result = {
            success: message.success ?? true,
            enabled: (message as { enabled?: boolean }).enabled ?? false,
            totalTimeMs: message.totalTimeMs ?? 0,
            error: message.error,
          };
          break;

        case "voiceover_action_result":
          result = {
            success: message.success ?? true,
            action: (message as { action?: string }).action,
            totalTimeMs: message.totalTimeMs ?? 0,
            error: message.error,
          };
          break;

        case "highlight_response":
          result = {
            success: message.success ?? false,
            totalTimeMs: message.totalTimeMs ?? 0,
            error: message.error,
            requestId,
            timestamp: message.timestamp,
          };
          break;

        case "multi_finger_swipe_result":
          result = {
            success: message.success ?? true,
            totalTimeMs: message.totalTimeMs ?? 0,
            error: message.error,
            perfTiming: message.perfTiming
          };
          break;

        case "clipboard_result":
          result = {
            success: message.success ?? true,
            action: (message as { action?: string }).action ?? "",
            text: (message as { text?: string }).text,
            totalTimeMs: message.totalTimeMs ?? 0,
            error: message.error,
          };
          break;

        // Storage response types (matching Android wire protocol)
        case "preference_files":
          result = {
            success: message.success ?? false,
            files: (message as { files?: unknown[] }).files || [],
            totalTimeMs: message.totalTimeMs ?? 0,
            error: message.error,
          };
          break;

        case "preferences":
          result = {
            success: message.success ?? false,
            entries: (message as { entries?: unknown[] }).entries || [],
            totalTimeMs: message.totalTimeMs ?? 0,
            error: message.error,
          };
          break;

        case "get_preference_result": {
          const msg = message as { found?: boolean; key?: string; value?: string; valueType?: string };
          const entry = msg.found && msg.key ? {
            key: msg.key,
            value: msg.value ?? null,
            type: msg.valueType ?? "UNKNOWN",
          } : undefined;
          result = {
            success: message.success ?? false,
            found: msg.found ?? false,
            entry,
            totalTimeMs: message.totalTimeMs ?? 0,
            error: message.error,
          };
          break;
        }

        case "set_preference_result":
        case "remove_preference_result":
        case "clear_preferences_result":
          result = {
            success: message.success ?? false,
            totalTimeMs: message.totalTimeMs ?? 0,
            error: message.error,
          };
          break;

        case "execute_sql_result":
          result = {
            success: message.success ?? false,
            queryType: (message as { queryType?: string }).queryType,
            columns: (message as { columns?: string[] }).columns,
            rows: (message as { rows?: unknown[][] }).rows,
            rowsAffected: (message as { rowsAffected?: number }).rowsAffected,
            totalTimeMs: message.totalTimeMs ?? 0,
            error: message.error,
          };
          break;

        case "list_databases_result":
          result = {
            success: message.success ?? false,
            databases: (message as { databases?: unknown[] }).databases ?? [],
            totalTimeMs: message.totalTimeMs ?? 0,
            error: message.error,
          };
          break;

        case "list_tables_result":
          result = {
            success: message.success ?? false,
            tables: (message as { tables?: string[] }).tables ?? [],
            totalTimeMs: message.totalTimeMs ?? 0,
            error: message.error,
          };
          break;

        case "table_data_result":
          result = {
            success: message.success ?? false,
            columns: (message as { columns?: string[] }).columns ?? [],
            rows: (message as { rows?: unknown[][] }).rows ?? [],
            total: (message as { total?: number }).total ?? 0,
            totalTimeMs: message.totalTimeMs ?? 0,
            error: message.error,
          };
          break;

        case "table_structure_result":
          result = {
            success: message.success ?? false,
            columns: (message as { columns?: unknown[] }).columns ?? [],
            totalTimeMs: message.totalTimeMs ?? 0,
            error: message.error,
          };
          break;

        default:
          // Handle error responses
          if (message.error) {
            this.requestManager.resolveError(
              requestId,
              this.rewriteUnknownCommandError(message.error),
              message.totalTimeMs ?? 0
            );
            return;
          } else {
            result = message;
          }
      }

      this.requestManager.resolve(requestId, result);
      return;
    }

    // Handle push messages (no requestId)
    if (type === "hierarchy_update" && message.data) {
      // Push update from server
      const now = this.timer.now();
      this.cachedHierarchy = {
        hierarchy: message.data,
        receivedAt: now,
        fresh: true,
        perfTiming: message.perfTiming as CtrlProxyPerfTiming | undefined
      };
      logger.info(`[IOSCtrlProxyClient] Received hierarchy push update - UI changed`);

      // Convert and push to observation stream for IDE plugins
      const viewHierarchyResult = this.convertToViewHierarchyResult(message.data);
      this.pushHierarchyToObservationStream(viewHierarchyResult);

      // Start screenshot backoff sequence for real-time screenshot streaming
      this.startScreenshotBackoff();

      // Performance monitoring is handled in handleHierarchyUpdateForNavigation
      // which runs for ALL hierarchy_update messages (both push and request-response)

      // Notify listeners (e.g., ObserveScreen to clear its cache)
      this.notifyPushUpdateListeners(message.data);
      return;
    }

    // Handle performance update push messages from CADisplayLink FPS monitoring
    if (type === "performance_update") {
      if (message.performanceData) {
        this.handlePerformanceUpdate(message.performanceData);
      } else {
        logger.warn(`[IOSCtrlProxyClient] Received performance_update but no performanceData field`);
      }
      return;
    }
  }

  private isCommandSupported(messageType: string): boolean {
    return this.supportedCommands === null || this.supportedCommands.has(messageType);
  }

  /**
   * Runner-identity accessor for diagnostics (doctor). Connects if needed so the
   * `connected` handshake's `supportedCommands` set is available, then returns it
   * sorted. Returns null when the runner cannot be reached (no handshake), which
   * the caller surfaces as an `unknown` runner status rather than a false pass.
   */
  public async getSupportedCommands(): Promise<string[] | null> {
    if (this.supportedCommands === null) {
      const connected = await this.ensureConnected();
      // ensureConnected resolves on the WebSocket `open` event, but the runner's
      // `supportedCommands` arrive a beat later in the `connected` handshake
      // message. Without waiting for it, the first probe (e.g. doctor) of a
      // healthy runner reads null and misreports it as `unknown`. Poll briefly
      // for the handshake before reading.
      if (connected) {
        await this.waitForHandshake();
      }
    }
    return this.getCachedSupportedCommands();
  }

  private static readonly HANDSHAKE_WAIT_TIMEOUT_MS = 2000;
  private static readonly HANDSHAKE_POLL_INTERVAL_MS = 50;

  private async waitForHandshake(
    timeoutMs: number = IOSCtrlProxyClient.HANDSHAKE_WAIT_TIMEOUT_MS
  ): Promise<void> {
    const deadline = this.timer.now() + timeoutMs;
    while (this.supportedCommands === null && this.timer.now() < deadline) {
      await this.timer.sleep(IOSCtrlProxyClient.HANDSHAKE_POLL_INTERVAL_MS);
    }
  }

  /**
   * Cheap, connection-free view of the last advertised command set. Used by the
   * booted-devices resource hot path, which must not open a WebSocket just to
   * report status. Returns null when no handshake has been seen.
   */
  public getCachedSupportedCommands(): string[] | null {
    return this.supportedCommands === null ? null : Array.from(this.supportedCommands).sort();
  }

  private buildUnsupportedCommandError(messageType: string): string {
    return `iOS CtrlProxy runner does not support ${messageType}. The daemon and runner are out of sync; rebuild and redeploy the iOS CtrlProxy runner from this source checkout, or run the iOS hot-reload watcher with --manage-ios-runner.`;
  }

  private rewriteUnknownCommandError(error: string): string {
    const match = /^Unknown command type: (.+)$/.exec(error);
    if (!match) {
      return error;
    }
    return `iOS CtrlProxy runner rejected ${match[1]} as unknown. The runner is likely older than this daemon; rebuild and redeploy the iOS CtrlProxy runner from this source checkout, or run the iOS hot-reload watcher with --manage-ios-runner.`;
  }

  /**
   * Handle performance update push messages from iOS CtrlProxy.
   * Converts the iOS performance snapshot to PerformanceStreamData and pushes to IDE.
   */
  private handlePerformanceUpdate(snapshot: CtrlProxyPerformanceSnapshot): void {
    const server = getDeviceDataStreamServer();
    if (!server) {
      return;
    }

    // Convert iOS performance snapshot to PerformanceStreamData format
    const streamData: PerformanceStreamData = {
      fps: snapshot.fps ?? 0,
      frameTimeMs: snapshot.frameTimeMs ?? 0,
      jankFrames: snapshot.jankFrames ?? 0,
      droppedFrames: 0, // iOS doesn't report this separately
      memoryUsageMb: snapshot.memoryUsageMb ?? 0,
      cpuUsagePercent: snapshot.cpuUsagePercent ?? 0,
      touchLatencyMs: snapshot.touchLatencyMs ?? null,
      timeToInteractiveMs: snapshot.ttiMs ?? null,
      screenName: snapshot.screenName ?? null,
      isResponsive: (snapshot.fps ?? 0) >= 50, // Consider responsive if FPS >= 50
    };

    try {
      server.pushPerformanceUpdate(this.device.deviceId, streamData);
      // Log occasionally to avoid spam
      if (this.timer.now() % 5000 < 600) {
        logger.debug(`[IOSCtrlProxyClient] iOS FPS: ${streamData.fps.toFixed(1)}, frameTime: ${streamData.frameTimeMs.toFixed(1)}ms, memory: ${streamData.memoryUsageMb.toFixed(1)}MB`);
      }
    } catch (error) {
      logger.warn(`[IOSCtrlProxyClient] Failed to push performance update: ${error}`);
    }
  }

  // ===========================================================================
  // Delegated Public Methods - Hierarchy
  // ===========================================================================

  async getAccessibilityHierarchy(
    queryOptions?: ViewHierarchyQueryOptions,
    perf?: PerformanceTracker,
    skipWaitForFresh?: boolean,
    minTimestamp?: number,
    disableAllFiltering?: boolean
  ): Promise<ViewHierarchyResult | null> {
    return this.hierarchy.getAccessibilityHierarchy(queryOptions, perf, skipWaitForFresh, minTimestamp, disableAllFiltering);
  }

  async getLatestHierarchy(
    waitForFresh: boolean = false,
    timeout: number = 15000,
    perf?: PerformanceTracker,
    skipWaitForFresh: boolean = false,
    minTimestamp: number = 0
  ): Promise<CtrlProxyHierarchyResponse> {
    return this.hierarchy.getLatestHierarchy(waitForFresh, timeout, perf, skipWaitForFresh, minTimestamp);
  }

  async requestHierarchySync(
    perf?: PerformanceTracker,
    disableAllFiltering?: boolean,
    signal?: AbortSignal,
    timeoutMs: number = 5000
  ): Promise<{ hierarchy: CtrlProxyHierarchy; perfTiming?: CtrlProxyPerfTiming } | null> {
    return this.hierarchy.requestHierarchySync(perf, disableAllFiltering, signal, timeoutMs);
  }

  async requestHierarchySyncWithoutObservationStreamPush(
    perf?: PerformanceTracker,
    disableAllFiltering?: boolean,
    signal?: AbortSignal,
    timeoutMs: number = 5000
  ): Promise<{ hierarchy: CtrlProxyHierarchy; perfTiming?: CtrlProxyPerfTiming } | null> {
    return this.hierarchy.requestHierarchySync(perf, disableAllFiltering, signal, timeoutMs, true);
  }

  convertToViewHierarchyResult(hierarchy: CtrlProxyHierarchy): ViewHierarchyResult {
    return this.hierarchy.convertToViewHierarchyResult(hierarchy);
  }

  hasCachedHierarchy(): boolean {
    return this.hierarchy.hasCachedHierarchy();
  }

  invalidateCache(): void {
    return this.hierarchy.invalidateCache();
  }

  clearCache(): void {
    this.cachedHierarchy = null;
  }

  // ===========================================================================
  // Delegated Public Methods - Highlights
  // ===========================================================================

  async requestAddHighlight(
    id: string,
    shape: HighlightShape,
    timeoutMs: number = 5000,
    perf: PerformanceTracker = new NoOpPerformanceTracker()
  ): Promise<CtrlProxyHighlightResult> {
    return this.highlights.requestAddHighlight(id, shape, timeoutMs, perf);
  }

  // ===========================================================================
  // Delegated Public Methods - Gestures
  // ===========================================================================

  async requestTapCoordinates(
    x: number, y: number, duration: number = 0, timeoutMs: number = 5000, perf?: PerformanceTracker
  ): Promise<CtrlProxyTapResult> {
    return this.gestures.requestTapCoordinates(x, y, duration, timeoutMs, perf);
  }

  async requestSwipe(
    x1: number, y1: number, x2: number, y2: number,
    duration: number = 300, timeoutMs: number = 5000, perf?: PerformanceTracker
  ): Promise<CtrlProxySwipeResult> {
    return this.gestures.requestSwipe(x1, y1, x2, y2, duration, timeoutMs, perf);
  }

  async requestDrag(
    x1: number, y1: number, x2: number, y2: number,
    pressDurationMs: number, dragDurationMs: number, holdDurationMs: number, timeoutMs: number
  ): Promise<CtrlProxyDragResult> {
    return this.gestures.requestDrag(x1, y1, x2, y2, pressDurationMs, dragDurationMs, holdDurationMs, timeoutMs);
  }

  async requestPinch(
    centerX: number, centerY: number,
    distanceStart: number, distanceEnd: number, rotationDegrees: number,
    duration: number = 300, timeoutMs: number = 5000, perf?: PerformanceTracker
  ): Promise<CtrlProxyPinchResult> {
    return this.gestures.requestPinch(centerX, centerY, distanceStart, distanceEnd, rotationDegrees, duration, timeoutMs, perf);
  }

  // ===========================================================================
  // Delegated Public Methods - Text
  // ===========================================================================

  async requestSetText(
    text: string, options?: SetTextOptions
  ): Promise<CtrlProxySetTextResult> {
    return this.text.requestSetText(text, options);
  }

  async requestClearText(
    resourceId?: string, timeoutMs: number = 5000, perf?: PerformanceTracker
  ): Promise<CtrlProxySetTextResult> {
    return this.text.requestClearText(resourceId, timeoutMs, perf);
  }

  async requestImeAction(
    action: ImeAction,
    timeoutMs: number = 5000, perf?: PerformanceTracker
  ): Promise<CtrlProxyImeActionResult> {
    return this.text.requestImeAction(action, timeoutMs, perf);
  }

  async requestSelectAll(
    timeoutMs: number = 5000, perf?: PerformanceTracker
  ): Promise<CtrlProxySelectAllResult> {
    return this.text.requestSelectAll(timeoutMs, perf);
  }

  async requestKeyboard(
    action: "open" | "close" | "detect",
    timeoutMs: number = 5000,
    perf?: PerformanceTracker
  ): Promise<CtrlProxyKeyboardResult> {
    return this.keyboard.requestKeyboard(action, timeoutMs, perf);
  }

  // ===========================================================================
  // Delegated Public Methods - Navigation
  // ===========================================================================

  async requestPressHome(
    timeoutMs: number = 5000, perf?: PerformanceTracker
  ): Promise<CtrlProxyPressHomeResult> {
    return this.navigation.requestPressHome(timeoutMs, perf);
  }

  async requestPressBack(
    timeoutMs: number = 5000, perf?: PerformanceTracker
  ): Promise<CtrlProxyPressBackResult> {
    return this.navigation.requestPressBack(timeoutMs, perf);
  }

  async requestShake(
    timeoutMs: number = 5000, perf?: PerformanceTracker
  ): Promise<CtrlProxyShakeResult> {
    return this.navigation.requestShake(timeoutMs, perf);
  }

  async requestPressButton(
    button: string, timeoutMs: number = 5000, perf?: PerformanceTracker
  ): Promise<CtrlProxyPressButtonResult> {
    return this.navigation.requestPressButton(button, timeoutMs, perf);
  }

  async requestRecentApps(
    timeoutMs: number = 5000, perf?: PerformanceTracker
  ): Promise<CtrlProxyRecentAppsResult> {
    return this.navigation.requestRecentApps(timeoutMs, perf);
  }

  async requestRotate(
    orientation: string, timeoutMs: number = 5000, perf?: PerformanceTracker
  ): Promise<CtrlProxyRotateResult> {
    return this.navigation.requestRotate(orientation, timeoutMs, perf);
  }

  async requestLaunchApp(
    bundleId: string, timeoutMs: number = 10000, perf?: PerformanceTracker, coldBoot: boolean = false
  ): Promise<CtrlProxyLaunchAppResult> {
    return this.navigation.requestLaunchApp(bundleId, timeoutMs, perf, coldBoot);
  }

  // ===========================================================================
  // Delegated Public Methods - Clipboard
  // ===========================================================================

  async requestClipboard(
    action: "copy" | "paste" | "clear" | "get",
    text?: string,
    timeoutMs: number = 5000,
    perf?: PerformanceTracker
  ): Promise<CtrlProxyClipboardResult> {
    return this.clipboard.requestClipboard(action, text, timeoutMs, perf);
  }

  // ===========================================================================
  // Delegated Public Methods - Screenshot
  // ===========================================================================

  async requestScreenshot(
    timeoutMs: number = 5000, perf?: PerformanceTracker
  ): Promise<CtrlProxyScreenshotResult> {
    return this.screenshot.requestScreenshot(timeoutMs, perf);
  }

  async requestScreenshotWithoutObservationStreamPush(
    timeoutMs: number = 5000, perf?: PerformanceTracker
  ): Promise<CtrlProxyScreenshotResult> {
    return this.requestScreenshot(timeoutMs, perf);
  }

  // ===========================================================================
  // Delegated Public Methods - VoiceOver
  // ===========================================================================

  async requestVoiceOverState(
    timeoutMs: number = 5000, perf?: PerformanceTracker
  ): Promise<CtrlProxyVoiceOverResult> {
    return this.voiceOver.requestVoiceOverState(timeoutMs, perf);
  }

  async requestVoiceOverActivate(
    label: string,
    action: "activate" | "long_press",
    timeoutMs: number = 5000,
    perf?: PerformanceTracker
  ): Promise<CtrlProxyVoiceOverActionResult> {
    return this.voiceOver.requestVoiceOverActivate(label, action, timeoutMs, perf);
  }

  async requestAction(
    action: string,
    resourceId?: string,
    label?: string,
    timeoutMs: number = 5000,
    perf?: PerformanceTracker
  ): Promise<CtrlProxyActionResult> {
    return this.voiceOver.requestAction(action, resourceId, label, timeoutMs, perf);
  }

  async requestMultiFingerSwipe(
    x1: number, y1: number, x2: number, y2: number,
    fingerCount: number,
    duration: number = 300,
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
    fingerSpacing?: number
  ): Promise<CtrlProxySwipeResult> {
    return this.gestures.requestMultiFingerSwipe(x1, y1, x2, y2, fingerCount, duration, timeoutMs, perf, fingerSpacing);
  }

  // ===========================================================================
  // Delegated Public Methods - Storage (UserDefaults)
  // ===========================================================================

  async listPreferenceFiles(packageName: string, timeoutMs: number = 5000): Promise<import("../../storage/storageTypes").PreferenceFile[]> {
    return this.storage.listPreferenceFiles(packageName, timeoutMs);
  }

  async getPreferenceEntries(packageName: string, fileName: string, timeoutMs: number = 5000): Promise<import("../../storage/storageTypes").KeyValueEntry[]> {
    return this.storage.getPreferenceEntries(packageName, fileName, timeoutMs);
  }

  async getPreference(packageName: string, fileName: string, key: string, timeoutMs: number = 5000): Promise<import("../../storage/storageTypes").KeyValueEntry | null> {
    return this.storage.getPreference(packageName, fileName, key, timeoutMs);
  }

  async setPreference(packageName: string, fileName: string, key: string, value: string | null, type: import("../../storage/storageTypes").KeyValueType, timeoutMs: number = 5000): Promise<void> {
    return this.storage.setPreference(packageName, fileName, key, value, type, timeoutMs);
  }

  async removePreference(packageName: string, fileName: string, key: string, timeoutMs: number = 5000): Promise<void> {
    return this.storage.removePreference(packageName, fileName, key, timeoutMs);
  }

  async clearPreferenceStore(packageName: string, fileName: string, timeoutMs: number = 5000): Promise<void> {
    return this.storage.clearPreferenceStore(packageName, fileName, timeoutMs);
  }

  // ===========================================================================
  // Delegated Public Methods - Database (SQLite)
  // ===========================================================================

  async executeSQLForIos(
    appId: string,
    databasePath: string,
    query: string,
    timeoutMs: number = 5000
  ): Promise<import("../../database/DatabaseInspector").SQLResult> {
    return this.database.executeSQL(appId, databasePath, query, timeoutMs);
  }

  async listDatabasesForIos(
    appId: string,
    timeoutMs: number = 5000
  ): Promise<import("../../database/DatabaseInspector").DatabaseInfo[]> {
    return this.database.listDatabases(appId, timeoutMs);
  }

  async listTablesForIos(appId: string, databasePath: string, timeoutMs: number = 5000): Promise<string[]> {
    return this.database.listTables(appId, databasePath, timeoutMs);
  }

  async getTableDataForIos(
    appId: string,
    databasePath: string,
    table: string,
    limit: number = 50,
    offset: number = 0,
    timeoutMs: number = 5000
  ): Promise<import("../../database/DatabaseInspector").TableDataResult> {
    return this.database.getTableData(appId, databasePath, table, limit, offset, timeoutMs);
  }

  async getTableStructureForIos(
    appId: string,
    databasePath: string,
    table: string,
    timeoutMs: number = 5000
  ): Promise<import("../../database/DatabaseInspector").TableStructureResult> {
    return this.database.getTableStructure(appId, databasePath, table, timeoutMs);
  }

  // ===========================================================================
  // Service Verification
  // ===========================================================================

  public async verifyServiceReady(
    maxAttempts: number = 3,
    delayMs: number = 1000,
    timeoutMs: number = 5000
  ): Promise<boolean> {
    for (let i = 0; i < maxAttempts; i++) {
      if (!await this.ensureConnected()) {
        await this.timer.sleep(delayMs);
        continue;
      }

      // Try to get hierarchy to verify service is working
      try {
        const result = await this.requestHierarchySync(undefined, false, undefined, timeoutMs);
        if (result?.hierarchy) {
          return true;
        }
      } catch {
        // Continue retrying
      }

      await this.timer.sleep(delayMs);
    }
    return false;
  }

  // ===========================================================================
  // Push Update Callbacks
  // ===========================================================================

  public onPushUpdate(callback: (hierarchy: CtrlProxyHierarchy) => void): () => void {
    this.onPushUpdateCallbacks.add(callback);
    return () => {
      this.onPushUpdateCallbacks.delete(callback);
    };
  }

  private notifyPushUpdateListeners(hierarchy: CtrlProxyHierarchy): void {
    for (const callback of this.onPushUpdateCallbacks) {
      try {
        callback(hierarchy);
      } catch (error) {
        logger.warn(`[IOSCtrlProxyClient] Push update callback error: ${error}`);
      }
    }
  }

  private suppressHierarchyObservationStreamPush(requestId: string, timeoutMs: number): void {
    const existingTimeout = this.hierarchyObservationStreamSuppressions.get(requestId);
    if (existingTimeout) {
      this.timer.clearTimeout(existingTimeout);
    }

    const timeoutHandle = this.timer.setTimeout(() => {
      this.hierarchyObservationStreamSuppressions.delete(requestId);
    }, timeoutMs);
    this.hierarchyObservationStreamSuppressions.set(requestId, timeoutHandle);
  }

  private consumeHierarchyObservationStreamSuppression(requestId: string): boolean {
    const timeoutHandle = this.hierarchyObservationStreamSuppressions.get(requestId);
    if (!timeoutHandle) {
      return false;
    }

    this.hierarchyObservationStreamSuppressions.delete(requestId);
    this.timer.clearTimeout(timeoutHandle);
    return true;
  }

  /**
   * Push hierarchy update to the device data stream for IDE plugins.
   */
  private pushHierarchyToObservationStream(hierarchy: ViewHierarchyResult): void {
    const server = getDeviceDataStreamServer();
    if (!server) {
      return;
    }

    try {
      server.pushHierarchyUpdate(this.device.deviceId, hierarchy);
    } catch (error) {
      logger.warn(`[IOSCtrlProxyClient] Failed to push hierarchy to observation stream: ${error}`);
    }
  }

  /**
   * Push screenshot update to the device data stream for IDE plugins.
   */
  private pushScreenshotToObservationStream(screenshotBase64: string, screenWidth: number, screenHeight: number): void {
    const server = getDeviceDataStreamServer();
    if (!server) {
      return;
    }

    try {
      server.pushScreenshotUpdate(this.device.deviceId, screenshotBase64, screenWidth, screenHeight);
    } catch (error) {
      logger.debug(`[IOSCtrlProxyClient] Failed to push screenshot to observation stream: ${error}`);
    }
  }

  // ===========================================================================
  // Screenshot Backoff for Real-time Streaming
  // ===========================================================================

  /**
   * Start screenshot backoff sequence for real-time screenshot streaming to IDE.
   * Called when a hierarchy push update is received to capture corresponding screenshots.
   */
  private startScreenshotBackoff(): void {
    const server = getDeviceDataStreamServer();
    if (!server || !server.hasSubscriberForDevice(this.device.deviceId)) {
      return;
    }

    const scheduler = this.getScreenshotBackoffScheduler();
    scheduler.startBackoffSequence();
  }

  private getScreenshotBackoffScheduler(): ScreenshotBackoffScheduler {
    if (!this.screenshotBackoffScheduler) {
      this.screenshotBackoffScheduler = new DefaultScreenshotBackoffScheduler(
        async (): Promise<ScreenshotCaptureResult> => {
          return this.captureScreenshotForBackoff();
        },
        (data: string) => {
          // Get screen dimensions from cached hierarchy or use defaults
          const screenWidth = this.cachedScreenDimensions?.width ?? 1170;
          const screenHeight = this.cachedScreenDimensions?.height ?? 2532;
          this.pushScreenshotToObservationStream(data, screenWidth, screenHeight);
        },
        undefined, // Use default config
        this.timer,
        () => {
          const server = getDeviceDataStreamServer();
          return !!server && server.hasSubscriberForDevice(this.device.deviceId);
        }
      );
    }
    return this.screenshotBackoffScheduler;
  }

  private async captureScreenshotForBackoff(): Promise<ScreenshotCaptureResult> {
    const server = getDeviceDataStreamServer();
    if (!server || !server.hasSubscriberForDevice(this.device.deviceId)) {
      return { success: false, error: "No subscribers" };
    }

    try {
      const result = await this.requestScreenshot(5000);
      if (!result.success || !result.data) {
        return { success: false, error: result.error || "No screenshot data" };
      }

      // Cache screen dimensions from hierarchy if available.
      // screenWidth/screenHeight are in iOS points — multiply by screenScale to get pixels,
      // matching the screenshot image resolution and the TakeScreenshot path (which reads PNG header pixels).
      if (this.cachedHierarchy?.hierarchy?.screenWidth && this.cachedHierarchy?.hierarchy?.screenHeight) {
        const scale = this.cachedHierarchy.hierarchy.screenScale ?? 1;
        this.cachedScreenDimensions = {
          width: Math.round(this.cachedHierarchy.hierarchy.screenWidth * scale),
          height: Math.round(this.cachedHierarchy.hierarchy.screenHeight * scale),
        };
      }

      return {
        success: true,
        data: result.data,
      };
    } catch (error) {
      return { success: false, error: `${error}` };
    }
  }

  /**
   * Cancel any pending screenshot captures.
   */
  cancelScreenshotBackoff(): void {
    if (this.screenshotBackoffScheduler) {
      this.screenshotBackoffScheduler.cancelPendingCaptures();
    }
  }

  // ===========================================================================
  // Navigation Detector
  // ===========================================================================

  public getHierarchyNavigationDetector(): HierarchyNavigationDetector {
    if (!this.hierarchyNavigationDetector) {
      this.hierarchyNavigationDetector = new HierarchyNavigationDetector(
        this.getNavigationGraphManager(),
        { timer: this.timer }
      );
    }
    return this.hierarchyNavigationDetector;
  }

  public resetHierarchyNavigationDetector(): void {
    if (this.hierarchyNavigationDetector) {
      this.hierarchyNavigationDetector.reset();
    }
  }

  private handleHierarchyUpdateForNavigation(
    hierarchy: CtrlProxyHierarchy,
    perfTiming?: CtrlProxyPerfTiming | CtrlProxyPerfTiming[]
  ): void {
    if (!hierarchy.hierarchy) {
      logger.warn("[IOSCtrlProxyClient] Skipping navigation detection: hierarchy missing in update");
      return;
    }

    if (hierarchy.error) {
      logger.warn(`[IOSCtrlProxyClient] Skipping navigation detection due to hierarchy error: ${hierarchy.error}`);
      return;
    }

    // Track foreground bundle and start performance monitoring when app changes
    const bundleId = hierarchy.packageName;
    logger.debug(`[IOSCtrlProxyClient] Hierarchy update - bundleId: "${bundleId}", lastForeground: "${this.lastForegroundBundleId}"`);
    if (bundleId && bundleId !== this.lastForegroundBundleId) {
      this.lastForegroundBundleId = bundleId;
      // Start performance monitoring for this device/bundle
      const monitor = getPerformanceMonitor();
      monitor.startMonitoring(this.device.deviceId, bundleId, "ios");
      logger.info(`[IOSCtrlProxyClient] Started performance monitoring for ${bundleId} on ${this.device.deviceId}`);
    }

    const conversionStart = this.timer.now();
    const convertedHierarchy = this.convertHierarchyForNavigation(hierarchy);
    const conversionMs = this.timer.now() - conversionStart;

    const metrics: HierarchyNavigationUpdateMetrics = {
      source: "ios",
      conversionMs,
      externalTiming: perfTiming
    };

    this.getHierarchyNavigationDetector().onHierarchyUpdate(convertedHierarchy, metrics);
  }

  private convertHierarchyForNavigation(hierarchy: CtrlProxyHierarchy): AccessibilityHierarchy {
    return {
      updatedAt: hierarchy.updatedAt,
      packageName: hierarchy.packageName,
      hierarchy: this.convertNodeForNavigation(hierarchy.hierarchy) as AccessibilityHierarchy["hierarchy"],
    };
  }

  private convertNodeForNavigation(
    node: CtrlProxyNode | CtrlProxyNode[]
  ): Record<string, unknown> | Record<string, unknown>[] {
    if (Array.isArray(node)) {
      return node.map(child => this.convertNodeForNavigation(child));
    }

    const converted: Record<string, unknown> = {};

    const contentDesc = this.readNodeField<string>(node, "contentDesc", "content-desc");
    const resourceId = this.readNodeField<string>(node, "resourceId", "resource-id");
    const testTag = this.readNodeField<string>(node, "testTag", "test-tag");
    const viewId = this.readNodeField<string>(node, "viewId", "view-id");

    if (node.text) {
      converted.text = node.text;
    }
    if (contentDesc) {
      converted["content-desc"] = contentDesc;
    }
    if (resourceId) {
      converted["resource-id"] = resourceId;
    }
    if (testTag) {
      converted["test-tag"] = testTag;
    }
    if (viewId) {
      converted["view-id"] = viewId;
    }
    if (node.className) {
      converted.className = node.className;
    }
    if (node.scrollable) {
      converted.scrollable = node.scrollable;
    }
    if (node.selected) {
      converted.selected = node.selected;
    }

    if (node.node) {
      converted.node = this.convertNodeForNavigation(node.node);
    }

    return converted;
  }

  private readNodeField<T>(node: CtrlProxyNode, camelKey: keyof CtrlProxyNode, dashedKey?: string): T | undefined {
    const record = node as Record<string, unknown>;
    if (record[camelKey as string] !== undefined) {
      return record[camelKey as string] as T;
    }
    if (dashedKey && record[dashedKey] !== undefined) {
      return record[dashedKey] as T;
    }
    return undefined;
  }
}

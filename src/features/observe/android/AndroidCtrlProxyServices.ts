import { AndroidCtrlProxyManager } from "../../../ctrlProxy/CtrlProxyManager";
import type { ForcedRestartSnapshot } from "../../../ctrlProxy/ForcedRestartBudget";
import { ForcedRestartBudget } from "../../../ctrlProxy/ForcedRestartBudget";
import { getDbWriteBarrier } from "../../../db/dbWriteBarrier";
import { FailureEventRepository } from "../../../db/failureEventRepository";
import { getInstalledAppsCacheWriteCoordinator } from "../../../db/installedAppsCacheWriteCoordinator";
import { InstalledAppsRepository, InstalledAppsStore } from "../../../db/installedAppsRepository";
import { BootedDevice } from "../../../models";
import type { ScreenIdentity } from "../../../models/ObserveResult";
import type { StackTraceElement } from "../../../models/failureAnalytics";
import type { ContentHashProvider } from "../../../utils/ContentHashProvider";
import { defaultIdGenerator, type IdGenerator } from "../../../utils/IdGenerator";
import type { PerformanceTracker } from "../../../utils/PerformanceTracker";
import { NoOpPerformanceTracker } from "../../../utils/PerformanceTracker";
import { IOS_CTRL_PROXY_RESERVED_PORTS, PortManager } from "../../../utils/PortManager";
import { defaultTimer } from "../../../utils/SystemTimer";
import { DefaultWorkProfileMonitor, WorkProfileMonitor } from "../../../utils/WorkProfileMonitor";
import type { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { CrashEventSink } from "../../../utils/interfaces/CrashMonitor";
import { logger, type Logger } from "../../../utils/logger";
import { isProcessRunning } from "../../../utils/processLiveness";
import { defaultRetryExecutor } from "../../../utils/retry/RetryExecutor";
import { HierarchyNavigationDetector } from "../../navigation/HierarchyNavigationDetector";
import { NavigationEvent, NavigationGraphManager } from "../../navigation/NavigationGraphManager";
import { getSdkFrameMetricsStore } from "../../performance/SdkFrameMetricsStore";
import { defaultPrototypeAssetCache } from "../../prototype/prototypeAssetCache";
import { defaultSavedPrototypeMirror } from "../../prototype/savedPrototypeMirror";
import {
  observationStreamDeviceConnectionLostNotifier,
  type DeviceConnectionLostNotifier,
} from "../DeviceConnectionLostNotifier";
import { defaultWebSocketFactory } from "../DeviceServiceClient";
import { ScreenshotBackoffScheduler } from "../ScreenshotBackoffScheduler";
import { type ScreenshotMetadata } from "../ScreenshotMetadata";
import { TrackedScreenGeometry, type ScreenGeometryBinding } from "../TrackedScreenGeometry";
import { type SdkAnrPayload, type SdkCrashPayload } from "../crash/sdkCrashIngestion";
import type { DelegateContext } from "../shared/types";
import { AndroidActionDispatcher } from "./AndroidActionDispatcher";
import {
  AndroidAppEventRecorder,
  parseStackTrace,
  type AndroidPackageEvent as PackageEvent,
} from "./AndroidAppEventRecorder";
import { AndroidBuildContextResolver } from "./AndroidBuildContextResolver";
import { AndroidClientRequests } from "./AndroidClientRequests";
import type { AndroidCtrlProxyClientDeps } from "./AndroidCtrlProxyClient";
import { AndroidCtrlProxyDelegatingFacade } from "./AndroidCtrlProxyDelegatingFacade";
import { AndroidCtrlProxyPortForwarder } from "./AndroidCtrlProxyPortForwarder";
import { AndroidDeviceStateSync } from "./AndroidDeviceStateSync";
import { AndroidHierarchyUpdateHandler } from "./AndroidHierarchyUpdateHandler";
import { AndroidInboundMessageRouter } from "./AndroidInboundMessageRouter";
import { AndroidInteractionTracker, MAX_CACHED_INTERACTIONS } from "./AndroidNavigationEvents";
import { AndroidNavigationWriteQueue } from "./AndroidNavigationWriteQueue";
import { AndroidPhysicalDisplayIdResolver } from "./AndroidPhysicalDisplayId";
import { AndroidScreenshotCapture } from "./AndroidScreenshotCapture";
import { AndroidScreenshotRequester } from "./AndroidScreenshotRequester";
import {
  AndroidSdkEventIngestor,
  DefaultAndroidSdkEventIngestor,
  type AndroidHandledExceptionEvent as HandledExceptionEvent,
} from "./AndroidSdkEventIngestor";
import { AndroidSdkScreenIdentityStore } from "./AndroidSdkScreenIdentityStore";
import { AndroidServiceReadinessVerifier } from "./AndroidServiceReadinessVerifier";
import {
  AndroidServiceRecovery,
  type AndroidServiceManagerFactory,
} from "./AndroidServiceRecovery";
import { type CertificateFileSystem } from "./CtrlProxyCertificates";
import {
  HostForwardClientConnectionProbe,
  type ForwardClientConnectionProbe,
} from "./CtrlProxyForwardClientProbe";
import { FileCtrlProxyForwardLease, type CtrlProxyForwardLease } from "./CtrlProxyForwardLease";
import type {
  AndroidDisplayTransition,
  InteractionEvent,
  WsFrameMetricsMessage,
} from "./androidCtrlProxyInboundProtocol";
import { PROTOTYPE_SAVED_CAPABILITY } from "./ctrlProxyProtocol";
import type {
  AccessibilityHierarchy,
  CachedHierarchy,
  CertificatesDelegateContext,
  HierarchyDelegateContext,
} from "./types";

function portAllocationIdForClient(
  deviceId: string,
  transientObserver: boolean,
  ids: IdGenerator,
): string {
  return transientObserver ? `${deviceId}:observer:${ids.next()}` : deviceId;
}
export const defaultAndroidServiceManagerFactory: AndroidServiceManagerFactory = (device) =>
  AndroidCtrlProxyManager.getInstance(device);
const MAX_RETAINED_HIERARCHY_REQUEST_MARKERS = 64;

/** Owns lazy Android delegates and their live, narrowly typed contexts. */
export abstract class AndroidCtrlProxyServices extends AndroidCtrlProxyDelegatingFacade {
  // Matches iOS's CONNECTION_RESET_MS (set for #2695). The base default
  // (10000ms) outlives waitForConnection()'s default retry budget
  // (~2.7s), so a client that hit maxConnectionAttempts stays cooled down
  // well past a caller's next waitForConnection() even when the endpoint
  // has since recovered (issue #7538). Callers that just changed the
  // endpoint's state (setup, enable, rebind) should still call the base
  // class's resetConnectionBudget() rather than relying on this shorter
  // window alone.
  protected static readonly CONNECTION_RESET_MS = 2000;

  /** Optional observer for display and posture changes. */
  onDisplayTransition?: (event: AndroidDisplayTransition) => void;

  protected adb: AdbExecutor;

  protected readonly physicalDisplayIdResolver: AndroidPhysicalDisplayIdResolver;

  protected readonly idGenerator: IdGenerator;

  // Per-instance port allocation for multi-device support
  protected localPort: number;

  protected readonly ownsPortAllocation: boolean;

  protected readonly portAllocationId: string;

  // Build/device provenance (#4984): lazily-built content-hash provider (cached by
  // (deviceId, packageId, versionCode)), the resolved build context per app (kept on
  // the per-device client so it survives session rebinds and is re-applied to the
  // current session's manager on every event), the set of apps whose resolution is
  // in flight, and a per-app generation bumped on package changes so a resolution
  // that started before an update can't apply a stale build.

  // Hierarchy caching (accessed by delegates via context)
  protected cachedHierarchy: CachedHierarchy | null = null;

  // Android-specific state
  protected portForwardingSetup: boolean = false;

  /** @internal Test seam for CtrlProxyClient tests (#7992); not part of the public API. */
  readonly ctrlProxyForwardLease: CtrlProxyForwardLease;

  /**
   * @internal Host TCP-table reader deciding whether an unrecorded forward is
   * still in use (#10690). Tests replace it; production reads lsof/netstat.
   */
  forwardClientProbe: ForwardClientConnectionProbe = new HostForwardClientConnectionProbe();

  /** @internal Injected liveness probe for sticky foreign-forward evidence. */
  forwardClientProcessIsRunning: (pid: number) => boolean = isProcessRunning;

  protected ctrlProxyForwardLeaseReleaseScheduled: boolean = false;

  /** Set when shutdown released this client's lease before its close finished. */
  protected forwardLeaseForceReleased: boolean = false;

  protected inFlightConnection: Promise<boolean> | null = null;

  protected cleanupHeldPort: number | null = null;

  protected lastWebSocketTimeout: number = 0;

  protected readinessHolds = 0;

  protected forwardSetupFailure: string | undefined;

  protected readonly inFlightMessageHandlers = new Set<Promise<void>>();

  // Re-entry guard: a recovery burst that has not settled must not start a
  // second, overlapping recovery attempt.
  protected isRecoveringService: boolean = false;

  protected restartRearmTimeout: NodeJS.Timeout | null = null;

  /** One client exists per device; this budget gates both failure bursts and observe calls. */
  public readonly forcedRestartBudget: ForcedRestartBudget;

  protected serviceRecovery: AndroidServiceRecovery | undefined;

  protected readonly serviceManagerFactory: AndroidServiceManagerFactory;

  protected readonly interactionTracker = new AndroidInteractionTracker(this.timer);

  protected installedAppsRepository: InstalledAppsStore | null = null;

  // Hierarchy navigation detector
  protected sdkNavigationAppIds: Set<string> = new Set();

  protected readonly sdkScreenIdentityStore = new AndroidSdkScreenIdentityStore(this.timer);

  // Screen geometry derived from hierarchies, carrying whether the daemon has actually seen a
  // hierarchy with that geometry (issue #3348). See TrackedScreenGeometry.
  /** @internal Test seam for CtrlProxyClient tests (#7992); not part of the public API. */
  readonly screenGeometry = new TrackedScreenGeometry();

  /** @internal Test seam for CtrlProxyClient tests (#7992); not part of the public API. */
  readonly hierarchyObservationStreamSuppressions = new Map<string, NodeJS.Timeout>();

  protected readonly observerHierarchyRequestIds = new Map<string, boolean>();

  protected readonly transientObserver: boolean;

  // Request ids whose screenshot responses must not be auto-pushed to the
  // observation stream. Scoped per-request so an unrelated in-flight screenshot
  // (e.g. backoff capture or MCP screenshot) cannot consume the suppression.
  protected screenshotObservationStreamSuppressions: Set<string> = new Set();

  // Request ids cancelled after their screenshot frame was dispatched. The runner cannot retract a
  // request already on the wire, so a later response must be discarded rather than auto-pushed.
  /** @internal Test seam for CtrlProxyClient tests (#7992); not part of the public API. */
  lateCancelledScreenshotRequestIds: Set<string> = new Set();

  protected readonly pendingFocusedInputClickIds: Set<string> = new Set();

  // Capture identity bound to each in-flight screenshot request, keyed by requestId (issue #3348).
  // Recorded when the request is SENT and consumed when its response is pushed, so a hierarchy that
  // arrives while the frame is in flight cannot relabel it. Same-resolution navigation makes this
  // the only defence: the pixel dimensions are identical, so nothing about the frame reveals that
  // it belongs to the previous screen.
  protected screenshotCaptureBindings: Map<string, ScreenGeometryBinding> = new Map();

  // Work profile monitor for polling profiles without accessibility service
  protected workProfileMonitor: WorkProfileMonitor | null = null;

  protected readonly rejectedCommands = new Set<string>();

  // Track foreground package for crash monitoring
  protected lastForegroundPackage: string | null = null;

  protected readonly crashEventSink: CrashEventSink;

  protected readonly deviceConnectionLostNotifier: DeviceConnectionLostNotifier;

  protected readonly certificateFileSystem: CertificateFileSystem | undefined;

  protected portForwarder: AndroidCtrlProxyPortForwarder | null = null;

  protected appEventRecorder: AndroidAppEventRecorder | null = null;

  /**
   * Owns SDK telemetry/crash/ANR ingestion (issue #2764). Lazily built so it can
   * close over instance methods (`parseStackTrace`, session-bound nav manager);
   * injectable for tests.
   */
  protected sdkEventIngestorInstance: AndroidSdkEventIngestor | null = null;

  protected readonly loggerInstance: Logger;

  // Logging tag for base class
  protected readonly logTag = "ACCESSIBILITY_SERVICE";

  /**
   * The SDK-event ingestor for this client (issue #2764). Built lazily so it can
   * close over instance methods and the session-bound navigation manager; a
   * test-injected instance short-circuits construction.
   */
  protected getSdkEventIngestor(): AndroidSdkEventIngestor {
    if (!this.sdkEventIngestorInstance) {
      this.sdkEventIngestorInstance = new DefaultAndroidSdkEventIngestor({
        deviceId: this.device.deviceId,
        getNavigationScreenSource: () => this.getNavigationGraphManager(),
        parseStackTrace: (stackTrace, packageName) => this.parseStackTrace(stackTrace, packageName),
        now: () => this.timer.now(),
      });
    }
    return this.sdkEventIngestorInstance;
  }

  /** Keep mutable test seams and post-await state live without exposing connection lifecycle. */
  protected hierarchyUpdateHandler: AndroidHierarchyUpdateHandler | undefined;

  protected getHierarchyUpdateHandler(): AndroidHierarchyUpdateHandler {
    if (!this.hierarchyUpdateHandler) {
      const client = this;
      this.hierarchyUpdateHandler = new AndroidHierarchyUpdateHandler({
        timer: client.timer,
        get deviceId() {
          return client.device.deviceId;
        },
        transientObserver: client.transientObserver,
        get hierarchy() {
          return client.hierarchy;
        },
        observerHierarchyRequestIds: client.observerHierarchyRequestIds,
        hierarchyObservationStreamSuppressions: client.hierarchyObservationStreamSuppressions,
        get sdkNavigationAppIds() {
          return client.sdkNavigationAppIds;
        },
        get cachedHierarchy() {
          return client.cachedHierarchy;
        },
        set cachedHierarchy(value) {
          client.cachedHierarchy = value;
        },
        get lastForegroundPackage() {
          return client.lastForegroundPackage;
        },
        set lastForegroundPackage(value) {
          client.lastForegroundPackage = value;
        },
        removeHierarchyObservationStreamSuppression: (requestId) =>
          client.removeHierarchyObservationStreamSuppression(requestId),
        updateCachedScreenDimensions: (hierarchy) => client.updateCachedScreenDimensions(hierarchy),
        pushHierarchyToObservationStream: (hierarchy, frameContext) =>
          client.pushHierarchyToObservationStream(hierarchy, frameContext),
        startScreenshotBackoff: () => client.startScreenshotBackoff(),
        getNavigationGraphManager: () => client.getNavigationGraphManager(),
        ensureBuildContext: (packageName) => client.ensureBuildContext(packageName),
        getHierarchyNavigationDetector: () => client.getHierarchyNavigationDetector(),
      });
    }
    return this.hierarchyUpdateHandler;
  }

  protected screenshotCapture: AndroidScreenshotCapture | undefined;

  protected getScreenshotCapture(): AndroidScreenshotCapture {
    if (!this.screenshotCapture) {
      const client = this;
      this.screenshotCapture = new AndroidScreenshotCapture({
        get adb() {
          return client.adb;
        },
        timer: client.timer,
        get deviceId() {
          return client.device.deviceId;
        },
        get closed() {
          return client.closed;
        },
        get logger() {
          return client.loggerInstance;
        },
        idGenerator: client.idGenerator,
        physicalDisplayIdResolver: client.physicalDisplayIdResolver,
        screenGeometry: client.screenGeometry,
        requestManager: client.requestManager,
        get screenshotObservationStreamSuppressions() {
          return client.screenshotObservationStreamSuppressions;
        },
        get socket() {
          return client.ws;
        },
        noteScreenshotCaptureStarted: () =>
          client.getScreenshotBackoffScheduler().noteCaptureStarted(),
      });
    }
    return this.screenshotCapture;
  }

  protected buildContextResolverInstance: AndroidBuildContextResolver | undefined;

  protected get buildContextResolver(): AndroidBuildContextResolver {
    if (!this.buildContextResolverInstance) {
      const client = this;
      this.buildContextResolverInstance = new AndroidBuildContextResolver({
        get closed() {
          return client.closed;
        },
        get device() {
          return client.device;
        },
        get adb() {
          return client.adb;
        },
        timer: client.timer,
        getNavigationGraphManager: () => client.getNavigationGraphManager(),
        requestPackageInfo: (appId, options, timeoutMs) =>
          client.requestPackageInfo(appId, options, timeoutMs),
      });
    }
    return this.buildContextResolverInstance;
  }

  protected actionDispatcher: AndroidActionDispatcher | undefined;

  protected getActionDispatcher(): AndroidActionDispatcher {
    if (!this.actionDispatcher) {
      const client = this;
      this.actionDispatcher = new AndroidActionDispatcher({
        timer: client.timer,
        requestManager: client.requestManager,
        pendingFocusedInputClickIds: client.pendingFocusedInputClickIds,
        get supportedCommands() {
          return client.supportedCommands;
        },
        awaitActionWork: (work, signal) => client.awaitActionWork(work, signal),
        awaitCancellableRequest: (requestId, promise, signal, startTime) =>
          client.awaitCancellableRequest(requestId, promise, signal, startTime),
        connectWebSocket: (perf) => client.connectWebSocket(perf),
        waitForHandshake: (timeoutMs, signal) => client.waitForHandshake(timeoutMs, signal),
        isCommandSupported: (messageType) => client.isCommandSupported(messageType),
        cancelScreenshotBackoff: () => client.cancelScreenshotBackoff(),
        createDelegateContext: () => client.createDelegateContext(),
      });
    }
    return this.actionDispatcher;
  }

  protected clientRequests: AndroidClientRequests | undefined;

  protected getClientRequests(): AndroidClientRequests {
    if (!this.clientRequests) {
      const client = this;
      this.clientRequests = new AndroidClientRequests({
        timer: client.timer,
        requestManager: client.requestManager,
        get logger() {
          return client.loggerInstance;
        },
        get actions() {
          return client.getActionDispatcher();
        },
        isConnected: () => client.isConnected(),
        connectWebSocket: (perf) => client.connectWebSocket(perf),
        createDelegateContext: () => client.createDelegateContext(),
        awaitActionWork: (work, signal) => client.awaitActionWork(work, signal),
      });
    }
    return this.clientRequests;
  }

  protected getServiceRecovery(): AndroidServiceRecovery {
    if (!this.serviceRecovery) {
      const client = this;
      this.serviceRecovery = new AndroidServiceRecovery({
        get adb() {
          return client.adb;
        },
        timer: client.timer,
        get deviceId() {
          return client.device.deviceId;
        },
        get device() {
          return client.device;
        },
        get closed() {
          return client.closed;
        },
        get connectionGeneration() {
          return client.connectionGeneration;
        },
        get consecutiveConnectionFailures() {
          return client.consecutiveConnectionFailures;
        },
        set consecutiveConnectionFailures(value: number) {
          client.consecutiveConnectionFailures = value;
        },
        get isRecoveringService() {
          return client.isRecoveringService;
        },
        set isRecoveringService(value: boolean) {
          client.isRecoveringService = value;
        },
        get recoveryPromise() {
          return client.recoveryPromise;
        },
        set recoveryPromise(value: Promise<boolean> | null) {
          client.recoveryPromise = value;
        },
        forcedRestartBudget: client.forcedRestartBudget,
        serviceManagerFactory: client.serviceManagerFactory,
        get restartRearmPending() {
          return client.restartRearmTimeout !== null;
        },
        get socket() {
          return client.ws;
        },
        isConnected: () => client.isConnected(),
        resetConnectionBudget: () => client.resetConnectionBudget(),
        connectBackgroundWebSocket: () => client.connectBackgroundWebSocket(),
      });
    }
    return this.serviceRecovery;
  }

  protected getPortForwarder(): AndroidCtrlProxyPortForwarder {
    if (!this.portForwarder) {
      const client = this;
      this.portForwarder = new AndroidCtrlProxyPortForwarder({
        get adb() {
          return client.adb;
        },
        timer: client.timer,
        get deviceId() {
          return client.device.deviceId;
        },
        ctrlProxyForwardLease: client.ctrlProxyForwardLease,
        get forwardClientProbe() {
          return client.forwardClientProbe;
        },
        get forwardClientProcessIsRunning() {
          return client.forwardClientProcessIsRunning;
        },
        get closed() {
          return client.closed;
        },
        get localPort() {
          return client.localPort;
        },
        set localPort(value) {
          client.localPort = value;
        },
        portAllocationId: client.portAllocationId,
        get portForwardingSetup() {
          return client.portForwardingSetup;
        },
        set portForwardingSetup(value) {
          client.portForwardingSetup = value;
        },
        get forwardLeaseForceReleased() {
          return client.forwardLeaseForceReleased;
        },
        set forwardSetupFailure(failure: string | undefined) {
          client.forwardSetupFailure = failure;
        },
        getLiveLocalPorts: () => this.getLiveLocalPorts(),
      });
    }
    return this.portForwarder;
  }

  /** Resolve collaborators lazily so injected stores and session-bound ingestors stay live. */
  protected getAppEventRecorder(): AndroidAppEventRecorder {
    if (!this.appEventRecorder) {
      this.appEventRecorder = new AndroidAppEventRecorder({
        deviceId: this.device.deviceId,
        platform: this.device.platform,
        timer: this.timer,
        crashEventSink: this.crashEventSink,
        getSdkEventIngestor: () => this.getSdkEventIngestor(),
        getInstalledAppsStore: () => this.getInstalledAppsRepository(),
        getWorkProfileMonitor: () => this.workProfileMonitor,
        invalidateBuildContext: (appId) => this.invalidateBuildContext(appId),
        getLastForegroundPackage: () => this.lastForegroundPackage,
        // Resolve the module exports per call so later spies and singleton swaps are honoured.
        getFrameMetricsStore: () => getSdkFrameMetricsStore(),
        getInstalledAppsCacheWriteCoordinator: () => getInstalledAppsCacheWriteCoordinator(),
        getDbWriteBarrier: () => getDbWriteBarrier(),
      });
    }
    return this.appEventRecorder;
  }

  // ===========================================================================
  // Delegate Context Factories
  // ===========================================================================

  protected createHierarchyDelegateContext(): HierarchyDelegateContext {
    return {
      ...this.createDelegateContext(),
      device: this.device,
      adb: this.adb,
      getCachedHierarchy: () => this.cachedHierarchy,
      setCachedHierarchy: (h) => {
        this.cachedHierarchy = h;
      },
      getLastWebSocketTimeout: () => this.lastWebSocketTimeout,
      setLastWebSocketTimeout: (time) => {
        this.lastWebSocketTimeout = time;
      },
      markObserverHierarchyRequest: (requestId, options) => {
        this.observerHierarchyRequestIds.set(requestId, options?.isolateResponse ?? false);
        // Markers of unanswered requests outlive their waiter (a late reply must stay isolated);
        // evict the oldest so an unresponsive runner cannot grow the map without bound.
        while (this.observerHierarchyRequestIds.size > MAX_RETAINED_HIERARCHY_REQUEST_MARKERS) {
          const oldest = this.observerHierarchyRequestIds.keys().next().value;
          if (oldest === undefined) {
            break;
          }
          this.observerHierarchyRequestIds.delete(oldest);
        }
      },
      unmarkObserverHierarchyRequest: (requestId) => {
        this.observerHierarchyRequestIds.delete(requestId);
      },
    };
  }

  protected override extraDelegateContextFields(): Partial<DelegateContext> {
    return {
      prototypeAssetCache: { serial: this.device.deviceId, cache: defaultPrototypeAssetCache() },
      savedPrototypeMirror: { serial: this.device.deviceId, mirror: defaultSavedPrototypeMirror() },
      isCommandSupported: (messageType) =>
        messageType === PROTOTYPE_SAVED_CAPABILITY
          ? this.supportedCommands?.has(messageType) === true
          : this.isCommandSupported(messageType),
      getSupportedCommands: () => this.getSupportedCommands(),
      idGenerator: this.idGenerator,
    };
  }

  protected createCertificatesDelegateContext(): CertificatesDelegateContext {
    return {
      ...this.createDelegateContext(),
      adb: this.adb,
    };
  }

  protected deviceStateSync: AndroidDeviceStateSync | undefined;

  protected getDeviceStateSync(): AndroidDeviceStateSync {
    this.deviceStateSync ??= new AndroidDeviceStateSync({
      deviceId: this.device.deviceId,
      sendMessage: (message) => this.sendMessage(message),
    });
    return this.deviceStateSync;
  }

  protected screenshotRequesterInstance: AndroidScreenshotRequester | undefined;

  protected getScreenshotRequester(): AndroidScreenshotRequester {
    if (!this.screenshotRequesterInstance) {
      const client = this;
      this.screenshotRequesterInstance = new AndroidScreenshotRequester({
        timer: client.timer,
        requestManager: client.requestManager,
        screenGeometry: client.screenGeometry,
        get screenshotObservationStreamSuppressions() {
          return client.screenshotObservationStreamSuppressions;
        },
        get screenshotCaptureBindings() {
          return client.screenshotCaptureBindings;
        },
        get lateCancelledScreenshotRequestIds() {
          return client.lateCancelledScreenshotRequestIds;
        },
        get socket() {
          return client.ws;
        },
        get supportedCommands() {
          return client.supportedCommands;
        },
        connectWebSocket: (perf) => client.connectWebSocket(perf),
        noteScreenshotCaptureStarted: () =>
          client.getScreenshotBackoffScheduler().noteCaptureStarted(),
      });
    }
    return this.screenshotRequesterInstance;
  }

  protected serviceReadinessVerifierInstance: AndroidServiceReadinessVerifier | undefined;

  protected getServiceReadinessVerifier(): AndroidServiceReadinessVerifier {
    if (!this.serviceReadinessVerifierInstance) {
      const client = this;
      this.serviceReadinessVerifierInstance = new AndroidServiceReadinessVerifier({
        retryExecutor: client.retryExecutor,
        get logger() {
          return client.loggerInstance;
        },
        requestHierarchySync: (signal, timeoutMs, diagnostics) =>
          client.requestHierarchySync(
            new NoOpPerformanceTracker(),
            false,
            signal,
            timeoutMs,
            diagnostics,
          ),
      });
    }
    return this.serviceReadinessVerifierInstance;
  }

  protected inboundMessageRouter: AndroidInboundMessageRouter | null = null;

  protected getInboundMessageRouter(): AndroidInboundMessageRouter {
    if (!this.inboundMessageRouter) {
      const client = this;
      this.inboundMessageRouter = new AndroidInboundMessageRouter({
        transientObserver: client.transientObserver,
        rejectedCommands: client.rejectedCommands,
        get supportedCommands() {
          return client.supportedCommands;
        },
        set supportedCommands(value) {
          client.supportedCommands = value;
        },
        get hierarchy() {
          return client.hierarchy;
        },
        get lateCancelledScreenshotRequestIds() {
          return client.lateCancelledScreenshotRequestIds;
        },
        requestManager: client.requestManager,
        get _hierarchy() {
          return client._hierarchy;
        },
        get device() {
          return client.device;
        },
        get onDisplayTransition() {
          return client.onDisplayTransition;
        },
        get screenshotObservationStreamSuppressions() {
          return client.screenshotObservationStreamSuppressions;
        },
        get screenshotCaptureBindings() {
          return client.screenshotCaptureBindings;
        },
        get certificates() {
          return client.certificates;
        },
        get focus() {
          return client.focus;
        },
        get sdkNavigationAppIds() {
          return client.sdkNavigationAppIds;
        },
        get closed() {
          return client.closed;
        },
        get adb() {
          return client.adb;
        },
        get prototypes() {
          return client.prototypes;
        },
        timer: client.timer,
        get lastInteractionByApp() {
          return client.lastInteractionByApp;
        },
        get storage() {
          return client.storage;
        },
        get maxCachedInteractions() {
          return MAX_CACHED_INTERACTIONS;
        },
        refreshObservationStreamHierarchyCadence: (...args) =>
          client.refreshObservationStreamHierarchyCadence(...args),
        settleUnattributedFocusedClickRejection: (...args) =>
          client.settleUnattributedFocusedClickRejection(...args),
        handleHierarchyUpdate: (...args) => client.handleHierarchyUpdate(...args),
        pushScreenshotToObservationStream: (...args) =>
          client.pushScreenshotToObservationStream(...args),
        resolvePendingResponse: (...args) => client.resolvePendingResponse(...args),
        recordSdkScreenIdentity: (...args) => client.recordSdkScreenIdentity(...args),
        ensureBuildContext: (...args) => client.ensureBuildContext(...args),
        attachRecentInteraction: (...args) => client.attachRecentInteraction(...args),
        enqueueNavigationGraphWrite: (...args) => client.enqueueNavigationGraphWrite(...args),
        getNavigationGraphManager: (...args) => client.getNavigationGraphManager(...args),
        handlePackageEvent: (...args) => client.handlePackageEvent(...args),
        pruneStaleInteractions: (...args) => client.pruneStaleInteractions(...args),
        notifyInteractionListeners: (...args) => client.notifyInteractionListeners(...args),
        handleHandledExceptionEvent: (...args) => client.handleHandledExceptionEvent(...args),
        clearSdkScreenIdentity: (...args) => client.clearSdkScreenIdentity(...args),
        handleCrashEvent: (...args) => client.handleCrashEvent(...args),
        handleAnrEvent: (...args) => client.handleAnrEvent(...args),
        handleFrameMetricsEvent: (...args) => client.handleFrameMetricsEvent(...args),
        getSdkEventIngestor: (...args) => client.getSdkEventIngestor(...args),
        recordSdkTelemetryEvent: (...args) => client.recordSdkTelemetryEvent(...args),
      });
    }
    return this.inboundMessageRouter;
  }

  protected navigationWriteQueueInstance: AndroidNavigationWriteQueue | undefined;

  /**
   * Private constructor - use getInstance() instead
   */
  protected constructor(
    device: BootedDevice,
    adb: AdbExecutor,
    deps: AndroidCtrlProxyClientDeps = {},
  ) {
    super(
      deps.timer ?? defaultTimer,
      deps.webSocketFactory ?? defaultWebSocketFactory,
      { connectionResetMs: AndroidCtrlProxyServices.CONNECTION_RESET_MS },
      deps.retryExecutor ?? defaultRetryExecutor,
    );
    const {
      serviceManagerFactory = defaultAndroidServiceManagerFactory,
      idGenerator = defaultIdGenerator,
      logger: loggerInstance = logger,
      transientObserver,
    } = deps;
    this.forcedRestartBudget = new ForcedRestartBudget(this.timer);
    this.serviceManagerFactory = serviceManagerFactory;
    this.sdkEventIngestorInstance = deps.sdkEventIngestor ?? null;
    this.loggerInstance = loggerInstance;
    this.device = device;
    this.adb = adb;
    this.idGenerator = idGenerator;
    this.transientObserver = transientObserver === true;
    this.autoReconnectEnabled = transientObserver !== true;
    this.physicalDisplayIdResolver = new AndroidPhysicalDisplayIdResolver({ timer: this.timer });
    this.installedAppsRepository = deps.installedAppsRepository ?? null;
    this.crashEventSink = deps.crashEventSink ?? new FailureEventRepository();
    this.deviceConnectionLostNotifier =
      deps.deviceConnectionLostNotifier ?? observationStreamDeviceConnectionLostNotifier;
    this.certificateFileSystem = deps.certificateFileSystem;
    this.ctrlProxyForwardLease = this.resolveForwardLease(deps.ctrlProxyForwardLease);
    // A detached observer needs its own forward while a disconnected singleton
    // retains the device allocation for a later reconnect.
    this.portAllocationId = portAllocationIdForClient(
      device.deviceId,
      this.transientObserver,
      idGenerator,
    );
    this.ownsPortAllocation = PortManager.getPort(this.portAllocationId) === undefined;
    this.localPort = PortManager.allocate(this.portAllocationId, {
      reservedPorts: IOS_CTRL_PROXY_RESERVED_PORTS,
    });
  }
  protected abstract removeHierarchyObservationStreamSuppression(requestId: string): boolean;
  protected abstract getHierarchyNavigationDetector(): HierarchyNavigationDetector;
  protected abstract refreshObservationStreamHierarchyCadence(intervalMs?: number | null): void;
  protected abstract resolvePendingResponse<Message extends { requestId?: string | null }, Payload>(
    message: Message,
    buildPayload: (message: Message & { requestId: string }) => Payload,
  ): void;
  protected abstract pushHierarchyToObservationStream(
    wireHierarchy: AccessibilityHierarchy,
    frameContext?: string,
  ): void;
  protected abstract pushScreenshotToObservationStream(
    screenshotBase64: string,
    metadata?: ScreenshotMetadata,
    binding?: ScreenGeometryBinding,
    frameContext?: string,
    rotation?: number,
  ): void;
  protected abstract updateCachedScreenDimensions(
    hierarchy: Pick<
      AccessibilityHierarchy,
      "windows" | "nativeScale" | "pixelWidth" | "pixelHeight"
    >,
  ): void;
  protected abstract getScreenshotBackoffScheduler(): ScreenshotBackoffScheduler;
  protected abstract startScreenshotBackoff(): void;
  protected abstract isCommandSupported(messageType: string): boolean;
  protected abstract awaitActionWork<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  protected abstract getLiveLocalPorts(): ReadonlySet<number>;

  private resolveForwardLease(lease?: CtrlProxyForwardLease): CtrlProxyForwardLease {
    return lease ?? new FileCtrlProxyForwardLease(this.device.deviceId);
  }

  /**
   * The newest AutoMobile SDK navigation route the app reported, when the app embeds the SDK.
   * Single-activity Compose apps name their screens only this way.
   */
  public getSdkScreenIdentity(applicationId?: string): ScreenIdentity | undefined {
    return this.sdkScreenIdentityStore.get(applicationId);
  }

  /** Host time (this client's timer) at which the app's newest SDK route arrived. */
  public getSdkScreenIdentityReceivedAtMs(applicationId: string): number | undefined {
    return this.sdkScreenIdentityStore.getReceivedAtMs(applicationId);
  }

  /**
   * Resolve with the app's SDK route once one newer than `sinceMs` has arrived, or undefined after
   * `timeoutMs` (or when the app's route is cleared first). Returns at once for a route that
   * already postdates `sinceMs`.
   */
  public awaitSdkScreenIdentityAfter(
    applicationId: string,
    sinceMs: number,
    timeoutMs: number,
  ): Promise<ScreenIdentity | undefined> {
    return this.sdkScreenIdentityStore.awaitAfter(applicationId, sinceMs, timeoutMs);
  }

  /**
   * Forget the SDK navigation route of an app whose process was replaced (terminated, relaunched
   * cold, data cleared, crashed), or of every app when none is named (the SDK link was lost).
   */
  public clearSdkScreenIdentity(applicationId?: string): void {
    this.sdkScreenIdentityStore.clear(applicationId);
  }

  protected recordSdkScreenIdentity(applicationId: string, identity: ScreenIdentity): void {
    this.sdkScreenIdentityStore.record(applicationId, identity);
  }

  /**
   * Get the NavigationGraphManager for the bound session, or the global singleton.
   */
  protected getNavigationGraphManager(): ReturnType<typeof NavigationGraphManager.getInstance> {
    return this.boundSessionId
      ? NavigationGraphManager.getInstanceForSession(this.boundSessionId)
      : NavigationGraphManager.getInstance();
  }

  /** Ensure the build/device provenance context for an app is applied (#4984). Non-blocking. */
  protected ensureBuildContext(appId: string): void {
    this.buildContextResolver.ensure(appId);
  }

  /** Invalidate all cached build/content-hash provenance for an app (#4984). */
  protected invalidateBuildContext(appId: string): void {
    this.buildContextResolver.invalidate(appId);
  }

  /** Every app id with cached or in-flight build-context state (#4984). */
  protected knownBuildContextApps(): string[] {
    return this.buildContextResolver.knownApps();
  }

  private get contentHashProvider(): ContentHashProvider | null {
    return this.buildContextResolver.contentHashProvider;
  }

  private set contentHashProvider(value: ContentHashProvider | null) {
    this.buildContextResolver.contentHashProvider = value;
  }

  protected resetA11yScreenshotSupport(): void {
    this.getScreenshotCapture().resetA11yScreenshotSupport();
  }

  /**
   * Push THIS device's mock rules and error simulation from the host store.
   * Runs on every (re)connect, and after a session release clears the store so
   * the device drops what that session installed (issue #10061).
   */
  public syncNetworkStateToDevice(): boolean {
    return this.getDeviceStateSync().syncNetworkState();
  }

  protected syncAccessibilityFlagsToDevice(): void {
    this.getDeviceStateSync().syncAccessibilityFlags();
  }

  /** Start a recovery for this observed transport failure if none is pending. */
  public ensureRecoveryStarted(): void {
    this.getServiceRecovery().ensureStarted(this.autoReconnectEnabled);
  }

  /** Current forced-restart admission state, for typed observe/action failure reasons. */
  public getRestartBudgetSnapshot(): ForcedRestartSnapshot {
    return this.forcedRestartBudget.snapshot();
  }

  public isRecoveryInFlight(): boolean {
    return this.recoveryPromise !== null;
  }

  // ===========================================================================
  // Event Listeners
  // ===========================================================================

  onInteraction(listener: (event: InteractionEvent) => void): () => void {
    return this.interactionTracker.onInteraction(listener);
  }

  private ensureLocalPortAvailableForForwarding(signal?: AbortSignal): Promise<void> {
    return this.getPortForwarder().ensureLocalPortAvailableForForwarding(signal);
  }

  /** @internal Test seam for CtrlProxyClient tests (#7992); not part of the public API. */
  setupPortForwarding(
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    signal?: AbortSignal,
  ): Promise<void> {
    return this.getPortForwarder().setupPortForwarding(perf, signal);
  }

  /**
   * Remove stale local forwards for this device that target CtrlProxy's fixed
   * device port. A daemon crash drops the in-memory singleton registry but
   * leaves ADB's forwards alive; the next client setup is their recovery path.
   *
   * A newly-created singleton is registered before it can start connecting, so
   * its allocated port is treated as live even before port forwarding completes.
   */
  /** @internal Test seam for CtrlProxyClient tests (#7992); not part of the public API. */
  sweepOrphanedCtrlProxyPortForwards(signal?: AbortSignal): Promise<void> {
    return this.getPortForwarder().sweepOrphanedCtrlProxyPortForwards(signal);
  }

  /**
   * Remove a forward only when it still maps this device and host port to the
   * CtrlProxy device port. Re-listing closes the race with a different service
   * reusing the host port after the orphan sweep discovered it.
   *
   * @returns `true` when no matching forward remains; `false` when adb failed
   * to establish that state.
   */
  protected removeCtrlProxyPortForward(
    port: number,
    signal?: AbortSignal,
    options: { reclaimUnrecorded?: boolean } = {},
  ): Promise<boolean> {
    return this.getPortForwarder().removeCtrlProxyPortForward(port, signal, options);
  }

  /** SDK event frames include custom_event, which is intentionally outside WebSocketMessage. */
  protected async recordSdkTelemetryEvent(message: {
    type: string;
    timestamp?: number;
    event?: Record<string, unknown>;
  }): Promise<void> {
    const event = message.event;
    if (event) {
      await this.getSdkEventIngestor().recordSdkEvent(
        {
          type: message.type,
          timestamp: message.timestamp ?? this.timer.now(),
          payload: { event },
        },
        (event.applicationId as string) ?? null,
      );
    }
  }

  protected get lastInteractionByApp() {
    return this.interactionTracker.lastInteractionByApp;
  }

  protected pruneStaleInteractions(now: number): void {
    this.interactionTracker.pruneStaleInteractions(now);
  }

  protected attachRecentInteraction(event: NavigationEvent): void {
    this.interactionTracker.attachRecentInteraction(event);
  }

  protected notifyInteractionListeners(event: InteractionEvent): void {
    this.interactionTracker.notifyInteractionListeners(event);
  }

  protected enqueueNavigationGraphWrite(received: NavigationEvent): Promise<void> {
    this.navigationWriteQueueInstance ??= new AndroidNavigationWriteQueue({
      deviceId: this.device.deviceId,
      getNavigationGraphManager: () => this.getNavigationGraphManager(),
    });
    return this.navigationWriteQueueInstance.enqueue(received);
  }

  protected getInstalledAppsRepository(): InstalledAppsStore {
    if (!this.installedAppsRepository) {
      this.installedAppsRepository = new InstalledAppsRepository();
    }
    return this.installedAppsRepository;
  }

  /**
   * Get or create the work profile monitor for polling profiles without accessibility service
   */
  getWorkProfileMonitor(): WorkProfileMonitor {
    if (!this.workProfileMonitor) {
      this.workProfileMonitor = new DefaultWorkProfileMonitor({
        deviceId: this.device.deviceId,
        adb: this.adb,
        installedAppsStore: this.getInstalledAppsRepository(),
        timer: this.timer,
      });
    }
    return this.workProfileMonitor;
  }

  /**
   * Start the work profile monitor to poll profiles without accessibility service
   */
  startWorkProfileMonitor(): void {
    this.getWorkProfileMonitor().start();
  }

  /**
   * Stop the work profile monitor
   */
  stopWorkProfileMonitor(): void {
    if (this.workProfileMonitor) {
      this.workProfileMonitor.stop();
    }
  }

  protected handlePackageEvent(event: PackageEvent, timestamp?: number): Promise<void> {
    return this.getAppEventRecorder().handlePackageEvent(event, timestamp);
  }

  protected handleHandledExceptionEvent(event: HandledExceptionEvent): Promise<void> {
    return this.getAppEventRecorder().handleHandledExceptionEvent(event);
  }

  protected handleFrameMetricsEvent(
    data: NonNullable<WsFrameMetricsMessage["frameMetrics"]>,
  ): void {
    return this.getAppEventRecorder().handleFrameMetricsEvent(data);
  }

  protected handleCrashEvent(event: SdkCrashPayload): Promise<void> {
    return this.getAppEventRecorder().handleCrashEvent(event);
  }

  protected handleAnrEvent(event: SdkAnrPayload): Promise<void> {
    return this.getAppEventRecorder().handleAnrEvent(event);
  }

  protected parseStackTrace(stackTrace: string, packageName: string): StackTraceElement[] {
    return parseStackTrace(stackTrace, packageName);
  }

  protected markInstalledAppsStale(reason: string): Promise<void> {
    return this.getAppEventRecorder().markInstalledAppsStale(reason);
  }

  protected settleUnattributedFocusedClickRejection(
    requestId: string | null | undefined,
    rejectedCommand: string | undefined,
    errorText: string,
  ): void {
    this.getActionDispatcher().settleUnattributedFocusedClickRejection(
      requestId,
      rejectedCommand,
      errorText,
    );
  }
}

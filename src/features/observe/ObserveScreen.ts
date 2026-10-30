import { AllDisplaysObservation } from "./AllDisplaysObservation";
import { SingleDisplayCaptureStage } from "./SingleDisplayCaptureStage";
import { SingleDisplayReconcileStage } from "./SingleDisplayReconcileStage";
import {
  prototypeCaptureOptions,
  SingleDisplayEnrichStage,
  stampPrototypeHidden,
} from "./SingleDisplayEnrichStage";
import { SingleDisplaySettleStage } from "./SingleDisplaySettleStage";
import type { ObservationCollectionRequest } from "./collectors/ObservationCollectionRequest";
import { type WindowIdentityFreshnessResolver } from "./WindowIdentityFreshness";
import {
  type ActiveWindowAttributionReconciler,
  type PostCaptureForegroundIdentity,
  SYSTEM_UI_WINDOW_PACKAGES,
  resolveBackStackActivityAttribution,
  needsBackStackActivityReconciliation,
} from "./ActiveWindowAttribution";
export { hasUsableHierarchy } from "./ActiveWindowAttribution";
import { publishScreenshotPaths } from "./ScreenshotRetention";
import { resolveIosObserveRotation } from "./iosObserveRotation";
import { type ScreenshotPathProtection } from "./ScreenshotPathProtection";
import { type SelectedDisplayReadPolicy } from "./SelectedDisplayRead";
import {
  identifyObservedHierarchy,
  type HierarchyCapture,
  type HierarchyCaptureRequest,
} from "./HierarchyCapture";
import { logger } from "../../utils/logger";
import {
  BootedDevice,
  ObserveResult,
  requireAndroidOrIosPlatform,
  type ViewHierarchyResult,
} from "../../models";
import type { ScreenshotEncodingOptions } from "./screenshot/screenshotOptions";
import type { ScreenshotService } from "./interfaces/ScreenshotService";
import {
  AdbClientFactory,
  defaultAdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { NoOpPerformanceTracker, PerformanceTracker } from "../../utils/PerformanceTracker";
import { RecompositionTracker } from "../performance/RecompositionTracker";
import { SettledScreenshotCapture } from "./SettledScreenshotCapture";
import { DeviceReadScreenshot } from "./DeviceReadScreenshot";
import { isConfirmedFrameworkErrorDialog } from "./frameworkErrorDialog";
import { StaleHierarchyRecovery } from "./StaleHierarchyRecovery";
import { ScreenshotJobTracker } from "../../utils/ScreenshotJobTracker";
import { Timer, defaultTimer } from "../../utils/SystemTimer";
import { defaultIdGenerator, type IdGenerator } from "../../utils/IdGenerator";
import type {
  CaptureScreenshotOptions,
  DeviceReadOptions,
  ObserveScreen,
  ObserveScreenExecuteOptions,
} from "./interfaces/ObserveScreen";
export type { DeviceReadOptions } from "./interfaces/ObserveScreen";
import type { ObserveScreenDependencies } from "./ObserveScreenDependencies";
import type { ViewHierarchy as ViewHierarchyInterface } from "./interfaces/ViewHierarchy";
import type { PredictiveUIState as PredictiveUIStateInterface } from "./interfaces/PredictiveUIState";

import { getObserveCacheStore } from "./cache/ObserveCacheRegistry";
import type { RecentObserveCacheEntry } from "./cache/ObserveResultCacheStore";
import { getScreenshotStateStore } from "./screenshot/ScreenshotStateRegistry";
import type { ObserveScreenshotRecorder } from "./screenshot/ObserveScreenshotRecorder";
import { createObserveScreenWiring } from "./ObserveScreenWiring";
import {
  resolveObserveScreenDependencies,
  resolveObserveViewHierarchy,
} from "./ObserveScreenDefaults";
import {
  platformObservationTraits,
  type PlatformObservationTraits,
} from "./collectors/PlatformObservationTraits";
import {
  AndroidDisplayBindingCollector,
  type DisplayBindingCollector,
} from "./collectors/DisplayBindingCollector";
import { IosDisplayBindingCollector } from "./collectors/IosDisplayBindingCollector";
import {
  DefaultAndroidObservationCollector,
  scopeActiveWindowToBackStack,
  type AndroidObservationCollector,
} from "./collectors/AndroidObservationCollector";
import {
  DefaultIosObservationCollector,
  type IosObservationCollector,
} from "./collectors/IosObservationCollector";
import type { DeviceStateCollectorPort, HierarchyCollectorPort } from "./collectors/collectorPorts";
import type { PerformanceAuditor } from "./audits/PerformanceAuditor";
import type { AccessibilityAuditor } from "./audits/AccessibilityAuditor";
import type { AccessibilityStateDetector } from "./audits/AccessibilityStateDetector";
import { appendObserveError } from "./ObserveError";
import { resolveScreenshotMode, type ScreenshotMode } from "./automaticScreenshotPolicy";
import { errorMessage as describeError } from "../../utils/describeUnknownError";
import { ObserveElementsBuilder } from "./ObserveElementsBuilder";
import { HierarchyPlatformValidator } from "./HierarchyPlatformValidator";
import { type IosLockStateProbe } from "./ios/IosLockStateProbe";
import { computeFreshness, inheritWrongWindowEvidence } from "./observationFreshness";
import { SafeAreaAuditor, capLayoutWarnings } from "./audits/SafeAreaAuditor";
import { ObservedAndroidDisplayCache, observedIosDisplay } from "./ObservationDisplay";
import { displayTransitions } from "./DisplayTransition";
import { AdbScreenRoundReader, type ScreenRoundReader } from "../wear/screenRound";
import { selectedDisplayPin } from "./SessionDisplayContext";
import { resolveTargetDisplay } from "./DisplaySelection";
export { resolveMissingForegroundWindow } from "./observationVerdict";
import type { ScreenshotEvidenceFiles } from "./screenshot/observationScreenshotEvidence";

/**
 * Observe command class that combines screen details, view hierarchy and screenshot.
 *
 * State (observe-result cache, per-device screenshot state) lives on injected
 * stores. The static methods below preserve the existing API for server
 * resource handlers and the daemon by delegating to those stores.
 */
/**
 * Bound a cached observation's `layoutWarnings` for readers that serialize it
 * directly (the `observation/latest` resources, nav/registry embeds) without
 * going through `finalizeToolResponse`. The audit is cached uncapped so the
 * observe tool's scope-then-cap path (#5074) sees the full set; every other
 * reader must not inherit an unbounded list. Returns a shallow copy so the cache
 * itself is never mutated; the reuse path (`getMostRecent`) is untouched.
 */
function boundCachedLayoutWarnings(result: ObserveResult | undefined): ObserveResult | undefined {
  if (!result?.layoutWarnings) {
    return result;
  }
  const capped = capLayoutWarnings(result.layoutWarnings);
  return capped === result.layoutWarnings ? result : { ...result, layoutWarnings: capped };
}

export class RealObserveScreen implements ObserveScreen {
  private device: BootedDevice;
  private adb: AdbExecutor;
  private adbFactory: AdbClientFactory;
  private timer: Timer;
  private readonly observedAndroidDisplayCache: ObservedAndroidDisplayCache;
  private readonly requestedDisplay?: string;
  private readonly deferredBackStackDisplays = new WeakMap<ObserveResult, number>();
  private idGenerator: IdGenerator;

  private viewHierarchy: ViewHierarchyInterface;
  private readonly hierarchyCapture: HierarchyCapture;
  private readonly selectedDisplayRead: SelectedDisplayReadPolicy;
  private predictiveUIState: PredictiveUIStateInterface;

  private screenshotRecorder: ObserveScreenshotRecorder;
  private readonly screenshotService: ScreenshotService;
  private screenshotEvidenceFiles?: ScreenshotEvidenceFiles;
  private readonly pathProtection: ScreenshotPathProtection;
  private hierarchyCollector: HierarchyCollectorPort;
  private deviceStateCollector: DeviceStateCollectorPort;
  private readonly iosLockStateProbe: IosLockStateProbe;
  private performanceAuditor: Pick<PerformanceAuditor, "run">;
  private accessibilityAuditor: Pick<AccessibilityAuditor, "run">;
  private accessibilityStateDetector: Pick<AccessibilityStateDetector, "run">;
  private elementsBuilder: ObserveElementsBuilder;
  private readonly reconciler: ActiveWindowAttributionReconciler;
  private readonly staleRecovery: StaleHierarchyRecovery;
  private readonly settledScreenshots: SettledScreenshotCapture;
  private readonly deviceReadScreenshot: DeviceReadScreenshot;
  private readonly androidCollector: AndroidObservationCollector;
  private readonly displayBinding: DisplayBindingCollector;
  private readonly platformTraits: PlatformObservationTraits;
  private readonly iosCollector: IosObservationCollector;
  private readonly windowIdentity: WindowIdentityFreshnessResolver;
  private platformValidator: HierarchyPlatformValidator;
  private safeAreaAuditor: SafeAreaAuditor;
  private allDisplays!: AllDisplaysObservation;
  private captureStage!: SingleDisplayCaptureStage;
  private reconcileStage!: SingleDisplayReconcileStage;
  private enrichStage!: SingleDisplayEnrichStage;
  private readonly screenRound: ScreenRoundReader;
  private settleStage!: SingleDisplaySettleStage;

  // ---------- Static API (kept for back-compat with resource handlers/daemon) ----------

  /**
   * The most recent cached observation across all devices, together with the
   * device it came from.
   *
   * Callers that also need the matching screenshot MUST resolve the device here
   * once and then use the `ForDevice` accessors, rather than running a second
   * independent "most recent across all devices" lookup against the screenshot
   * store — those two stores advance independently, so a multi-device daemon
   * could otherwise pair one device's hierarchy with another's screenshot
   * (issue #6600).
   */
  static getRecentCachedObservation(): RecentObserveCacheEntry | undefined {
    const entry = getObserveCacheStore().getRecentInMemoryEntry();
    if (!entry) {
      return undefined;
    }
    const result = boundCachedLayoutWarnings(entry.result);
    return result ? { deviceId: entry.deviceId, result } : undefined;
  }

  static getRecentCachedResult(): ObserveResult | undefined {
    return RealObserveScreen.getRecentCachedObservation()?.result;
  }

  static getRecentCachedResultForDevice(deviceId: string): ObserveResult | undefined {
    return boundCachedLayoutWarnings(getObserveCacheStore().getRecentInMemoryForDevice(deviceId));
  }

  static getRecentCachedScreenshotPathForDevice(deviceId: string): string | undefined {
    return getScreenshotStateStore().getPath(deviceId);
  }

  static getRecentCachedScreenshotErrorForDevice(deviceId: string): string | undefined {
    return getScreenshotStateStore().getError(deviceId);
  }

  static getRecentCachedScreenshotPathForObservation(
    deviceId: string,
    observationId: string,
  ): string | undefined {
    return getScreenshotStateStore().getPathForObservation(deviceId, observationId);
  }

  static getRecentCachedScreenshotErrorForObservation(
    deviceId: string,
    observationId: string,
  ): string | undefined {
    return getScreenshotStateStore().getErrorForObservation(deviceId, observationId);
  }

  /**
   * Clear the in-memory cache (and disk cache).
   * @param deviceId - If provided, only clears cache for that device. Otherwise clears all.
   */
  static clearCache(deviceId?: string): void {
    getObserveCacheStore().clear(deviceId);
    getScreenshotStateStore().clear(deviceId);
    if (deviceId) {
      ScreenshotJobTracker.cancelJob(deviceId);
    } else {
      ScreenshotJobTracker.clear();
    }
  }

  /**
   * Adapter that exposes the static `clearCache` as an `ObserveScreenCache`
   * for dependency injection.
   */
  static readonly defaultObserveScreenCache: import("./interfaces/ObserveScreenCache").ObserveScreenCache =
    {
      clearForDevice(deviceId: string): void {
        RealObserveScreen.clearCache(deviceId);
      },
    };

  // ---------- Constructor ----------

  constructor(
    device: BootedDevice,
    adbFactory: AdbClientFactory = defaultAdbClientFactory,
    dependencies?: ObserveScreenDependencies,
    timer: Timer = defaultTimer,
    idGenerator: IdGenerator = defaultIdGenerator,
  ) {
    this.device = device;
    this.adbFactory = adbFactory;
    this.adb = adbFactory.create(device);
    this.timer = timer;
    this.observedAndroidDisplayCache = new ObservedAndroidDisplayCache(timer);
    this.requestedDisplay = dependencies?.display;
    this.selectedDisplayRead = dependencies?.selectedDisplayRead ?? {};
    this.idGenerator = idGenerator;
    this.screenRound = new AdbScreenRoundReader(this.adb);

    const wiring = createObserveScreenWiring({
      device,
      adb: () => this.adb,
      adbFactory: () => this.adbFactory,
      observeScreenProvider: () => this,
      identity: {
        device: () => this.device,
        viewHierarchy: () => this.viewHierarchy,
        deviceStateCollector: () => this.deviceStateCollector,
        timer: () => this.timer,
        platformValidator: () => this.platformValidator,
        resolveObservationTimestampMs: (result) => this.resolveObservationTimestampMs(result),
        extractScreenSizeFromHierarchy: (hierarchy) =>
          this.extractScreenSizeFromHierarchy(hierarchy),
      },
    });

    const defaultsContext = {
      device,
      adbFactory: this.adbFactory,
      timer,
      idGenerator,
      wiring,
      dependencies,
    };
    this.viewHierarchy = resolveObserveViewHierarchy(defaultsContext);
    const { sources, services } = resolveObserveScreenDependencies(defaultsContext);
    this.hierarchyCapture = sources.hierarchyCapture;
    this.screenshotService = sources.screenshotService;
    this.predictiveUIState = sources.predictiveUIState;
    this.pathProtection = services.pathProtection;
    this.screenshotRecorder = services.screenshotRecorder;
    this.screenshotEvidenceFiles = services.screenshotEvidenceFiles;
    this.hierarchyCollector = services.hierarchyCollector;
    this.deviceStateCollector = services.deviceStateCollector;
    this.iosLockStateProbe = services.iosLockStateProbe;
    this.performanceAuditor = services.performanceAuditor;
    this.accessibilityAuditor = services.accessibilityAuditor;
    this.accessibilityStateDetector = services.accessibilityStateDetector;
    this.elementsBuilder = new ObserveElementsBuilder();
    this.platformValidator = services.platformValidator;
    this.safeAreaAuditor = new SafeAreaAuditor();
    this.windowIdentity = services.windowIdentity;
    this.reconciler = services.reconciler;
    this.settledScreenshots = new SettledScreenshotCapture({
      device: () => this.device,
      timer: () => this.timer,
      screenshotRecorder: () => this.screenshotRecorder,
      screenshotEvidenceFiles: () => this.screenshotEvidenceFiles,
      pathProtection: () => this.pathProtection,
    });
    this.deviceReadScreenshot = new DeviceReadScreenshot({
      device: () => this.device,
      adb: () => this.adb,
      timer: () => this.timer,
      requestedDisplay: () => this.requestedDisplay,
      observedAndroidDisplayCache: () => this.observedAndroidDisplayCache,
      screenshotService: () => this.screenshotService,
      screenshotEvidenceFiles: () => this.screenshotEvidenceFiles,
      pathProtection: () => this.pathProtection,
      settledScreenshots: () => this.settledScreenshots,
    });
    this.staleRecovery = new StaleHierarchyRecovery({
      timer: () => this.timer,
      device: () => this.device,
      viewHierarchy: () => this.viewHierarchy,
      deviceStateCollector: () => this.deviceStateCollector,
      platformValidator: () => this.platformValidator,
      reconciler: () => this.reconciler,
    });
    // Lazy getters: tests may reassign these collaborators on the instance after construction.
    this.androidCollector = new DefaultAndroidObservationCollector({
      hierarchyCollector: () => this.hierarchyCollector,
      deviceStateCollector: () => this.deviceStateCollector,
      viewHierarchy: () => this.viewHierarchy,
      device: () => this.device,
    });
    this.platformTraits = platformObservationTraits(device.platform, () => this.device);
    const displayBindingDeps = { device: () => this.device, adb: () => this.adb };
    this.displayBinding =
      device.platform === "ios"
        ? new IosDisplayBindingCollector(displayBindingDeps)
        : new AndroidDisplayBindingCollector(displayBindingDeps);
    this.iosCollector = new DefaultIosObservationCollector({
      hierarchyCollector: () => this.hierarchyCollector,
      viewHierarchy: () => this.viewHierarchy,
      device: () => this.device,
    });
    this.createStages();
  }

  private createStages(): void {
    this.allDisplays = new AllDisplaysObservation({
      device: () => this.device,
      timer: () => this.timer,
      pathProtection: () => this.pathProtection,
      executeSingleDisplay: (options) => this.executeSingleDisplay(options),
      captureDeviceReadScreenshot: (...args) => this.captureDeviceReadScreenshot(...args),
      createCriticalFallback: (error) => this.createCriticalFallback(error),
      createBaseResult: () => this.createBaseResult(),
    });
    this.captureStage = new SingleDisplayCaptureStage({
      device: () => this.device,
      timer: () => this.timer,
      displayBinding: () => this.displayBinding,
      hierarchyCapture: () => this.hierarchyCapture,
      hierarchyCollector: () => this.hierarchyCollector,
      deviceStateCollector: () => this.deviceStateCollector,
      iosLockStateProbe: () => this.iosLockStateProbe,
      observedAndroidDisplayCache: () => this.observedAndroidDisplayCache,
      requestedDisplay: () => this.requestedDisplay,
      selectedDisplayRead: () => this.selectedDisplayRead,
      createBaseResult: () => this.createBaseResult(),
      createCriticalFallback: (error, options) => this.createCriticalFallback(error, options),
      collectAllData: (result, request) => this.collectAllData(result, request),
    });
    this.reconcileStage = new SingleDisplayReconcileStage({
      device: () => this.device,
      timer: () => this.timer,
      windowIdentity: () => this.windowIdentity,
      staleRecovery: () => this.staleRecovery,
      displayBinding: () => this.displayBinding,
      platformValidator: () => this.platformValidator,
      reconcileActiveWindowAttribution: (result, options) =>
        this.reconcileActiveWindowAttribution(result, options),
      isConfirmedFrameworkErrorDialog: (viewHierarchy, signal) =>
        this.isConfirmedFrameworkErrorDialog(viewHierarchy, signal),
    });
    this.enrichStage = new SingleDisplayEnrichStage({
      device: () => this.device,
      timer: () => this.timer,
      platformTraits: () => this.platformTraits,
      screenshotRecorder: () => this.screenshotRecorder,
      pathProtection: () => this.pathProtection,
      performanceAuditor: () => this.performanceAuditor,
      accessibilityAuditor: () => this.accessibilityAuditor,
      accessibilityStateDetector: () => this.accessibilityStateDetector,
      predictiveUIState: () => this.predictiveUIState,
      safeAreaAuditor: () => this.safeAreaAuditor,
      elementsBuilder: () => this.elementsBuilder,
      screenRound: () => this.screenRound,
      deferredBackStackDisplays: () => this.deferredBackStackDisplays,
      stampScreenSizeUnits: (result) => this.stampScreenSizeUnits(result),
      processRecomposition: (result, perf) => this.processRecomposition(result, perf),
      captureSettledScreenshot: (...args) => this.captureSettledScreenshot(...args),
    });
    this.settleStage = new SingleDisplaySettleStage({
      device: () => this.device,
      timer: () => this.timer,
      windowIdentity: () => this.windowIdentity,
      deviceStateCollector: () => this.deviceStateCollector,
      platformTraits: () => this.platformTraits,
      identifyCapture: (result, freshness) => this.identifyCapture(result, freshness),
      resolveObservationTimestampMs: (result) => this.resolveObservationTimestampMs(result),
    });
  }

  // ---------- Public API ----------

  /** Use the normal observation assembly with an isolated observer hierarchy capture. */
  async executeDeviceRead(
    signal?: AbortSignal,
    screenshot: ScreenshotMode = "settled",
    screenshotOptions?: ScreenshotEncodingOptions,
    options: DeviceReadOptions = {},
  ): Promise<ObserveResult> {
    const { requireFreshScreenshot = false, timeoutMs } = options;
    if (this.requestedDisplay === "all") {
      return this.allDisplays.execute({
        observerMode: true,
        skipCache: true,
        skipRecompositionTracking: true,
        skipPerformanceAudit: true,
        skipAccessibilityAudit: true,
        screenshot: "none",
        signal,
        timeoutMs,
        deviceReadScreenshot: screenshot === "none" ? undefined : (screenshotOptions ?? {}),
      });
    }
    const result = await this.execute({
      observerMode: true,
      skipCache: true,
      skipRecompositionTracking: true,
      skipPerformanceAudit: true,
      skipAccessibilityAudit: true,
      screenshot: "none",
      signal,
    });
    if (result.viewHierarchy?.hierarchyServiceStarted) {
      result.hierarchyServiceStarted = true;
      delete result.viewHierarchy.hierarchyServiceStarted;
    }
    if (screenshot === "none") {
      result.screenshotCaptureAttempted = false;
      return result;
    }
    await this.captureDeviceReadScreenshot(result, signal, screenshotOptions, {
      requireFreshScreenshot,
    });
    if (result.screenshotPath) {
      result.screenshotExpiresAt = await this.pathProtection.protect(result.screenshotPath);
    }
    return result;
  }

  private captureDeviceReadScreenshot(
    ...args: Parameters<DeviceReadScreenshot["captureDeviceReadScreenshot"]>
  ): Promise<void> {
    return this.deviceReadScreenshot.captureDeviceReadScreenshot(...args);
  }

  /**
   * Fetch raw view hierarchy and attach it to an existing observe result.
   * Call this after execute() when raw hierarchy data is needed.
   */
  async appendRawViewHierarchy(result: ObserveResult, signal?: AbortSignal): Promise<void> {
    // The raw (unfiltered) hierarchy is the companion to the validated primary
    // hierarchy. If execute() discarded the primary as cross-platform (stale
    // connection), re-fetching raw from the same connection would reintroduce the
    // other platform's data the validation just scrubbed — so skip it.
    if (!result.viewHierarchy) {
      return;
    }
    // The raw tree must come from the display the observation describes: an
    // explicit panel (or a session pin, which arrives as `requestedDisplay`)
    // resolves to its logical id exactly like the filtered read and screenshot;
    // the default display sends no id.
    const displayId = await this.deviceReadScreenshot.resolveReadDisplayId(result, { signal });
    await this.hierarchyCollector.collectRaw(result, signal, displayId);
  }

  private async readCachedObservationForTarget(): Promise<ObserveResult | undefined> {
    const stored = await getObserveCacheStore().getMostRecent(this.device.deviceId);
    if (!stored || (this.device.displays?.panels.length ?? 0) <= 1) {
      return stored;
    }
    const focusedPanel = displayTransitions.currentObservedPanel(this.device.deviceId);
    // Explicit observations do not update the default panel's transition stamp.
    // Before its first observation, reuse the live resolver unless the request
    // already selects a panel; explicit "active" still needs live state.
    const explicitPanel = ![undefined, "active"].includes(this.requestedDisplay);
    const activeDisplay =
      focusedPanel || explicitPanel
        ? undefined
        : this.device.platform === "android"
          ? (await this.observedAndroidDisplayCache.resolve(this.device, this.adb)).display
          : observedIosDisplay(this.device, stored.viewHierarchy);
    const { key: activePanelKey, posture } = activeDisplay ?? {};
    const panel = resolveTargetDisplay(this.device.displays, this.requestedDisplay, {
      focusedPanelKey: focusedPanel?.key,
      activePanelKey,
      posture,
      displayPin: selectedDisplayPin(),
    });
    // Keep the entry for repeated explicit-panel reads; a different target is a miss.
    // On multi-panel devices, a missing display key cannot prove the target: miss.
    return stored.display?.key === panel.key ? stored : undefined;
  }

  /**
   * Get the most recent cached observe result from memory or disk cache.
   */
  async getMostRecentCachedObserveResult(): Promise<ObserveResult> {
    const startTime = this.timer.now();
    try {
      logger.debug("[OBSERVE_CACHE] Getting most recent cached observe result");
      const stored = await this.readCachedObservationForTarget();
      const cached =
        stored && this.device.platform === "ios"
          ? {
              ...stored,
              rotation: resolveIosObserveRotation(
                stored.viewHierarchy?.rotation,
                stored.screenSize,
              ),
            }
          : stored;
      const duration = this.timer.now() - startTime;
      if (cached) {
        await publishScreenshotPaths(cached, this.pathProtection);
        logger.debug(`[OBSERVE_CACHE] Found recent result in cache (${duration}ms)`);
        this.identifyCapture(cached, "cached-ok");
        // A cache read does not re-verify the hierarchy, even when the capture
        // was verified when stored. Recompute its age in the host clock domain.
        const freshness = computeFreshness({
          actualTimestamp: this.resolveObservationTimestampMs(cached),
          hostAgeBasisMs: this.windowIdentity.resolveHostReceivedAtMs(cached),
          now: this.timer.now(),
        });
        freshness.requestedAfter = cached.freshness?.requestedAfter;
        const displayChanged =
          (cached.displayRevision !== undefined &&
            cached.displayRevision !== displayTransitions.revision(this.device.deviceId)) ||
          displayTransitions.geometryChanged(this.device.deviceId, cached.screenSize);
        if (cached.freshness?.isFresh === false) {
          return inheritWrongWindowEvidence(cached, {
            ...cached,
            freshness: { ...cached.freshness, ageMs: freshness.ageMs },
          });
        }
        return {
          ...cached,
          freshness: displayChanged
            ? {
                ...freshness,
                isFresh: false,
                category: "cache_age",
                warning: "Display changed since this observation was captured; observe again.",
              }
            : freshness,
        };
      }
      logger.debug(`[OBSERVE_CACHE] No cached observe result available (${duration}ms)`);
      // No display stamp is available; the placeholder generation remains 0.
      return { ...this.createBaseResult(), error: "No cached observe result available" };
    } catch (error) {
      const duration = this.timer.now() - startTime;
      logger.warn(
        `[OBSERVE_CACHE] Error getting cached observe result after ${duration}ms: ${error}`,
      );
      // No display stamp is available; the placeholder generation remains 0.
      return { ...this.createBaseResult(), error: "Failed to retrieve cached observe result" };
    }
  }

  /**
   * Execute the observe command.
   */
  async execute(options?: ObserveScreenExecuteOptions): Promise<ObserveResult> {
    if ((options?.display ?? this.requestedDisplay) === "all") {
      return this.allDisplays.execute(options);
    }
    return this.executeSingleDisplay(options);
  }

  private async executeSingleDisplay(
    options?: ObserveScreenExecuteOptions & { preserveDisplayState?: boolean },
  ): Promise<ObserveResult> {
    const intent = this.captureStage.resolveSingleDisplayIntent(options);
    try {
      const run = await this.captureStage.beginSingleDisplay(intent);
      const captured = await this.captureStage.captureSingleDisplay(run);
      if (captured.earlyResult) {
        return captured.earlyResult;
      }
      const reconciled = await this.reconcileStage.reconcileSingleDisplay(run, captured);
      await this.enrichStage.enrichSingleDisplay(run);
      await this.settleStage.settleSingleDisplay(run, captured, reconciled);
      return await this.enrichStage.publishSingleDisplay(run);
    } catch (err) {
      return await this.captureStage.failSingleDisplay(err, intent);
    }
  }

  /** Build the ordinary critical fallback without mutating screenshot or display state. */
  private createCriticalFallback(
    error: unknown,
    options: { fallback?: ObserveResult } = {},
  ): ObserveResult {
    const { fallback = this.createBaseResult() } = options;
    const errorMessage = error instanceof Error ? error.stack || error.message : String(error);
    this.stampScreenSizeUnits(fallback);
    appendObserveError(fallback, {
      phase: "critical",
      message: "Observation failed due to device access error",
      cause: errorMessage,
    });
    // Consumers treat a missing freshness as fresh, so a critical fallback always marks it unavailable.
    fallback.freshness = computeFreshness({
      now: this.timer.now(),
      unavailable: true,
      unavailableReason: "unknown",
      unavailableDetail: errorMessage,
    });
    return fallback;
  }

  private identifyCapture(
    result: ObserveResult,
    freshness: HierarchyCaptureRequest["freshness"],
  ): void {
    if (
      result.viewHierarchy &&
      typeof result.viewHierarchy === "object" &&
      !result.viewHierarchy.hierarchy?.error
    ) {
      identifyObservedHierarchy(
        requireAndroidOrIosPlatform(this.device.platform, "Observing the view hierarchy"),
        result.viewHierarchy,
        freshness,
        {
          timer: this.timer,
          ids: this.idGenerator,
          captureId: result.observationId,
          iosMultiPanel: this.platformTraits.isIosMultiPanel(),
        },
      );
    }
  }

  async processRecomposition(
    observation: ObserveResult,
    _perf?: PerformanceTracker,
  ): Promise<void> {
    await RecompositionTracker.getInstance().processObservation(observation, this.device);
  }

  /**
   * Capture visual evidence without re-reading the hierarchy. Automatic
   * post-action and waitFor flows use this after their final observation so a
   * retry/poll loop creates at most one screenshot.
   */
  private async screenshotDisplayId(
    signal?: AbortSignal,
    observation?: ObserveResult,
  ): Promise<number | undefined> {
    if (this.device.platform !== "android" || this.requestedDisplay === "active") {
      return undefined;
    }
    const display = this.requestedDisplay || observation?.display?.key;
    if (!display) {
      return undefined;
    }
    try {
      const panel = resolveTargetDisplay(this.device.displays, display, {});
      const displayId = await this.observedAndroidDisplayCache.logicalIdForPanel(
        this.device,
        this.adb,
        panel.key,
        signal,
      );
      // Inferred primary-panel captures retain the legacy command; explicit selectors keep their id.
      return !this.requestedDisplay && displayId === 0 ? undefined : displayId;
    } catch (error) {
      if (this.requestedDisplay) {
        throw error;
      }
      // Observation hints are optional; legacy capture remains safe if the panel cannot be resolved.
      logger.debug(
        `Screenshot panel "${display}" could not be mapped; using default display: ${describeError(error).replace(/\s+/g, " ")}`,
      );
      return undefined;
    }
  }

  async captureScreenshot(
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    { signal, observation, screenshot, screenshotOptions }: CaptureScreenshotOptions = {},
  ): Promise<void> {
    const screenshotObservation = observation ?? this.createBaseResult();
    const displayId = await this.screenshotDisplayId(signal, observation);
    const screenshotMode = resolveScreenshotMode(screenshot);
    const capture = prototypeCaptureOptions(screenshotOptions);
    if (observation) {
      observation.screenshotCaptureAttempted = true;
      stampPrototypeHidden(observation, capture);
      if (screenshotMode === "settled") {
        observation.screenshotOrientation = this.platformTraits.settledScreenshotOrientation();
      }
    }
    if (screenshotMode === "settled") {
      await this.captureSettledScreenshot(screenshotObservation, perf, signal, {
        strict: screenshot === "settled",
        displayId,
        screenshotOptions,
      });
    } else {
      await this.screenshotRecorder.captureFresh(screenshotObservation.observationId, {
        perf,
        signal,
        displayId,
        capture,
      });
    }
    if (observation) {
      await this.runAccessibilityAudit(observation, perf);
    }
  }

  private captureSettledScreenshot(
    ...args: Parameters<SettledScreenshotCapture["captureSettledScreenshot"]>
  ): Promise<void> {
    return this.settledScreenshots.captureSettledScreenshot(...args);
  }

  async runAccessibilityAudit(
    observation: ObserveResult,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
  ): Promise<void> {
    await this.accessibilityAuditor.run(observation, perf);
  }

  // ---------- Public collector wrappers (kept for back-compat with existing tests) ----------

  /**
   * Back-compat shim: prefer `appendObserveError(result, { phase, message, cause })`.
   * This wrapper records errors with phase "critical" so they land in `result.errors`
   * as well as the derived `result.error` string.
   */
  appendError(result: ObserveResult, newError: string): void {
    appendObserveError(result, { phase: "critical", message: newError });
  }

  /**
   * Back-compat shim around {@link HierarchyCollector.extractScreenSize}.
   */
  extractScreenSizeFromHierarchy(
    viewHierarchy: ObserveResult["viewHierarchy"],
  ): { width: number; height: number } | null {
    return this.hierarchyCollector.extractScreenSize(
      viewHierarchy,
      this.platformTraits.isIosMultiPanel(),
    );
  }

  createBaseResult(): ObserveResult {
    return {
      observationId: this.idGenerator.next(),
      // The concrete device this observation ran against (issue #7018). The
      // resolved id is surfaced so the serialization chokepoint can build the
      // observation-scoped screenshot resource URI (which needs deviceId too).
      deviceId: this.device.deviceId,
      // Discovery omits single-panel inventory; logical display "0" is the
      // stable fallback until a physical panel can be identified.
      // No display stamp is available; the placeholder generation remains 0.
      display: { key: "0", role: "unknown", posture: "unknown", generation: 0 },
      // Derive the timestamp from the injected timer so the source is pinnable
      // in tests instead of the real wall clock (issue #4172 item 9).
      updatedAt: new Date(this.timer.now()).toISOString(),
      screenSize: { width: 0, height: 0 },
      systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      insets: { available: false, source: "unavailable", units: "unknown" },
    };
  }

  /** Attach the output coordinate unit without changing the captured dimensions. */
  private stampScreenSizeUnits(result: ObserveResult): void {
    result.screenSize = {
      ...result.screenSize,
      units: this.platformTraits.screenSizeUnits(),
    };
  }

  /** Capture the current generation before a poll so deferred writes respect invalidation. */
  captureCacheGeneration(): number {
    return getObserveCacheStore().currentGeneration(this.device.deviceId);
  }

  /** Cache a selected poll result with its observation-start generation and host time. */
  async cacheObserveResult(
    observeResult: ObserveResult,
    generation?: number,
    cachedAt?: number,
  ): Promise<void> {
    if (
      observeResult.displayRevision !== undefined &&
      observeResult.displayRevision !== displayTransitions.revision(this.device.deviceId)
    ) {
      return;
    }
    const cacheStore = getObserveCacheStore();
    const resolvedCachedAt = cachedAt ?? this.timer.now();
    const currentResult = cacheStore.getRecentInMemoryForDevice(this.device.deviceId);
    const currentCachedAt = cacheStore.getRecentCachedAtForDevice(this.device.deviceId);
    if (
      currentResult !== undefined &&
      currentResult.observationId !== observeResult.observationId &&
      currentCachedAt !== undefined &&
      currentCachedAt > resolvedCachedAt
    ) {
      logger.debug(
        `[OBSERVE_CACHE] Skipping deferred observe result for device ${this.device.deviceId}: ` +
          "a more recently cached observation already exists",
      );
      return;
    }
    await cacheStore.put(this.device.deviceId, observeResult, generation, resolvedCachedAt);
  }

  // ---------- Orchestration ----------

  /** Attach the terminal stack and report whether a full poll must reconcile its attribution. */
  async collectDeferredBackStack(
    observation: ObserveResult,
    options: { signal?: AbortSignal } = {},
  ): Promise<boolean> {
    const displayId = this.deferredBackStackDisplays.get(observation);
    if (displayId === undefined || this.device.platform !== "android" || observation.backStack) {
      return false;
    }
    await this.deviceStateCollector.collectBackStack(
      observation,
      new NoOpPerformanceTracker(),
      options.signal,
      displayId,
    );
    // The collector scoped this stack to the capture's display. Compare before
    // multi-display scoping can overwrite the captured activity name.
    const attribution = resolveBackStackActivityAttribution(observation);
    const activeWindow = observation.activeWindow;
    const disagrees = Boolean(
      attribution &&
      activeWindow &&
      !SYSTEM_UI_WINDOW_PACKAGES.has(observation.viewHierarchy?.packageName ?? "") &&
      !SYSTEM_UI_WINDOW_PACKAGES.has(activeWindow.appId) &&
      needsBackStackActivityReconciliation(observation, activeWindow, attribution),
    );
    scopeActiveWindowToBackStack(observation);
    return disagrees;
  }

  /**
   * Collect all observation data with platform-specific orchestration.
   *
   * Public + parameterized for back-compat with existing tests and for callers
   * that need to assemble an `ObserveResult` without the full `execute()` pipeline.
   */
  collectAllData(result: ObserveResult, request: ObservationCollectionRequest = {}): Promise<void> {
    const context = {
      result,
      queryOptions: request.queryOptions,
      perf: request.perf ?? new NoOpPerformanceTracker(),
      skipWaitForFresh: request.skipWaitForFresh ?? false,
      minTimestamp: request.minTimestamp ?? 0,
      signal: request.signal,
      readOnly: request.readOnly ?? false,
      capturedHierarchy: request.capturedHierarchy,
      readOptions: request.readOptions,
    };
    switch (this.device.platform) {
      case "android":
        return this.androidCollector.collect({
          ...context,
          skipBackStack: request.skipBackStack ?? false,
          displayId: request.displayId ?? 0,
        });
      case "ios":
        return this.iosCollector.collect(context);
      default:
        return Promise.resolve();
    }
  }

  // ---------- Helpers ----------

  private reconcileActiveWindowAttribution(
    result: ObserveResult,
    options: { signal?: AbortSignal; readOnly?: boolean } = {},
  ): Promise<PostCaptureForegroundIdentity> {
    return this.reconciler.reconcileActiveWindowAttribution(result, options);
  }

  private applyRecapturedHierarchy(
    result: ObserveResult,
    hierarchy: NonNullable<ObserveResult["viewHierarchy"]>,
  ): void {
    return this.reconciler.applyRecapturedHierarchy(result, hierarchy);
  }

  private recorrelateActiveWindowToRecapture(
    result: ObserveResult,
    hierarchy: NonNullable<ObserveResult["viewHierarchy"]>,
  ): void {
    return this.reconciler.recorrelateActiveWindowToRecapture(result, hierarchy);
  }

  private recaptureHierarchyForSystemUiOverlay(
    result: ObserveResult,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return this.reconciler.recaptureHierarchyForSystemUiOverlay(result, signal);
  }

  private recaptureHierarchyForBackStackAttribution(
    result: ObserveResult,
    expected: { packageName: string; activityName: string },
    signal?: AbortSignal,
  ): Promise<boolean> {
    return this.reconciler.recaptureHierarchyForBackStackAttribution(result, expected, signal);
  }

  private isConfirmedFrameworkErrorDialog(
    viewHierarchy: ViewHierarchyResult | undefined,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return isConfirmedFrameworkErrorDialog(this.adb, viewHierarchy, signal);
  }

  private resolveObservationTimestampMs(result: ObserveResult): number | undefined {
    return result.viewHierarchy?.updatedAt;
  }
}

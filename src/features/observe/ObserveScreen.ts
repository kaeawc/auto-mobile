import { logger } from "../../utils/logger";
import { throwIfAborted } from "../../utils/toolUtils";
import { BootedDevice, ObserveResult, ScreenIdentity } from "../../models";
import { ViewHierarchy } from "./ViewHierarchy";
import { Window } from "./Window";
import { TakeScreenshot } from "./TakeScreenshot";
import { GetBackStack } from "./GetBackStack";
import { AdbClientFactory, defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { NoOpPerformanceTracker, PerformanceTracker, processTimingData } from "../../utils/PerformanceTracker";
import { serverConfig } from "../../utils/ServerConfig";
import { RecompositionTracker } from "../performance/RecompositionTracker";
import { PredictiveUIState } from "./PredictiveUIState";
import { ScreenshotJobTracker } from "../../utils/ScreenshotJobTracker";
import { Timer, defaultTimer } from "../../utils/SystemTimer";
import { attachRawViewHierarchy } from "../../utils/viewHierarchySearch";
import type { ObserveScreen, ObserveScreenExecuteOptions } from "./interfaces/ObserveScreen";
import type { ObserveScreenDependencies } from "./ObserveScreenDependencies";
import type { ViewHierarchy as ViewHierarchyInterface } from "./interfaces/ViewHierarchy";
import type { PredictiveUIState as PredictiveUIStateInterface } from "./interfaces/PredictiveUIState";

import { getObserveCacheStore, setObserveCacheStore } from "./cache/ObserveCacheRegistry";
import { getScreenshotStateStore, setScreenshotStateStore } from "./screenshot/ScreenshotStateRegistry";
import {
  DefaultObserveScreenshotRecorder,
  ObserveScreenshotRecorder,
  TrackedScreenshotService
} from "./screenshot/ObserveScreenshotRecorder";
import { HierarchyCollector } from "./collectors/HierarchyCollector";
import { DeviceStateCollector } from "./collectors/DeviceStateCollector";
import { PerformanceAuditor } from "./audits/PerformanceAuditor";
import { AccessibilityAuditor, resolveLatestScreenshotPath } from "./audits/AccessibilityAuditor";
import { AccessibilityStateDetector } from "./audits/AccessibilityStateDetector";
import { appendObserveError } from "./ObserveError";
import { ObserveElementsBuilder } from "./ObserveElementsBuilder";
import {
  enforceHierarchyPlatform,
  HierarchyPlatformValidator,
  RealHierarchyPlatformValidator
} from "./HierarchyPlatformValidator";
import { deriveIosScreenIdentity } from "./ios/IosScreenIdentity";
import { SafeAreaAuditor } from "./audits/SafeAreaAuditor";

/**
 * Observe command class that combines screen details, view hierarchy and screenshot.
 *
 * State (observe-result cache, per-device screenshot state) lives on injected
 * stores. The static methods below preserve the existing API for server
 * resource handlers and the daemon by delegating to those stores.
 */
export class RealObserveScreen implements ObserveScreen {
  private device: BootedDevice;
  private adb: AdbExecutor;
  private adbFactory: AdbClientFactory;
  private timer: Timer;

  private viewHierarchy: ViewHierarchyInterface;
  private predictiveUIState: PredictiveUIStateInterface;

  private screenshotRecorder: ObserveScreenshotRecorder;
  private hierarchyCollector: HierarchyCollector;
  private deviceStateCollector: DeviceStateCollector;
  private performanceAuditor: PerformanceAuditor;
  private accessibilityAuditor: AccessibilityAuditor;
  private accessibilityStateDetector: AccessibilityStateDetector;
  private elementsBuilder: ObserveElementsBuilder;
  private platformValidator: HierarchyPlatformValidator;
  private safeAreaAuditor: SafeAreaAuditor;

  // ---------- Static API (kept for back-compat with resource handlers/daemon) ----------

  static getRecentCachedResult(): ObserveResult | undefined {
    return getObserveCacheStore().getRecentInMemory();
  }

  static getRecentCachedResultForDevice(deviceId: string): ObserveResult | undefined {
    return getObserveCacheStore().getRecentInMemoryForDevice(deviceId);
  }

  static getRecentCachedScreenshotPath(): string | undefined {
    return getScreenshotStateStore().getPath();
  }

  static getRecentCachedScreenshotPathForDevice(deviceId: string): string | undefined {
    return getScreenshotStateStore().getPath(deviceId);
  }

  static getRecentCachedScreenshotError(): string | undefined {
    return getScreenshotStateStore().getError();
  }

  static getRecentCachedScreenshotErrorForDevice(deviceId: string): string | undefined {
    return getScreenshotStateStore().getError(deviceId);
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
  static readonly defaultObserveScreenCache: import("./interfaces/ObserveScreenCache").ObserveScreenCache = {
    clearForDevice(deviceId: string): void {
      RealObserveScreen.clearCache(deviceId);
    },
  };

  // ---------- Constructor ----------

  constructor(
    device: BootedDevice,
    adbFactory: AdbClientFactory = defaultAdbClientFactory,
    dependencies?: ObserveScreenDependencies,
    timer: Timer = defaultTimer
  ) {
    this.device = device;
    this.adbFactory = adbFactory;
    this.adb = adbFactory.create(device);
    this.timer = timer;

    // Data sources (either injected or default)
    this.viewHierarchy = dependencies?.viewHierarchy ?? new ViewHierarchy(device, this.adbFactory);
    const window = dependencies?.window ?? new Window(device, this.adbFactory);
    const screenshotUtil = dependencies?.screenshot ?? new TakeScreenshot(device, this.adbFactory);
    const backStack = dependencies?.backStack ?? new GetBackStack(device, this.adbFactory);
    this.predictiveUIState = dependencies?.predictiveUIState ?? new PredictiveUIState();

    // Caches: install injected stores into the registry so instance methods AND
    // the static accessors (used by server resource handlers) share state.
    // Tests that need isolation should call setObserveCacheStore / setScreenshotStateStore
    // with a fake in beforeEach and resetObserveCacheStore / resetScreenshotStateStore
    // in afterEach.
    if (dependencies?.cacheStore) {
      setObserveCacheStore(dependencies.cacheStore);
    }
    if (dependencies?.screenshotStateStore) {
      setScreenshotStateStore(dependencies.screenshotStateStore);
    }

    // Composed services
    this.screenshotRecorder = dependencies?.screenshotRecorder ?? new DefaultObserveScreenshotRecorder(
      device,
      screenshotUtil as TrackedScreenshotService,
      getScreenshotStateStore()
    );
    this.hierarchyCollector = dependencies?.hierarchyCollector ?? new HierarchyCollector({
      device,
      viewHierarchy: this.viewHierarchy,
      adb: this.adb,
      adbFactory: this.adbFactory,
      timer: this.timer,
    });
    this.deviceStateCollector = dependencies?.deviceStateCollector ?? new DeviceStateCollector({
      device,
      window,
      backStack,
      adb: this.adb,
      timer: this.timer,
    });
    this.performanceAuditor = dependencies?.performanceAuditor ?? new PerformanceAuditor({
      device,
      adbFactory: this.adbFactory,
    });
    this.accessibilityAuditor = dependencies?.accessibilityAuditor ?? new AccessibilityAuditor({
      device,
      // Prefer the recorder-backed cached path before falling back to disk scan.
      screenshotPathResolver: () => resolveLatestScreenshotPath(
        () => getScreenshotStateStore().getPath(this.device.deviceId)
      ),
    });
    this.accessibilityStateDetector = dependencies?.accessibilityStateDetector ?? new AccessibilityStateDetector({
      device,
      adb: this.adb,
    });
    this.elementsBuilder = new ObserveElementsBuilder();
    this.platformValidator = dependencies?.platformValidator ?? new RealHierarchyPlatformValidator();
    this.safeAreaAuditor = new SafeAreaAuditor();
  }

  // ---------- Public API ----------

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
    await this.hierarchyCollector.collectRaw(result, signal);
  }

  /**
   * Get the most recent cached observe result from memory or disk cache.
   */
  async getMostRecentCachedObserveResult(): Promise<ObserveResult> {
    const startTime = this.timer.now();
    try {
      logger.debug("[OBSERVE_CACHE] Getting most recent cached observe result");
      const cached = await getObserveCacheStore().getMostRecent(this.device.deviceId);
      const duration = this.timer.now() - startTime;
      if (cached) {
        logger.debug(`[OBSERVE_CACHE] Found recent result in cache (${duration}ms)`);
        return cached;
      }
      logger.debug(`[OBSERVE_CACHE] No cached observe result available (${duration}ms)`);
      return {
        updatedAt: new Date().toISOString(),
        screenSize: { width: 0, height: 0 },
        systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
        error: "No cached observe result available"
      };
    } catch (error) {
      const duration = this.timer.now() - startTime;
      logger.warn(`[OBSERVE_CACHE] Error getting cached observe result after ${duration}ms: ${error}`);
      return {
        updatedAt: new Date().toISOString(),
        screenSize: { width: 0, height: 0 },
        systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
        error: "Failed to retrieve cached observe result"
      };
    }
  }

  /**
   * Execute the observe command.
   */
  async execute(options?: ObserveScreenExecuteOptions): Promise<ObserveResult> {
    const queryOptions = options?.queryOptions;
    const perf = options?.perf ?? new NoOpPerformanceTracker();
    const skipWaitForFresh = options?.skipWaitForFresh ?? true;
    const minTimestamp = options?.minTimestamp ?? 0;
    const signal = options?.signal;
    const skipBackStack = options?.skipBackStack ?? false;
    const skipScreenshot = options?.skipScreenshot ?? false;

    try {
      logger.debug(`Executing observe command (skipWaitForFresh=${skipWaitForFresh}, minTimestamp=${minTimestamp})`);
      const startTime = this.timer.now();
      throwIfAborted(signal);

      const result = this.createBaseResult();

      perf.serial("observe");

      // Phase 1+2: hierarchy + derived device state (platform-specific orchestration).
      await this.collectAllData(result, queryOptions, perf, skipWaitForFresh, minTimestamp, signal, skipBackStack);

      // Reject a stale cross-platform hierarchy (e.g. an iOS hierarchy returned on
      // an Android device via a stale connection) at the source — before deriving
      // elements/predictions and before caching below — so that no downstream
      // consumer (tool response, observe cache, LATEST_OBSERVATION resource, or the
      // navigation-graph recorder) ever observes the other platform's data.
      enforceHierarchyPlatform(result, this.device.platform, this.device.deviceId, this.platformValidator);

      // Uncapped here; the output boundary (sanitizeObserveResult / the observe
      // served path in finalizeToolResponse) caps AFTER any scope narrowing so an
      // in-scope warning is never lost to a cap taken against the full tree (#5074).
      result.layoutWarnings = { scope: "full", warnings: this.safeAreaAuditor.inspect(result) };

      if (result.viewHierarchy) {
        result.elements = this.elementsBuilder.build(result.viewHierarchy, this.device.platform);
      }

      // Screenshot: fire-and-forget unless an accessibility audit is configured
      // (the audit needs the screenshot file on disk before it runs).
      if (!skipScreenshot) {
        if (serverConfig.getAccessibilityAuditConfig()) {
          await this.screenshotRecorder.capture(perf, signal);
        } else {
          this.screenshotRecorder.start(perf, signal);
        }
      }

      // Attach recomposition metrics if enabled
      await RecompositionTracker.getInstance().processObservation(result, this.device);

      // Audits + accessibility state detection (each is config-gated; failures don't propagate)
      await this.performanceAuditor.run(result, perf);
      await this.accessibilityAuditor.run(result, perf);
      await this.accessibilityStateDetector.run(result, perf, signal);

      // Predictive UI (opt-in via config)
      if (serverConfig.isPredictiveUiEnabled()) {
        try {
          const predictions = await this.predictiveUIState.generate(result);
          if (predictions) {
            result.predictions = predictions;
          }
        } catch (error) {
          logger.warn(`[PredictiveUIState] Failed to generate predictions: ${error}`);
        }
      }

      // Cache the result for future use
      await perf.track("cacheResult", () => getObserveCacheStore().put(this.device.deviceId, result));

      perf.end();

      // Freshness diagnostics
      const requestedAfter = minTimestamp > 0 ? minTimestamp : undefined;
      const actualTimestamp = this.resolveObservationTimestampMs(result);
      const isFresh = requestedAfter === undefined
        ? true
        : actualTimestamp !== undefined && actualTimestamp >= requestedAfter;
      const staleDurationMs = requestedAfter !== undefined && actualTimestamp !== undefined && actualTimestamp < requestedAfter
        ? requestedAfter - actualTimestamp
        : undefined;
      result.freshness = { requestedAfter, actualTimestamp, isFresh, staleDurationMs };

      // Attach performance timing if enabled (with filtering and truncation)
      const timings = perf.getTimings();
      const processedTimings = processTimingData(timings);
      if (processedTimings) {
        result.perfTiming = processedTimings.data;
        if (processedTimings.truncated) {
          result.perfTimingTruncated = true;
        }
      }

      logger.debug("Observe command completed");
      logger.debug(`Total observe command execution took ${this.timer.now() - startTime}ms`);
      return result;
    } catch (err) {
      const errorMessage = err instanceof Error ? (err.stack || err.message) : String(err);
      logger.error(`Critical error in observe command: ${errorMessage}`);
      ScreenshotJobTracker.cancelJob(this.device.deviceId);
      getScreenshotStateStore().update(this.device.deviceId, undefined, `Observation failed: ${errorMessage}`);
      const fallback: ObserveResult = {
        updatedAt: new Date().toISOString(),
        screenSize: { width: 0, height: 0 },
        systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      };
      appendObserveError(fallback, {
        phase: "critical",
        message: "Observation failed due to device access error",
        cause: errorMessage
      });
      return fallback;
    }
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
  extractScreenSizeFromHierarchy(viewHierarchy: ObserveResult["viewHierarchy"]): { width: number; height: number } | null {
    return this.hierarchyCollector.extractScreenSize(viewHierarchy);
  }

  createBaseResult(): ObserveResult {
    return {
      // Derive the timestamp from the injected timer so the source is pinnable
      // in tests instead of the real wall clock (issue #4172 item 9).
      updatedAt: new Date(this.timer.now()).toISOString(),
      screenSize: { width: 0, height: 0 },
      systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      insets: { available: false, source: "unavailable", units: "unknown" }
    };
  }

  /**
   * Cache an observe result. Public for back-compat with tests.
   */
  async cacheObserveResult(observeResult: ObserveResult): Promise<void> {
    await getObserveCacheStore().put(this.device.deviceId, observeResult);
  }

  // ---------- Orchestration ----------

  /**
   * Collect all observation data with platform-specific orchestration.
   *
   * Public + parameterized for back-compat with existing tests and for callers
   * that need to assemble an `ObserveResult` without the full `execute()` pipeline.
   */
  async collectAllData(
    result: ObserveResult,
    queryOptions?: import("../../models/ViewHierarchyQueryOptions").ViewHierarchyQueryOptions,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    skipWaitForFresh: boolean = false,
    minTimestamp: number = 0,
    signal?: AbortSignal,
    skipBackStack: boolean = false
  ): Promise<void> {
    switch (this.device.platform) {
      case "android":
        perf.serial("phase1_hierarchy");
        await this.hierarchyCollector.collect(result, queryOptions, perf, skipWaitForFresh, minTimestamp, signal);
        perf.end();

        // Prefer accessibility-service-supplied metadata for screen/insets/rotation/wakefulness/foreground.
        const hierarchy = result.viewHierarchy;
        if (hierarchy?.screenWidth && hierarchy?.screenHeight) {
          result.screenSize = { width: hierarchy.screenWidth, height: hierarchy.screenHeight };
          if (hierarchy.rotation !== undefined) {
            result.rotation = hierarchy.rotation;
          }
          if (hierarchy.systemInsets) {
            result.systemInsets = hierarchy.systemInsets;
          }
          if (hierarchy.insets) {
            result.insets = hierarchy.insets;
          }
          if (hierarchy.foregroundActivity) {
            const parts = hierarchy.foregroundActivity.split("/");
            const packageName = parts[0];
            const activityName = parts[1]?.startsWith(".")
              ? packageName + parts[1]
              : parts[1] || "";
            result.activeWindow = {
              appId: packageName,
              activityName,
              layoutSeqSum: 0
            };
          }
          const parallelTasks: Promise<void>[] = [];
          if (hierarchy.wakefulness) {
            result.wakefulness = hierarchy.wakefulness;
          } else {
            parallelTasks.push(perf.track("wakefulness", () => this.deviceStateCollector.collectWakefulness(result, signal)));
          }
          parallelTasks.push(perf.track("deviceLock", () => this.deviceStateCollector.collectDeviceLock(result, signal)));
          if (!skipBackStack) {
            parallelTasks.push(perf.track("backStack", () => this.deviceStateCollector.collectBackStack(result, perf, signal)));
          }
          if (parallelTasks.length > 0) {
            await Promise.all(parallelTasks);
          }
          logger.debug("[OBSERVE] Using device metadata from accessibility service");
        } else {
          logger.warn("[OBSERVE] No screen info from accessibility service - check if APK is updated");
          const tasks: Promise<void>[] = [
            perf.track("wakefulness", () => this.deviceStateCollector.collectWakefulness(result, signal)),
            perf.track("deviceLock", () => this.deviceStateCollector.collectDeviceLock(result, signal)),
          ];
          if (!skipBackStack) {
            tasks.push(perf.track("backStack", () => this.deviceStateCollector.collectBackStack(result, perf, signal)));
          }
          await Promise.all(tasks);
        }

        // Populate activeWindow from view hierarchy packageName if not already set.
        if (result.viewHierarchy?.packageName && !result.activeWindow) {
          result.activeWindow = {
            appId: result.viewHierarchy.packageName,
            activityName: "",
            layoutSeqSum: 0
          };
        }

        // CtrlProxy is installed lazily. Preserve active-window attribution for
        // that bootstrap interval only; once CtrlProxy supplied an app/activity
        // or hierarchy package, never make the legacy Window query.
        if (!result.activeWindow) {
          await this.deviceStateCollector.collectActiveWindow(result);
        }

        if (result.notificationPermissionDetected && result.activeWindow) {
          result.activeWindow.type = "notification_permission_dialog";
        }

        break;

      case "ios": {
        perf.serial("ios_collect");
        await this.hierarchyCollector.collect(result, queryOptions, perf, skipWaitForFresh, minTimestamp, signal);

        // Resolve screen size: hierarchy-derived bounds, then CtrlProxy-reported logical points.
        const extractedSize = this.hierarchyCollector.extractScreenSize(result.viewHierarchy);
        if (extractedSize) {
          result.screenSize = extractedSize;
          logger.debug(`[iOS] Extracted screen size from hierarchy: ${extractedSize.width}x${extractedSize.height}`);
        } else if (result.viewHierarchy?.screenWidth && result.viewHierarchy?.screenHeight) {
          result.screenSize = {
            width: result.viewHierarchy.screenWidth,
            height: result.viewHierarchy.screenHeight
          };
          logger.debug(`[iOS] Using screen size from CtrlProxy iOS: ${result.screenSize.width}x${result.screenSize.height}`);
        } else {
          logger.warn("[iOS] Failed to extract screen size from hierarchy");
        }
        if (result.viewHierarchy?.insets) {
          result.insets = result.viewHierarchy.insets;
        }
        if (result.viewHierarchy?.systemInsets) {
          result.systemInsets = result.viewHierarchy.systemInsets;
        }

        // Filter offscreen nodes to keep payload small. Original hierarchy stays
        // attached for raw element search when enabled.
        if (result.viewHierarchy && result.screenSize?.width > 0 && result.screenSize?.height > 0) {
          // Reconcile the duplicated viewHierarchy.screenWidth/screenHeight fields
          // with the authoritative screenSize before filtering (which preserves
          // them). The iOS runner can report a stale 320x480 (legacy compatibility
          // mode) value; keep the hierarchy fields consistent for consumers that
          // read them directly (issue #2683).
          this.hierarchyCollector.reconcileScreenDimensions(result.viewHierarchy, result.screenSize);

          const rawHierarchy = result.viewHierarchy;
          result.viewHierarchy = this.viewHierarchy.filterOffscreenNodes(
            rawHierarchy,
            result.screenSize.width,
            result.screenSize.height
          );
          if (serverConfig.isRawElementSearchEnabled()) {
            attachRawViewHierarchy(result.viewHierarchy, rawHierarchy);
          }
        }

        // Populate activeWindow from view hierarchy packageName if not already set.
        if (result.viewHierarchy?.packageName && !result.activeWindow) {
          result.activeWindow = {
            appId: result.viewHierarchy.packageName,
            activityName: "",
            layoutSeqSum: 0
          };
        }

        let sdkScreenIdentity: ScreenIdentity | undefined;
        try {
          sdkScreenIdentity = await this.viewHierarchy.getScreenIdentity?.(result.viewHierarchy?.packageName);
        } catch (error) {
          // The hierarchy remains valid when the optional SDK refresh fails.
          logger.debug(`[iOS] SDK screen identity refresh failed; using hierarchy identity: ${error}`);
        }
        const hierarchyScreenIdentity = deriveIosScreenIdentity(result.viewHierarchy);
        result.screenIdentity = hierarchyScreenIdentity?.components.modalClass
          ? hierarchyScreenIdentity
          : sdkScreenIdentity ?? hierarchyScreenIdentity;

        perf.end();
        break;
      }
    }
  }

  // ---------- Helpers ----------

  private resolveObservationTimestampMs(result: ObserveResult): number | undefined {
    const candidate = result.viewHierarchy?.updatedAt ?? result.updatedAt;
    if (typeof candidate === "number" && !Number.isNaN(candidate)) {
      return candidate;
    }
    if (typeof candidate === "string") {
      const parsed = Date.parse(candidate);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }
    return undefined;
  }
}

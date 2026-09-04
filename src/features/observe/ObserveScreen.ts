import { logger } from "../../utils/logger";
import { throwIfAborted } from "../../utils/toolUtils";
import { BootedDevice, ObserveResult, ScreenIdentity, ViewHierarchyWindowInfo } from "../../models";
import { ViewHierarchy } from "./ViewHierarchy";
import { Window } from "./Window";
import { TakeScreenshot } from "./TakeScreenshot";
import { GetBackStack } from "./GetBackStack";
import {
  AdbClientFactory,
  defaultAdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import {
  NoOpPerformanceTracker,
  PerformanceTracker,
  processTimingData,
} from "../../utils/PerformanceTracker";
import { serverConfig } from "../../utils/ServerConfig";
import { RecompositionTracker } from "../performance/RecompositionTracker";
import { getPerfWindowBuffer } from "../performance/PerfWindowBuffer";
import {
  getObservePerfWindowMs,
  isObservePerfSnapshotEnabled,
} from "../performance/observePerfSnapshotConfig";
import { PredictiveUIState } from "./PredictiveUIState";
import { ScreenshotJobTracker } from "../../utils/ScreenshotJobTracker";
import { Timer, defaultTimer } from "../../utils/SystemTimer";
import { attachRawViewHierarchy } from "../../utils/viewHierarchySearch";
import type { ObserveScreen, ObserveScreenExecuteOptions } from "./interfaces/ObserveScreen";
import type { ObserveScreenDependencies } from "./ObserveScreenDependencies";
import type { ViewHierarchy as ViewHierarchyInterface } from "./interfaces/ViewHierarchy";
import type { PredictiveUIState as PredictiveUIStateInterface } from "./interfaces/PredictiveUIState";

import { getObserveCacheStore, setObserveCacheStore } from "./cache/ObserveCacheRegistry";
import {
  getScreenshotStateStore,
  setScreenshotStateStore,
} from "./screenshot/ScreenshotStateRegistry";
import {
  DefaultObserveScreenshotRecorder,
  ObserveScreenshotRecorder,
  TrackedScreenshotService,
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
  RealHierarchyPlatformValidator,
} from "./HierarchyPlatformValidator";
import { deriveIosScreenIdentity } from "./ios/IosScreenIdentity";
import { computeFreshness } from "./observationFreshness";
import { SafeAreaAuditor, capLayoutWarnings } from "./audits/SafeAreaAuditor";

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

/**
 * Packages that legitimately present as the accessibility active window without
 * being the device's resumed activity — a system-UI panel (notification shade,
 * quick settings, volume, power dialog, keyguard) is a window, not an
 * ActivityRecord, so it never appears as the resumed activity behind it. The
 * window-identity freshness check (issue #5867) excludes these to avoid
 * misreporting an expanded shade as a stale wrong-window capture.
 */
const SYSTEM_UI_WINDOW_PACKAGES = new Set<string>(["com.android.systemui"]);

const SYSTEM_UI_PACKAGE = "com.android.systemui";

/**
 * AccessibilityWindowInfo.TYPE_SYSTEM — the window type CtrlProxy reports for
 * framework surfaces (notification shade, quick settings, keyguard, status bar).
 * Same constant `androidSystemUiAnr.ts` keys the ANR dialog off.
 */
const ACCESSIBILITY_WINDOW_TYPE_SYSTEM = 3;

type FocusedSystemUiSignal = "focused" | "topmost-suspect" | "none";

function isSystemUiSurfaceWindow(window: ViewHierarchyWindowInfo): boolean {
  return (
    window.packageName === SYSTEM_UI_PACKAGE || window.type === ACCESSIBILITY_WINDOW_TYPE_SYSTEM
  );
}

/**
 * Whether a SystemUI window is large enough to be an occluding surface (an
 * expanded shade, quick settings, or keyguard) rather than the ever-present
 * thin status bar / navigation bar. Only used to decide whether the topmost
 * window is worth an adb `mCurrentFocus` confirmation, so a normal app screen —
 * where the status bar can be the topmost SystemUI window when no focus flag is
 * populated — never triggers a per-observe adb read. A window covering more than
 * half the screen height is a shade-class surface; the status bar is a small
 * fraction of it.
 */
function isOccludingSystemUiWindow(
  window: ViewHierarchyWindowInfo,
  screenHeight: number | undefined,
): boolean {
  const bounds = window.bounds;
  if (!bounds) {
    return false;
  }
  const height = bounds.bottom - bounds.top;
  if (screenHeight && screenHeight > 0) {
    return height > screenHeight / 2;
  }
  // No screen dimension to normalize against: fall back to an absolute floor
  // that a status/navigation bar never reaches but a shade always exceeds.
  return height > 400;
}

/**
 * Classify what the captured `windows[]` list says about a focused SystemUI
 * surface (issue #6078), the free (no-adb) primary signal:
 *
 * - `focused` — a window carries `isFocused === true` and it is a SystemUI
 *   surface. This mirrors `mCurrentFocus` directly; no adb read is needed.
 *   A focused non-SystemUI (ordinary app) window returns `none`.
 * - `topmost-suspect` — no window reports focus, but the topmost window (by
 *   `windowLayer`) is a large SystemUI surface (shade/quick-settings/keyguard,
 *   not the thin status bar). Focus is unconfirmed on this API level, so the
 *   caller confirms with a `dumpsys window` `mCurrentFocus` read.
 * - `none` — no `windows[]`, a focused app window, or a topmost app / status-bar
 *   window. An ordinary app screen never lands here as a suspect, so it never
 *   pays for the adb confirmation.
 */
function classifyFocusedSystemUiWindow(
  hierarchy: ObserveResult["viewHierarchy"],
): FocusedSystemUiSignal {
  const windows = hierarchy?.windows;
  if (!windows || windows.length === 0) {
    return "none";
  }
  const focused = windows.find((window) => window.isFocused === true);
  if (focused) {
    return isSystemUiSurfaceWindow(focused) ? "focused" : "none";
  }
  const topmost = windows.reduce((current, candidate) =>
    (candidate.windowLayer ?? 0) > (current.windowLayer ?? 0) ? candidate : current,
  );
  return isSystemUiSurfaceWindow(topmost) &&
    isOccludingSystemUiWindow(topmost, hierarchy?.screenHeight)
    ? "topmost-suspect"
    : "none";
}

interface PostCaptureForegroundIdentity {
  sampled: boolean;
  identity: string | undefined;
  activityAttributionMismatch: boolean;
}

function isStatusBarOnlyCandidate(
  hierarchy: ObserveResult["viewHierarchy"],
  foreground: string | undefined,
): foreground is string {
  const observed = hierarchy?.packageName;
  return (
    foreground !== undefined &&
    !SYSTEM_UI_WINDOW_PACKAGES.has(foreground) &&
    (observed === undefined
      ? hierarchy?.ctrlProxyIncomplete === true
      : SYSTEM_UI_WINDOW_PACKAGES.has(observed))
  );
}

function isStatusBarOnlyHierarchy(result: ObserveResult): boolean {
  const statusBarHeight = result.systemInsets.top;
  const root = result.viewHierarchy?.hierarchy.node;
  if (statusBarHeight <= 0 || !root) {
    return false;
  }

  let hasBounds = false;
  const nodes = Array.isArray(root) ? [...root] : [root];
  while (nodes.length > 0) {
    const node = nodes.pop();
    if (!node) {
      continue;
    }
    if (node.bounds) {
      hasBounds = true;
      if (node.bounds.bottom > statusBarHeight) {
        return false;
      }
    }
    const children = node.node;
    if (children) {
      nodes.push(...(Array.isArray(children) ? children : [children]));
    }
  }
  return hasBounds;
}

function isAccessibilityViewClass(foregroundActivity: string): boolean {
  const activityName = foregroundActivity.split("/")[1] ?? "";
  return (
    activityName.startsWith("android.widget.") ||
    activityName.startsWith("android.view.") ||
    activityName.endsWith("DecorView")
  );
}

/**
 * Whether the captured hierarchy itself names the foreground activity (the
 * accessibility-service path). When it does not — the lazy-CtrlProxy bootstrap
 * interval, where `activeWindow` comes from the legacy `Window.getActive()`
 * read — the tree carries no activity signal that could be correlated with the
 * adb reads that follow it (#6088).
 */
function hierarchyCarriesActivitySignal(hierarchy: ObserveResult["viewHierarchy"]): boolean {
  const foregroundActivity = hierarchy?.foregroundActivity;
  return typeof foregroundActivity === "string" && !isAccessibilityViewClass(foregroundActivity);
}

function isActivityInPackage(activityName: string, packageName: string): boolean {
  return activityName === packageName || activityName.startsWith(`${packageName}.`);
}

function resolveBackStackActivityAttribution(
  result: ObserveResult,
): { packageName: string; activityName: string } | undefined {
  const packageName = result.viewHierarchy?.packageName;
  const backStack = result.backStack;
  if (!packageName || backStack?.source !== "adb") {
    return undefined;
  }
  const activityName = backStack.currentActivity?.name;
  if (!activityName) {
    return undefined;
  }
  if (isActivityInPackage(activityName, packageName)) {
    return { packageName, activityName };
  }

  const currentTaskId = backStack.currentActivity?.taskId;
  const ownedByPackage =
    backStack.tasks.some(
      (task) => task.id === currentTaskId && task.packageName === packageName,
    ) === true;
  return ownedByPackage ? { packageName, activityName } : undefined;
}

function hasUsableHierarchy(hierarchy: ObserveResult["viewHierarchy"]): boolean {
  return (
    hierarchy?.hierarchy !== undefined &&
    typeof hierarchy.hierarchy === "object" &&
    hierarchy.hierarchy !== null &&
    !("error" in hierarchy.hierarchy)
  );
}

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
    return boundCachedLayoutWarnings(getObserveCacheStore().getRecentInMemory());
  }

  static getRecentCachedResultForDevice(deviceId: string): ObserveResult | undefined {
    return boundCachedLayoutWarnings(getObserveCacheStore().getRecentInMemoryForDevice(deviceId));
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
    this.screenshotRecorder =
      dependencies?.screenshotRecorder ??
      new DefaultObserveScreenshotRecorder(
        device,
        screenshotUtil as TrackedScreenshotService,
        getScreenshotStateStore(),
      );
    this.hierarchyCollector =
      dependencies?.hierarchyCollector ??
      new HierarchyCollector({
        device,
        viewHierarchy: this.viewHierarchy,
        adb: this.adb,
        adbFactory: this.adbFactory,
        timer: this.timer,
      });
    this.deviceStateCollector =
      dependencies?.deviceStateCollector ??
      new DeviceStateCollector({
        device,
        window,
        backStack,
        adb: this.adb,
        timer: this.timer,
      });
    this.performanceAuditor =
      dependencies?.performanceAuditor ??
      new PerformanceAuditor({
        device,
        adbFactory: this.adbFactory,
      });
    this.accessibilityAuditor =
      dependencies?.accessibilityAuditor ??
      new AccessibilityAuditor({
        device,
        // Prefer the recorder-backed cached path before falling back to disk scan.
        screenshotPathResolver: () =>
          resolveLatestScreenshotPath(() =>
            getScreenshotStateStore().getPath(this.device.deviceId),
          ),
      });
    this.accessibilityStateDetector =
      dependencies?.accessibilityStateDetector ??
      new AccessibilityStateDetector({
        device,
        adb: this.adb,
      });
    this.elementsBuilder = new ObserveElementsBuilder();
    this.platformValidator =
      dependencies?.platformValidator ?? new RealHierarchyPlatformValidator();
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
        error: "No cached observe result available",
      };
    } catch (error) {
      const duration = this.timer.now() - startTime;
      logger.warn(
        `[OBSERVE_CACHE] Error getting cached observe result after ${duration}ms: ${error}`,
      );
      return {
        updatedAt: new Date().toISOString(),
        screenSize: { width: 0, height: 0 },
        systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
        error: "Failed to retrieve cached observe result",
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
      logger.debug(
        `Executing observe command (skipWaitForFresh=${skipWaitForFresh}, minTimestamp=${minTimestamp})`,
      );
      const startTime = this.timer.now();
      throwIfAborted(signal);

      const result = this.createBaseResult();

      // Capture the device's cache generation before the hierarchy is captured so
      // a concurrent invalidation (e.g. terminateApp force-stop) that lands while
      // this observation is in flight fences out our late put() below, instead of
      // repopulating the just-cleared cache with the terminated app's hierarchy
      // (issue #5884).
      const cacheGeneration = getObserveCacheStore().currentGeneration(this.device.deviceId);

      perf.serial("observe");

      // Ground-truth foreground app for the window-identity freshness check
      // (issue #5867). Started here so it overlaps hierarchy collection and adds
      // no serial latency; Android only (dumpsys resumed/focused activity),
      // best-effort.
      const foregroundIdentity: Promise<string | undefined> =
        this.device.platform === "android"
          ? this.deviceStateCollector.collectForegroundIdentity(signal)
          : Promise.resolve(undefined);

      // Phase 1+2: hierarchy + derived device state (platform-specific orchestration).
      await this.collectAllData(
        result,
        queryOptions,
        perf,
        skipWaitForFresh,
        minTimestamp,
        signal,
        skipBackStack,
      );

      // Reject a stale cross-platform hierarchy (e.g. an iOS hierarchy returned on
      // an Android device via a stale connection) at the source — before deriving
      // elements/predictions and before caching below — so that no downstream
      // consumer (tool response, observe cache, LATEST_OBSERVATION resource, or the
      // navigation-graph recorder) ever observes the other platform's data.
      const hierarchyPlatformValid = enforceHierarchyPlatform(
        result,
        this.device.platform,
        this.device.deviceId,
        this.platformValidator,
      );

      const postCaptureForeground = await this.reconcileActiveWindowAttribution(result, signal);

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

      // Freshness diagnostics.
      //
      // This used to read `isFresh = requestedAfter === undefined ? true : …`,
      // i.e. the literal `true` on every plain `observe` call — and
      // `minTimestamp` is not reachable from the public tool schema, so that was
      // the path virtually every consumer took. The field named for the exact
      // property in question measured nothing. It is now always a measurement:
      // capture age, plus whether the delegate verified the tree against the
      // device on this call. See ./observationFreshness.ts.
      //
      // Computed BEFORE caching so the persisted result carries the verdict: the
      // observe cache serializes the result at `put` time (the filesystem store),
      // so a verdict attached afterward would be lost on a daemon-restart cache
      // reload within the TTL, and a consumer reading the cached tree directly
      // (e.g. `SwipeOn.getScrollableContext`, nav/registry embeds) would accept a
      // phantom hierarchy without its `isFresh: false` signal (issue #5867).
      result.freshness = computeFreshness({
        requestedAfter: minTimestamp > 0 ? minTimestamp : undefined,
        actualTimestamp: this.resolveObservationTimestampMs(result),
        hostAgeBasisMs: this.resolveHostReceivedAtMs(result),
        now: this.timer.now(),
        verified:
          typeof result.viewHierarchy === "object" && result.viewHierarchy !== null
            ? result.viewHierarchy.fresh
            : undefined,
        unavailable:
          !hierarchyPlatformValid ||
          result.viewHierarchy?.hierarchy === undefined ||
          result.viewHierarchy?.hierarchy?.error !== undefined,
        statusBarOnlyHierarchy: await this.resolveStatusBarOnlyHierarchy(
          result,
          foregroundIdentity,
          postCaptureForeground,
          signal,
        ),
        windowIdentityMismatch: await this.resolveWindowIdentityMismatch(
          result,
          foregroundIdentity,
          postCaptureForeground,
          signal,
        ),
        activityAttributionMismatch: postCaptureForeground.activityAttributionMismatch,
      });

      // Cache the result for future use
      await perf.track("cacheResult", () =>
        getObserveCacheStore().put(this.device.deviceId, result, cacheGeneration),
      );

      perf.end();

      // Attach the windowed performance snapshot when opted in (independent of --debug-perf).
      await this.attachPerfSnapshot(result);

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
      const errorMessage = err instanceof Error ? err.stack || err.message : String(err);
      logger.error(`Critical error in observe command: ${errorMessage}`);
      ScreenshotJobTracker.cancelJob(this.device.deviceId);
      getScreenshotStateStore().update(
        this.device.deviceId,
        undefined,
        `Observation failed: ${errorMessage}`,
      );
      const fallback: ObserveResult = {
        updatedAt: new Date().toISOString(),
        screenSize: { width: 0, height: 0 },
        systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      };
      appendObserveError(fallback, {
        phase: "critical",
        message: "Observation failed due to device access error",
        cause: errorMessage,
      });
      return fallback;
    }
  }

  /**
   * Attach a windowed performance snapshot to the result when the
   * `AUTOMOBILE_OBSERVE_PERF_SNAPSHOT` opt-in is enabled. Ensures per-device
   * sampling is running (so the window fills across successive observes) and
   * rolls the live stream up over the configured window. A no-op when disabled,
   * or when there is no active app to attribute the metrics to. Never throws:
   * a snapshot failure must not fail the observation.
   */
  private async attachPerfSnapshot(result: ObserveResult): Promise<void> {
    if (!isObservePerfSnapshotEnabled()) {
      return;
    }

    const appId = result.activeWindow?.appId;
    if (!appId) {
      logger.debug("[PerfSnapshot] Skipping snapshot, no active app");
      return;
    }

    try {
      // Ensure continuous sampling is active for this device/package. The first
      // observe warms the window; subsequent observes see a fuller snapshot.
      // start() schedules the sampling interval (idempotent); startMonitoring()
      // alone only registers the device and would never accumulate samples if
      // the daemon had not already started the monitor.
      const { getPerformanceMonitor, getLastStartupTimingMs } =
        await import("../performance/PerformanceMonitor");
      const monitor = getPerformanceMonitor();
      monitor.start();
      monitor.startMonitoring(this.device.deviceId, appId, this.device.platform);

      const snapshot = getPerfWindowBuffer().snapshot(
        this.device.deviceId,
        this.timer.now(),
        getObservePerfWindowMs(),
      );
      // Startup timing is package-keyed and event-based, so it is not in the
      // sample ring; fill it from the launch cache (an in-memory read).
      snapshot.startup = getLastStartupTimingMs(appId);
      result.perfSnapshot = snapshot;
    } catch (error) {
      // Best-effort: an audit/snapshot failure should not pollute observation.
      logger.warn(`[PerfSnapshot] Failed to attach performance snapshot: ${error}`);
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
  extractScreenSizeFromHierarchy(
    viewHierarchy: ObserveResult["viewHierarchy"],
  ): { width: number; height: number } | null {
    return this.hierarchyCollector.extractScreenSize(viewHierarchy);
  }

  createBaseResult(): ObserveResult {
    return {
      // Derive the timestamp from the injected timer so the source is pinnable
      // in tests instead of the real wall clock (issue #4172 item 9).
      updatedAt: new Date(this.timer.now()).toISOString(),
      screenSize: { width: 0, height: 0 },
      systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      insets: { available: false, source: "unavailable", units: "unknown" },
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
    skipBackStack: boolean = false,
  ): Promise<void> {
    switch (this.device.platform) {
      case "android":
        perf.serial("phase1_hierarchy");
        await this.hierarchyCollector.collect(
          result,
          queryOptions,
          perf,
          skipWaitForFresh,
          minTimestamp,
          signal,
        );
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
          if (
            hierarchy.foregroundActivity &&
            !isAccessibilityViewClass(hierarchy.foregroundActivity)
          ) {
            const parts = hierarchy.foregroundActivity.split("/");
            const packageName = parts[0];
            const activityName = parts[1]?.startsWith(".")
              ? packageName + parts[1]
              : parts[1] || "";
            result.activeWindow = {
              appId: packageName,
              activityName,
              layoutSeqSum: 0,
            };
          }
          const parallelTasks: Promise<void>[] = [];
          if (hierarchy.wakefulness) {
            result.wakefulness = hierarchy.wakefulness;
          } else {
            parallelTasks.push(
              perf.track("wakefulness", () =>
                this.deviceStateCollector.collectWakefulness(result, signal),
              ),
            );
          }
          parallelTasks.push(
            perf.track("deviceLock", () =>
              this.deviceStateCollector.collectDeviceLock(result, signal),
            ),
          );
          if (!skipBackStack) {
            parallelTasks.push(
              perf.track("backStack", () =>
                this.deviceStateCollector.collectBackStack(result, perf, signal),
              ),
            );
          }
          if (parallelTasks.length > 0) {
            await Promise.all(parallelTasks);
          }
          logger.debug("[OBSERVE] Using device metadata from accessibility service");
        } else {
          logger.warn(
            "[OBSERVE] No screen info from accessibility service - check if APK is updated",
          );
          const tasks: Promise<void>[] = [
            perf.track("wakefulness", () =>
              this.deviceStateCollector.collectWakefulness(result, signal),
            ),
            perf.track("deviceLock", () =>
              this.deviceStateCollector.collectDeviceLock(result, signal),
            ),
          ];
          if (!skipBackStack) {
            tasks.push(
              perf.track("backStack", () =>
                this.deviceStateCollector.collectBackStack(result, perf, signal),
              ),
            );
          }
          await Promise.all(tasks);
        }

        // CtrlProxy is installed lazily. Preserve active-window attribution for
        // that bootstrap interval only; once CtrlProxy supplied an app/activity
        // or hierarchy package, never make the legacy Window query.
        if (!result.activeWindow) {
          await this.deviceStateCollector.collectActiveWindow(result);
        }

        // Preserve package attribution when the accessibility service did not
        // provide a usable activity and the legacy window query also failed.
        if (result.viewHierarchy?.packageName && !result.activeWindow) {
          result.activeWindow = {
            appId: result.viewHierarchy.packageName,
            activityName: "",
            layoutSeqSum: 0,
          };
        }

        if (result.notificationPermissionDetected && result.activeWindow) {
          result.activeWindow.type = "notification_permission_dialog";
        }

        break;

      case "ios": {
        perf.serial("ios_collect");
        await this.hierarchyCollector.collect(
          result,
          queryOptions,
          perf,
          skipWaitForFresh,
          minTimestamp,
          signal,
        );

        // Resolve screen size: hierarchy-derived bounds, then CtrlProxy-reported logical points.
        const extractedSize = this.hierarchyCollector.extractScreenSize(result.viewHierarchy);
        if (extractedSize) {
          result.screenSize = extractedSize;
          logger.debug(
            `[iOS] Extracted screen size from hierarchy: ${extractedSize.width}x${extractedSize.height}`,
          );
        } else if (result.viewHierarchy?.screenWidth && result.viewHierarchy?.screenHeight) {
          result.screenSize = {
            width: result.viewHierarchy.screenWidth,
            height: result.viewHierarchy.screenHeight,
          };
          logger.debug(
            `[iOS] Using screen size from CtrlProxy iOS: ${result.screenSize.width}x${result.screenSize.height}`,
          );
        } else {
          logger.warn("[iOS] Failed to extract screen size from hierarchy");
        }
        if (result.viewHierarchy?.insets) {
          result.insets = result.viewHierarchy.insets;
        }
        if (result.viewHierarchy?.systemInsets) {
          result.systemInsets = result.viewHierarchy.systemInsets;
        }
        if (result.viewHierarchy?.rotation !== undefined) {
          result.rotation = result.viewHierarchy.rotation;
        }

        // Filter offscreen nodes to keep payload small. Original hierarchy stays
        // attached for raw element search when enabled.
        if (result.viewHierarchy && result.screenSize?.width > 0 && result.screenSize?.height > 0) {
          // Reconcile the duplicated viewHierarchy.screenWidth/screenHeight fields
          // with the authoritative screenSize before filtering (which preserves
          // them). The iOS runner can report a stale 320x480 (legacy compatibility
          // mode) value; keep the hierarchy fields consistent for consumers that
          // read them directly (issue #2683).
          this.hierarchyCollector.reconcileScreenDimensions(
            result.viewHierarchy,
            result.screenSize,
          );

          const rawHierarchy = result.viewHierarchy;
          result.viewHierarchy = this.viewHierarchy.filterOffscreenNodes(
            rawHierarchy,
            result.screenSize.width,
            result.screenSize.height,
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
            layoutSeqSum: 0,
          };
        }

        let sdkScreenIdentity: ScreenIdentity | undefined;
        try {
          sdkScreenIdentity = await this.viewHierarchy.getScreenIdentity?.(
            result.viewHierarchy?.packageName,
          );
        } catch (error) {
          // The hierarchy remains valid when the optional SDK refresh fails.
          logger.debug(
            `[iOS] SDK screen identity refresh failed; using hierarchy identity: ${error}`,
          );
        }
        const hierarchyScreenIdentity = deriveIosScreenIdentity(result.viewHierarchy);
        result.screenIdentity = hierarchyScreenIdentity?.components.modalClass
          ? hierarchyScreenIdentity
          : (sdkScreenIdentity ?? hierarchyScreenIdentity);

        perf.end();
        break;
      }
    }
  }

  // ---------- Helpers ----------

  /**
   * Correct stale accessibility-service window metadata when both the captured
   * hierarchy and the device's resumed activity identify the same app.
   *
   * CtrlProxy can retain a prior `foregroundActivity` after a window transition
   * even when its hierarchy has already caught up. The hierarchy package and
   * the device's foreground activity independently confirm the replacement, so
   * they are safer than the stale activity name for `activeWindow` consumers
   * such as `waitFor` (issue #5972). System UI is intentionally excluded: a
   * system panel can validly be the accessible window while another app remains
   * the resumed activity beneath it. The post-capture sample is returned so
   * freshness diagnostics can reuse the same ground-truth check.
   */
  private async reconcileActiveWindowAttribution(
    result: ObserveResult,
    signal?: AbortSignal,
  ): Promise<PostCaptureForegroundIdentity> {
    // A focused SystemUI surface (notification shade, quick settings, keyguard,
    // status bar owning focus) occludes the app behind it while CtrlProxy's
    // `foregroundActivity` and `adb getForegroundApp` both still name that
    // occluded app — neither reads `mCurrentFocus`. Mirror the SystemUI identity
    // into `activeWindow` so `waitFor.activeWindow.appId == <app>` fails closed
    // and one object never names two apps (issue #6078). This runs before the
    // #6070 back-stack backfill and the system-UI bail below.
    if (await this.applyFocusedSystemUiOverlay(result, signal)) {
      return { sampled: false, identity: undefined, activityAttributionMismatch: false };
    }

    // Read `activeWindow` AFTER the overlay check: its fallback recapture can
    // replace the tree and re-correlate `result.activeWindow` to it (#6108). A
    // pre-await capture would be the STALE pre-recapture window, and the
    // cross-package branch below would then spread it — erasing the re-derived
    // identity and re-publishing the stale `layoutSeqSum` (#6108, bug 1).
    const activeWindow = result.activeWindow;

    const observed = result.viewHierarchy?.packageName;
    if (
      observed === undefined ||
      activeWindow === undefined ||
      SYSTEM_UI_WINDOW_PACKAGES.has(observed)
    ) {
      return { sampled: false, identity: undefined, activityAttributionMismatch: false };
    }

    const backStackAttribution = resolveBackStackActivityAttribution(result);
    if (backStackAttribution) {
      const reconciled = await this.reconcileAgainstBackStack(
        result,
        activeWindow,
        backStackAttribution,
        signal,
      );
      if (reconciled) {
        return reconciled;
      }
    }

    if (activeWindow.appId === observed) {
      return { sampled: false, identity: undefined, activityAttributionMismatch: false };
    }

    const confirmed = await this.deviceStateCollector.collectForegroundIdentity(signal);
    if (confirmed === observed) {
      result.activeWindow = { ...activeWindow, appId: observed, activityName: "" };
    }
    return { sampled: true, identity: confirmed, activityAttributionMismatch: false };
  }

  /**
   * Temporal confirmation of the adb back-stack activity against a fresh
   * hierarchy (#5992, #6070, #6088). Returns the reconciled outcome, or
   * `undefined` when the back-stack read needs no reconciliation (the hierarchy
   * itself named the activity and it already agrees with `activeWindow`).
   */
  private async reconcileAgainstBackStack(
    result: ObserveResult,
    activeWindow: NonNullable<ObserveResult["activeWindow"]>,
    backStackAttribution: { packageName: string; activityName: string },
    signal?: AbortSignal,
  ): Promise<PostCaptureForegroundIdentity | undefined> {
    // On the bootstrap path the hierarchy names no activity, so `activeWindow`
    // and `backStack` are two adb reads taken AFTER the capture. Their agreeing
    // is not evidence the tree is aligned with either: a same-app A->B
    // navigation between the capture and those reads makes both report B while
    // the tree still describes A, and the package-level guard (#5867) cannot
    // tell A from B. Always confirm through the recapture there (#6088).
    const bootstrapAttribution = !hierarchyCarriesActivitySignal(result.viewHierarchy);
    if (!bootstrapAttribution && activeWindow.activityName === backStackAttribution.activityName) {
      return undefined;
    }
    // An empty `activityName` (the bootstrap `Window.getActive()` / last-resort
    // package path) is reconciled through the SAME temporal confirmation as a
    // stale non-empty name (#5992), never a blind backfill: the recapture
    // re-reads the hierarchy so the adb activity is paired with a *fresh* tree.
    // A same-app mid-flight navigation between capture and back-stack read is
    // therefore surfaced as a mismatch/unknown rather than a confidently-wrong
    // name, and the confirmed window keeps a correlated `layoutSeqSum` (re-read
    // after the accepted recapture, #6100) so tap-effect detection is not
    // blinded by a zero sentinel (#6070).
    const recaptured = await this.recaptureHierarchyForBackStackAttribution(
      result,
      backStackAttribution,
      signal,
    );
    if (!recaptured) {
      // Unconfirmed: the bootstrap window name is a post-capture adb read that
      // may post-date the tree, so it resolves to unknown rather than staying
      // published against a hierarchy it was never correlated with (#6088).
      if (bootstrapAttribution && activeWindow.activityName !== "") {
        result.activeWindow = { ...activeWindow, activityName: "" };
      }
      return { sampled: false, identity: undefined, activityAttributionMismatch: true };
    }
    const confirmedWindow = await this.refreshRecaptureSideSamples(
      result,
      activeWindow,
      backStackAttribution,
      bootstrapAttribution,
      signal,
    );
    result.activeWindow = confirmedWindow;
    // The recapture replaced the tree AFTER the focused-SystemUI check ran. A
    // shade or keyguard that took focus mid-recapture keeps the occluded app's
    // package (so the package and back-stack checks accept it); re-run the
    // overlay reconciliation so the published window names the surface on top
    // rather than the app beneath it (#6078, surfaced in #6088 review). The tree
    // was just recaptured here, so the #6091 fallback recapture is redundant —
    // skip it and confirm focus directly against this fresh tree.
    if (await this.applyFocusedSystemUiOverlay(result, signal, true)) {
      return { sampled: false, identity: undefined, activityAttributionMismatch: false };
    }
    // Do not pair an adb activity from a later navigation with an earlier
    // hierarchy. The forced recapture and repeated back-stack read establish
    // that both sources still describe the same destination (#5992).
    const reconciled = {
      ...confirmedWindow,
      appId: backStackAttribution.packageName,
      activityName: backStackAttribution.activityName,
    };
    if (result.notificationPermissionDetected) {
      reconciled.type = "notification_permission_dialog";
    } else {
      delete reconciled.type;
    }
    result.activeWindow = reconciled;
    return { sampled: false, identity: undefined, activityAttributionMismatch: false };
  }

  /**
   * Mirror the SystemUI surface identity into `activeWindow` when a SystemUI
   * surface owns focus (issue #6078). Returns `true` when the overlay was
   * detected and applied — the caller then short-circuits the rest of
   * attribution. A no-op (returns `false`) when there is no `activeWindow` to
   * annotate or no focused SystemUI surface.
   *
   * Two detection paths (issue #6078). The free primary signal is the captured
   * accessibility `windows[]`: a window flagged `isFocused` that is a SystemUI
   * surface confirms the overlay with no extra device round-trip and — being
   * sampled atomically with the hierarchy — is race-free, so it is trusted as
   * captured. When no window on this API level carries a focus flag but the
   * topmost window is a large SystemUI surface, focus is unconfirmed on the
   * captured tree; that is the adb `mCurrentFocus` fallback.
   *
   * The fallback's focus read is not atomic with the hierarchy capture, so a
   * shade transition in that interval can pair a stale hierarchy with the wrong
   * attribution — e.g. a shade that closes leaves a stale shade tree stamped with
   * the occluded app's id (issue #6091). The fallback therefore recaptures the
   * hierarchy and re-classifies against the fresh tree so the published tree and
   * the overlay attribution are drawn from the same post-fallback moment. When a
   * caller already recaptured the tree (the #6088 back-stack path), it passes
   * `skipRecapture` so the fallback confirms focus directly against that fresh
   * tree instead of recapturing twice.
   */
  private async applyFocusedSystemUiOverlay(
    result: ObserveResult,
    signal?: AbortSignal,
    skipRecapture: boolean = false,
  ): Promise<boolean> {
    // Android-only: `com.android.systemui`, the notification shade, and the
    // `dumpsys window` fallback are Android concepts. iOS reuses the same
    // `windows[]` shape, so without this guard an iOS window carrying
    // `type === TYPE_SYSTEM` could stamp an Android package onto an iOS result.
    if (this.device.platform !== "android") {
      return false;
    }
    const activeWindow = result.activeWindow;
    if (activeWindow === undefined) {
      return false;
    }
    const signalKind = classifyFocusedSystemUiWindow(result.viewHierarchy);
    if (signalKind === "none") {
      return false;
    }
    if (signalKind === "focused") {
      // Primary, race-free signal: mirror immediately, no recapture.
      this.mirrorFocusedSystemUiOverlay(result, activeWindow);
      return true;
    }
    // `topmost-suspect`: the non-atomic adb fallback path (#6091).
    return this.applyFallbackSystemUiOverlay(result, activeWindow, skipRecapture, signal);
  }

  /**
   * Resolve the adb `mCurrentFocus` fallback for a topmost SystemUI suspect
   * (issue #6091). The focus read post-dates the captured tree, so — unless the
   * caller already recaptured — recapture the hierarchy first and re-classify
   * against the fresh tree, then confirm focus against that same tree. This keeps
   * the published hierarchy and the overlay attribution from the same moment: a
   * shade that closed in the interval reclassifies to `none` (fresh app tree,
   * no overlay), and a shade genuinely up is mirrored against the fresh shade
   * tree. When the recapture is unavailable (or skipped), fall back to the
   * single focus read against the tree in hand — no worse than pre-#6091.
   */
  private async applyFallbackSystemUiOverlay(
    result: ObserveResult,
    activeWindow: NonNullable<ObserveResult["activeWindow"]>,
    skipRecapture: boolean,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (skipRecapture) {
      // The back-stack path already recaptured and re-correlated the tree; confirm
      // focus directly against it rather than recapturing (and re-correlating) twice.
      return this.confirmFallbackOverlayFocus(result, activeWindow, signal);
    }
    return this.resolveFallbackOverlayWithRecapture(result, activeWindow, signal);
  }

  /**
   * Confirm the adb `mCurrentFocus` overlay against the tree in hand (no
   * recapture): mirror on confirmation, no-op otherwise (issue #6078).
   */
  private async confirmFallbackOverlayFocus(
    result: ObserveResult,
    activeWindow: NonNullable<ObserveResult["activeWindow"]>,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (!(await this.deviceStateCollector.collectFocusedSystemUiSurface(signal))) {
      return false;
    }
    this.mirrorFocusedSystemUiOverlay(result, activeWindow);
    return true;
  }

  /**
   * Recapture, re-correlate, then resolve the SystemUI overlay from the fresh
   * tree (issues #6091, #6108). The recapture replaces the tree AND re-correlates
   * `activeWindow` to it (#6108), so both branches below draw the published tree
   * and its attribution from the same post-recapture moment. A `topmost-suspect`
   * fresh tree still needs the adb `mCurrentFocus` read; when that read disagrees
   * with the accepted suspect tree — the shade closed while the dumpsys ran
   * (#6091 gap 2) — one bounded re-capture is taken to converge on a coherent
   * (tree, attribution) rather than pairing this suspect tree with the app
   * beneath it. When the re-capture keeps producing a fresh suspect while the
   * focus read keeps naming an app (a stale window list over a collapsed shade),
   * the adb ground truth wins and no overlay is mirrored — no over-attribution.
   */
  private async resolveFallbackOverlayWithRecapture(
    result: ObserveResult,
    activeWindow: NonNullable<ObserveResult["activeWindow"]>,
    signal?: AbortSignal,
    retriesLeft: number = 1,
  ): Promise<boolean> {
    if (!(await this.recaptureHierarchyForSystemUiOverlay(result, signal))) {
      // Recapture unavailable: single focus read against the tree in hand — no
      // worse than pre-#6091.
      return this.confirmFallbackOverlayFocus(result, activeWindow, signal);
    }
    // The recapture re-correlated `result.activeWindow` to the fresh tree (#6108).
    const recorrelated = result.activeWindow ?? activeWindow;
    const freshSignal = classifyFocusedSystemUiWindow(result.viewHierarchy);
    if (freshSignal === "none") {
      // The shade closed: the fresh tree is the underlying app and
      // `result.activeWindow` has been re-derived to name it — no overlay.
      return false;
    }
    if (freshSignal === "focused") {
      this.mirrorFocusedSystemUiOverlay(result, recorrelated);
      return true;
    }
    // `topmost-suspect` on the fresh tree: confirm focus against it.
    if (await this.deviceStateCollector.collectFocusedSystemUiSurface(signal)) {
      this.mirrorFocusedSystemUiOverlay(result, recorrelated);
      return true;
    }
    // Disagreement: the accepted tree is a fresh SystemUI suspect but the focus
    // read names an app — the shade closed during the dumpsys (#6091 gap 2). Take
    // one bounded re-capture to converge on a coherent (tree, attribution) rather
    // than publishing this suspect tree stamped with the app beneath it.
    if (retriesLeft > 0) {
      return this.resolveFallbackOverlayWithRecapture(
        result,
        recorrelated,
        signal,
        retriesLeft - 1,
      );
    }
    // Still a fresh suspect while the focus read keeps naming an app: the adb
    // ground truth is authoritative for focus, so no overlay is mirrored. The
    // published tree is the re-correlated fresh tree, not the original stale one.
    return false;
  }

  private mirrorFocusedSystemUiOverlay(
    result: ObserveResult,
    activeWindow: NonNullable<ObserveResult["activeWindow"]>,
  ): void {
    const overlay = {
      ...activeWindow,
      appId: SYSTEM_UI_PACKAGE,
      activityName: "",
      systemOverlay: true,
    };
    // The occluded-app `type` (e.g. a notification-permission dialog) does not
    // describe the shade that is now on top; drop it while the overlay is up.
    delete overlay.type;
    result.activeWindow = overlay;
  }

  /**
   * Recapture the hierarchy for the SystemUI-overlay fallback so the published
   * tree and the overlay attribution are sampled together (issue #6091). Unlike
   * the back-stack recapture there is no expected package to match — the goal is
   * simply a tree newer than the one captured before the focus read. Returns
   * `true` when a usable fresh tree replaced the original; on any failure the
   * original hierarchy is preserved and the caller falls back to the single
   * focus read.
   */
  private async recaptureHierarchyForSystemUiOverlay(
    result: ObserveResult,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const initialTimestamp = this.resolveObservationTimestampMs(result);
    const minTimestamp = (initialTimestamp ?? this.timer.now()) + 1;
    let hierarchy: ObserveResult["viewHierarchy"];
    try {
      // `minTimestamp` rejects the cached (initial) tree; skipping the fresh wait
      // goes straight to the sync that produces the newer one (#6099).
      hierarchy = await this.viewHierarchy.getViewHierarchy(
        undefined,
        new NoOpPerformanceTracker(),
        true,
        minTimestamp,
        signal,
      );
    } catch (error) {
      logger.debug(
        `[OBSERVE] SystemUI-overlay recapture failed; preserving original hierarchy: ${error}`,
      );
      return false;
    }
    if (
      !hierarchy ||
      !hasUsableHierarchy(hierarchy) ||
      hierarchy.fresh !== true ||
      !this.platformValidator.validate(this.device.platform, hierarchy).valid
    ) {
      return false;
    }
    this.applyRecapturedHierarchy(result, hierarchy);
    // `deviceLock` was sampled before the original capture (collectAllData), so a
    // keyguard that appeared during this recapture would otherwise be published
    // as unlocked against the fresh (keyguard) tree — the #6100 seam, on the
    // overlay recapture path. Clear first so a failed re-read yields "unknown"
    // rather than the stale value, then re-read paired with the replacement tree.
    delete result.deviceLock;
    await this.deviceStateCollector.collectDeviceLock(result, signal);
    // `backStack` was sampled with the original tree (collectAllData). A recapture
    // that replaced the tree — including the bounded gap-2 second recapture that
    // lands on a same-package activity B — leaves `backStack` describing the
    // pre-recapture screen A. A stale back stack that still agrees with a stale
    // window would let `reconcileAgainstBackStack` skip confirmation and record
    // A's depth/task against B's current node (#6108, bug 3). It cannot be
    // confidently re-correlated to the replacement here (no expected identity to
    // confirm against, and a fresh read would carry the same post-recapture lag),
    // so drop it to unknown rather than publish it against the new tree.
    delete result.backStack;
    // `activeWindow` (appId/activityName/layoutSeqSum) was likewise sampled with
    // the original tree. Re-correlate it against the replacement so a stale
    // non-zero `layoutSeqSum` does not skew the next tap-effect comparison and a
    // possibly-lagged activity is not stamped onto the fresh tree — the #6108
    // re-correlation, paired with the tree.
    this.recorrelateActiveWindowToRecapture(result, hierarchy);
    return true;
  }

  /**
   * Re-correlate `activeWindow` after the SystemUI-overlay recapture replaced the
   * tree (issue #6108). The pre-recapture identity (appId/activityName/
   * layoutSeqSum) was sampled with the original tree; leaving it in place pairs a
   * fresh hierarchy with stale attribution — a same-app A->B deep link during the
   * recapture would publish B's tree with A's activityName (gap 3), and a stale
   * non-zero `layoutSeqSum` would skew the next tap-effect comparison (gap 1).
   * Re-derive from the replacement tree — the one source guaranteed to describe
   * the published hierarchy. When the fresh tree names no owner the earlier
   * identity is left untouched (there is nothing better to correlate against).
   */
  private recorrelateActiveWindowToRecapture(
    result: ObserveResult,
    hierarchy: NonNullable<ObserveResult["viewHierarchy"]>,
  ): void {
    if (result.activeWindow === undefined) {
      return;
    }
    const rederived = this.deriveActiveWindowFromHierarchy(hierarchy);
    if (rederived === undefined) {
      return;
    }
    // A notification-permission dialog is a property of the tree, not the prior
    // window, so re-derive it from the replacement's own detection flag.
    if (result.notificationPermissionDetected) {
      rederived.type = "notification_permission_dialog";
    }
    result.activeWindow = rederived;
  }

  /**
   * Derive an `activeWindow` identity from a recaptured hierarchy (issue #6108).
   * Only the PACKAGE is trusted: after an overlay recapture a state transition is
   * known to have occurred, and CtrlProxy's `foregroundActivity` can lag behind
   * the tree it is attached to (the metadata lag #5972 documents — CtrlProxy can
   * retain a prior `foregroundActivity` after a window transition), so a same-app
   * A->B transition can leave `foregroundActivity`
   * naming A while the fresh tree describes B. Stamping that possibly-lagged
   * activity onto the replacement tree would publish a confidently-wrong
   * `activityName` (#6108, bug 2), so the activity is marked UNKNOWN here; when a
   * back stack is available it is confirmed through the #6088 recapture-and-match
   * machinery instead. `layoutSeqSum` is the accessibility zero — the correlated
   * window sequence for the replacement tree is not known here, and zero is the
   * established "nothing to compare" sentinel (#6070) rather than the stale
   * pre-recapture value. Prefer the tree package; fall back to the
   * `foregroundActivity` package; `undefined` when the tree names no owner.
   */
  private deriveActiveWindowFromHierarchy(
    hierarchy: NonNullable<ObserveResult["viewHierarchy"]>,
  ): NonNullable<ObserveResult["activeWindow"]> | undefined {
    const appId = hierarchy.packageName ?? hierarchy.foregroundActivity?.split("/")[0];
    if (!appId) {
      return undefined;
    }
    return { appId, activityName: "", layoutSeqSum: 0 };
  }

  private async recaptureHierarchyForBackStackAttribution(
    result: ObserveResult,
    expected: { packageName: string; activityName: string },
    signal?: AbortSignal,
  ): Promise<boolean> {
    const initialTimestamp = this.resolveObservationTimestampMs(result);
    const minTimestamp = (initialTimestamp ?? this.timer.now()) + 1;
    let hierarchy: ObserveResult["viewHierarchy"];
    try {
      // `minTimestamp` rejects the cached (initial) tree; skipping the fresh
      // wait goes straight to the sync that produces the newer one, so a static
      // screen (nothing pushed) does not burn the full WebSocket wait (#6099).
      // Android-only semantics: the iOS delegate serves its stale fallback for
      // skip + unmet minTimestamp, but this recapture is unreachable there (it
      // requires an adb-sourced back stack).
      hierarchy = await this.viewHierarchy.getViewHierarchy(
        undefined,
        new NoOpPerformanceTracker(),
        true,
        minTimestamp,
        signal,
      );
    } catch (error) {
      logger.debug(
        `[OBSERVE] Attribution recapture failed; preserving original hierarchy: ${error}`,
      );
      return false;
    }
    if (!this.isUsableAttributionRecapture(hierarchy, expected)) {
      return false;
    }

    // A failed back-stack query is represented as a partial result rather than
    // thrown. Keep it isolated from the original capture so a stale first read
    // cannot be mistaken for confirmation of this fresh hierarchy.
    const recapturedState: ObserveResult = { ...result, backStack: undefined, errors: undefined };
    await this.deviceStateCollector.collectBackStack(
      recapturedState,
      new NoOpPerformanceTracker(),
      signal,
    );
    const confirmed = resolveBackStackActivityAttribution(recapturedState);
    if (!this.matchesExpectedBackStackAttribution(confirmed, expected)) {
      // A failed confirming back-stack read retracts freshness; surface its
      // cause on the published result so the retraction is diagnosable rather
      // than an unexplained "could not reconcile" (#6088).
      for (const error of recapturedState.errors ?? []) {
        appendObserveError(result, error);
      }
      return false;
    }

    this.applyRecapturedHierarchy(result, hierarchy);
    result.backStack = recapturedState.backStack;
    return true;
  }

  /**
   * Side samples taken before an accepted recapture must not be published
   * against the replacement tree (#6100). The lock state was collected before
   * the original capture, so a keyguard that appeared mid-recapture would be
   * published as unlocked; it is re-read, and cleared first so a failed re-read
   * yields "unknown" rather than the earlier wrong value. On the bootstrap path
   * `layoutSeqSum` came from a window read taken before the recapture, so a
   * same-activity layout pass that completed during it would make the next
   * tap-effect comparison misreport a change; it is re-read too. The two reads
   * are independent adb calls and run together.
   */
  private async refreshRecaptureSideSamples(
    result: ObserveResult,
    activeWindow: NonNullable<ObserveResult["activeWindow"]>,
    expected: { packageName: string; activityName: string },
    bootstrapAttribution: boolean,
    signal?: AbortSignal,
  ): Promise<NonNullable<ObserveResult["activeWindow"]>> {
    delete result.deviceLock;
    const [confirmedWindow] = await Promise.all([
      // Elsewhere `layoutSeqSum` is the accessibility-path zero: nothing to refresh.
      bootstrapAttribution
        ? this.refreshBootstrapLayoutSeqSum(result, activeWindow, expected)
        : Promise.resolve(activeWindow),
      this.deviceStateCollector.collectDeviceLock(result, signal),
    ]);
    return confirmedWindow;
  }

  /**
   * Re-read the bootstrap window after an accepted recapture and pair the tree
   * with its layout sequence. The production `Window.getActive` does not throw
   * on failure; it returns a zero-sentinel record, so a missing OR zero sequence
   * keeps the earlier correlated value rather than the sentinel (#6070), and the
   * re-read's error is surfaced on the result so the kept value is diagnosable.
   * A sequence is adopted only when the re-read names the confirmed identity: a
   * navigation landing between the confirmation and this read would otherwise
   * graft the next screen's sequence onto the confirmed tree.
   */
  private async refreshBootstrapLayoutSeqSum(
    result: ObserveResult,
    activeWindow: NonNullable<ObserveResult["activeWindow"]>,
    expected: { packageName: string; activityName: string },
  ): Promise<NonNullable<ObserveResult["activeWindow"]>> {
    const refreshed: ObserveResult = { ...result, activeWindow: undefined, errors: undefined };
    await this.deviceStateCollector.collectActiveWindow(refreshed);
    for (const error of refreshed.errors ?? []) {
      appendObserveError(result, error);
    }
    const reread = refreshed.activeWindow;
    if (!reread?.layoutSeqSum) {
      return activeWindow;
    }
    // `dumpsys window` reports an in-package activity in shorthand (`pkg/.Foo`),
    // which the Window parser keeps, while the back stack expands it to
    // `pkg.Foo`; compare the expanded form.
    const rereadActivity = reread.activityName.startsWith(".")
      ? reread.appId + reread.activityName
      : reread.activityName;
    const sameIdentity =
      reread.appId === expected.packageName && rereadActivity === expected.activityName;
    return sameIdentity ? { ...activeWindow, layoutSeqSum: reread.layoutSeqSum } : activeWindow;
  }

  private isUsableAttributionRecapture(
    hierarchy: ObserveResult["viewHierarchy"],
    expected: { packageName: string; activityName: string },
  ): hierarchy is NonNullable<ObserveResult["viewHierarchy"]> {
    if (!hierarchy) {
      return false;
    }
    return (
      hasUsableHierarchy(hierarchy) &&
      hierarchy.fresh === true &&
      hierarchy.packageName === expected.packageName &&
      this.platformValidator.validate(this.device.platform, hierarchy).valid
    );
  }

  private matchesExpectedBackStackAttribution(
    actual: { packageName: string; activityName: string } | undefined,
    expected: { packageName: string; activityName: string },
  ): boolean {
    return (
      actual?.packageName === expected.packageName && actual.activityName === expected.activityName
    );
  }

  private applyRecapturedHierarchy(
    result: ObserveResult,
    hierarchy: NonNullable<ObserveResult["viewHierarchy"]>,
  ): void {
    result.viewHierarchy = hierarchy;
    result.updatedAt = hierarchy.updatedAt ?? result.updatedAt;
    if (hierarchy.screenWidth && hierarchy.screenHeight) {
      result.screenSize = { width: hierarchy.screenWidth, height: hierarchy.screenHeight };
    }
    result.rotation = hierarchy.rotation;
    result.systemInsets = hierarchy.systemInsets ?? { top: 0, right: 0, bottom: 0, left: 0 };
    result.insets = hierarchy.insets ?? {
      available: false,
      source: "unavailable",
      units: "unknown",
    };
    result.wakefulness = hierarchy.wakefulness ?? result.wakefulness;
    result.intentChooserDetected = hierarchy.intentChooserDetected;
    result.notificationPermissionDetected = hierarchy.notificationPermissionDetected;
    result.focusedElement = this.viewHierarchy.findFocusedElement(hierarchy) ?? undefined;
    result.accessibilityFocusedElement =
      this.viewHierarchy.findAccessibilityFocusedElement(hierarchy) ?? undefined;
  }

  /**
   * Compare the app the observed hierarchy was captured from against the
   * device's ground-truth resumed activity (issue #5867). Returns a mismatch
   * descriptor only when both are known and their package names differ — the
   * cross-app stale-window case. A same-package activity change, an unknown
   * ground truth, or an unknown observed window all yield `undefined` (no
   * comparison, no false alarm). iOS never supplies a ground truth and so is
   * always `undefined`.
   *
   * A system-UI window (`com.android.systemui`) on either side is excluded: when
   * the notification shade, quick settings, volume, or power dialog takes
   * accessibility focus, the a11y active window is systemui while the resumed
   * activity behind the panel is the underlying app — a legitimate divergence,
   * not a stale capture. Excluding it keeps first-class shade workflows (the
   * `systemTray` tool) from misfiring while still catching the app-vs-app case
   * the issue reported.
   *
   * The parallel sample is taken before hierarchy capture, so during an A→B app
   * transition it can lag the (valid, newer) captured window and read a spurious
   * mismatch. A detected mismatch is therefore confirmed against a second read
   * taken now — after capture: freshness is retracted only when the device is
   * *stably* on a different app (both samples agree, and still differ from the
   * observed window). The extra dumpsys runs only on the rare mismatch path.
   *
   * The observed package is `viewHierarchy.packageName` — the package of the
   * tree actually being validated — in preference to `activeWindow.appId`. The
   * latter is derived from the accessibility `foregroundActivity`, which with an
   * active soft keyboard can be the IME root's package while the captured
   * hierarchy is the underlying app; comparing the IME package would falsely
   * retract a valid application hierarchy. Falls back to `activeWindow.appId`
   * only when the hierarchy carries no package (e.g. the bootstrap path, whose
   * appId is itself a resumed-activity read in the same domain as the ground truth).
   */
  private async resolveWindowIdentityMismatch(
    result: ObserveResult,
    foregroundIdentity: Promise<string | undefined>,
    postCaptureForeground: PostCaptureForegroundIdentity,
    signal?: AbortSignal,
  ): Promise<{ observed: string; foreground: string } | undefined> {
    const foreground = await foregroundIdentity;
    const observed = result.viewHierarchy?.packageName ?? result.activeWindow?.appId;
    if (!foreground || !observed) {
      return undefined;
    }
    if (SYSTEM_UI_WINDOW_PACKAGES.has(observed) || SYSTEM_UI_WINDOW_PACKAGES.has(foreground)) {
      return undefined;
    }
    const confirmed = await this.resolvePostCaptureForegroundIdentity(
      foreground,
      observed,
      postCaptureForeground,
      signal,
    );
    if (!confirmed || confirmed !== foreground || confirmed === observed) {
      return undefined;
    }
    return { observed, foreground };
  }

  private async resolveStatusBarOnlyHierarchy(
    result: ObserveResult,
    foregroundIdentity: Promise<string | undefined>,
    postCaptureForeground: PostCaptureForegroundIdentity,
    signal?: AbortSignal,
  ): Promise<{ foreground: string } | undefined> {
    const foreground = await foregroundIdentity;
    const hierarchy = result.viewHierarchy;
    if (!isStatusBarOnlyCandidate(hierarchy, foreground)) {
      return undefined;
    }
    const confirmed = await this.resolvePostCaptureForegroundIdentity(
      foreground,
      hierarchy?.packageName ?? "",
      postCaptureForeground,
      signal,
    );
    if (
      !confirmed ||
      SYSTEM_UI_WINDOW_PACKAGES.has(confirmed) ||
      !isStatusBarOnlyHierarchy(result)
    ) {
      return undefined;
    }
    return { foreground: confirmed };
  }

  private async resolvePostCaptureForegroundIdentity(
    foreground: string,
    observed: string,
    postCaptureForeground: PostCaptureForegroundIdentity,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    if (postCaptureForeground.sampled) {
      return postCaptureForeground.identity;
    }
    if (foreground === observed) {
      return undefined;
    }
    return this.deviceStateCollector.collectForegroundIdentity(signal);
  }

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

  /**
   * Host-clock-domain receipt time for the observed tree, when the delegate
   * reports one (Android). Used as the age basis so clock skew between a device
   * and the host is not misreported as observation age (issue #5377). Absent on
   * iOS (shares the host clock), where age falls back to the device timestamp.
   */
  private resolveHostReceivedAtMs(result: ObserveResult): number | undefined {
    const candidate = result.viewHierarchy?.receivedAt;
    if (typeof candidate === "number" && !Number.isNaN(candidate)) {
      return candidate;
    }
    return undefined;
  }
}

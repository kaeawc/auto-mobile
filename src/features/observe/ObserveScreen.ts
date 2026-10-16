import {
  type WindowIdentityFreshnessResolver,
  isStatusBarOnlyHierarchy,
} from "./WindowIdentityFreshness";
import {
  type ActiveWindowAttributionReconciler,
  type PostCaptureForegroundIdentity,
  SYSTEM_UI_WINDOW_PACKAGES,
  hierarchyCarriesActivitySignal,
  treeNamesWindow,
  resolveBackStackActivityAttribution,
  needsBackStackActivityReconciliation,
  hasUsableHierarchy,
} from "./ActiveWindowAttribution";
export { hasUsableHierarchy } from "./ActiveWindowAttribution";
import { recordObservationRead, wasIosHierarchyAcquiredFromDevice } from "./observationReadScope";
import { displayPinFailure } from "./SessionDisplayContext";
import { publishScreenshotPaths } from "./ScreenshotRetention";
import { resolveIosObserveRotation } from "./iosObserveRotation";
import {
  screenshotPathProtection,
  type ScreenshotPathProtection,
} from "./ScreenshotPathProtection";
import { DEFAULT_HIERARCHY_READ_TIMEOUT_MS } from "./DeviceHierarchyCapture";
import {
  classifySelectedDisplayReadFailure,
  readSelectedDisplayWithRetry,
  SelectedDisplayReadError,
  type SelectedDisplayReadPolicy,
} from "./SelectedDisplayRead";
import { StaleDisplayError, staleDisplayError } from "./StaleDisplayError";
import { ObserverPendingRequestTimeoutError } from "./DeviceServiceClient";
import {
  identifyObservedHierarchy,
  type HierarchyCapture,
  type HierarchyCaptureRequest,
} from "./HierarchyCapture";
import { logger } from "../../utils/logger";
import { throwIfAborted } from "../../utils/toolUtils";
import {
  BootedDevice,
  type CtrlProxyIncompleteReason,
  ObserveResult,
  type ViewHierarchyNode,
  type ViewHierarchyResult,
} from "../../models";
import { ViewHierarchy } from "./ViewHierarchy";
import { Window } from "./Window";
import { TakeScreenshot } from "./TakeScreenshot";
import type {
  ObserveScreenshotOptions,
  ScreenshotEncodingOptions,
} from "./screenshot/screenshotOptions";
import type { ScreenshotService } from "./interfaces/ScreenshotService";
import { GetBackStack } from "./GetBackStack";
import {
  AdbClientFactory,
  defaultAdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { NoOpPerformanceTracker, PerformanceTracker } from "../../utils/PerformanceTracker";
import { serverConfig } from "../../utils/ServerConfig";
import { RecompositionTracker } from "../performance/RecompositionTracker";
import { getPerfWindowBuffer } from "../performance/PerfWindowBuffer";
import {
  getObservePerfWindowMs,
  isObservePerfSnapshotEnabled,
} from "../performance/observePerfSnapshotConfig";
import {
  attachPerfTimings,
  describeHierarchyUnavailability,
  isMultiDisplayPrimarySample,
  resolveSingleDisplayFlags,
  shouldCacheSingleDisplay,
  type SingleDisplayCaptured,
  type SingleDisplayIntent,
  type SingleDisplayReconciled,
  type SingleDisplayRun,
} from "./singleDisplayRun";
import { PredictiveUIState } from "./PredictiveUIState";
import { ScreenshotJobTracker } from "../../utils/ScreenshotJobTracker";
import { Timer, defaultTimer } from "../../utils/SystemTimer";
import { defaultIdGenerator, type IdGenerator } from "../../utils/IdGenerator";
import type {
  DeviceReadOptions,
  ObserveScreen,
  ObserveScreenExecuteOptions,
} from "./interfaces/ObserveScreen";
export type { DeviceReadOptions } from "./interfaces/ObserveScreen";
import type { ObserveScreenDependencies } from "./ObserveScreenDependencies";
import type {
  ViewHierarchy as ViewHierarchyInterface,
  HierarchyReadOptions,
} from "./interfaces/ViewHierarchy";
import type { PredictiveUIState as PredictiveUIStateInterface } from "./interfaces/PredictiveUIState";

import { getObserveCacheStore } from "./cache/ObserveCacheRegistry";
import type { RecentObserveCacheEntry } from "./cache/ObserveResultCacheStore";
import { getScreenshotStateStore } from "./screenshot/ScreenshotStateRegistry";
import type { ObserveScreenshotRecorder } from "./screenshot/ObserveScreenshotRecorder";
import { createObserveScreenWiring, installObserveStores } from "./ObserveScreenWiring";
import type { HierarchyCollector } from "./collectors/HierarchyCollector";
import {
  AndroidDisplayBindingCollector,
  IosDisplayBindingCollector,
  type DisplayBindingCollector,
  type DisplayRecordProvenance,
} from "./collectors/DisplayBindingCollector";
import {
  DefaultAndroidObservationCollector,
  scopeActiveWindowToBackStack,
  type AndroidObservationCollector,
} from "./collectors/AndroidObservationCollector";
import {
  DefaultIosObservationCollector,
  type IosObservationCollector,
} from "./collectors/IosObservationCollector";
import type { DeviceStateCollector } from "./collectors/DeviceStateCollector";
import { findAppWindowBounds, type PerformanceAuditor } from "./audits/PerformanceAuditor";
import type { AccessibilityAuditor } from "./audits/AccessibilityAuditor";
import type { AccessibilityStateDetector } from "./audits/AccessibilityStateDetector";
import { appendObserveError } from "./ObserveError";
import { resolveScreenshotMode, type ScreenshotMode } from "./automaticScreenshotPolicy";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import { errorMessage as describeError } from "../../utils/describeUnknownError";
import { ObserveElementsBuilder } from "./ObserveElementsBuilder";
import {
  enforceHierarchyPlatform,
  HierarchyPlatformValidator,
  RealHierarchyPlatformValidator,
} from "./HierarchyPlatformValidator";
import { resolveIosDeviceKind } from "../../utils/ios-cmdline-tools/IosDeviceKind";
import { NotifyutilIosLockStateProbe, type IosLockStateProbe } from "./ios/IosLockStateProbe";
import {
  computeFreshness,
  inheritWrongWindowEvidence,
  recordWrongWindowEvidence,
} from "./observationFreshness";
import { SafeAreaAuditor, capLayoutWarnings } from "./audits/SafeAreaAuditor";
import { DefaultElementParser } from "../utility/ElementParser";
import {
  ALERT_TITLE_RESOURCE_ID,
  CLOSE_APP_BUTTON_RESOURCE_ID,
  WAIT_BUTTON_RESOURCE_ID,
} from "../../utils/androidSystemUiAnr";
import {
  AndroidDisplayReadError,
  ObservedAndroidDisplayCache,
  type ObservedAndroidDisplay,
  observedIosDisplay,
} from "./ObservationDisplay";
import { displayTransitions, type DisplayCaptureStart } from "./DisplayTransition";
import { selectedDisplayPin } from "./SessionDisplayContext";
import {
  assertAllDisplayObserveSupported,
  DisplaySelectionError,
  resolveTargetDisplay,
} from "./DisplaySelection";
import type { DisplayObservation } from "../../models/ObserveResult";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { snapshotRasterGeometry } from "./screenshot/snapshotRasterGeometry";
import {
  observationScreenshotEvidence,
  type ScreenshotEvidenceFiles,
} from "./screenshot/observationScreenshotEvidence";

/** Same panel key and display generation: the only proof a cached capture shows this panel. */
function sameObservedPanel(
  cached: ObserveResult["display"] | undefined,
  observed: ObserveResult["display"],
): boolean {
  return cached?.key === observed.key && cached.generation === observed.generation;
}

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

// Framework-owned crash and ANR dialogs are windows created by system_server,
// so their accessibility hierarchy is labelled with this package rather than
// the resumed activity behind the dialog.
const FRAMEWORK_WINDOW_PACKAGE = "android";
// AppErrorDialog's action IDs identify a captured crash dialog across locales.
const APP_ERROR_RESOURCE_ID_PREFIX = "android:id/aerr_";

class StrictSettledScreenshotCaptureError extends ActionableError {
  constructor(error: unknown, deviceId: string) {
    super(toActionableError(error, `Failed to capture screenshot for device ${deviceId}`).message, {
      cause: error,
    });
  }
}

const unavailableReadOnlyHierarchy: ViewHierarchyInterface = {
  getViewHierarchy: async () => ({
    hierarchy: { error: "Hierarchy connection unavailable", unavailableReason: "connection_lost" },
  }),
  configureRecompositionTracking: async () => {},
  findFocusedElement: () => null,
  findAccessibilityFocusedElement: () => null,
  filterOffscreenNodes: (hierarchy) => hierarchy,
};

function isEmptyFocusedWindow(result: ObserveResult): boolean {
  if (!result.activeWindow?.appId || !result.elements) {
    return false;
  }
  if (SYSTEM_UI_WINDOW_PACKAGES.has(result.activeWindow.appId)) {
    return false;
  }
  const appBounds = findAppWindowBounds(result, result.activeWindow.appId);
  const focused = appBounds ?? {
    top: 0,
    bottom: Infinity,
    left: -Infinity,
    right: Infinity,
  };
  // Native snapshots aggregate all windows and do not label individual nodes with
  // their package. Restrict content to the focused window and exclude system bars,
  // so a clock/icon sibling cannot certify an empty application window (#6352).
  const insets = result.systemInsets;
  const top = Math.max(focused.top, insets.top);
  const bottom = Math.min(
    focused.bottom,
    (result.viewHierarchy?.screenHeight ?? Infinity) - insets.bottom,
  );
  const left = Math.max(focused.left, insets.left);
  const right = Math.min(
    focused.right,
    (result.viewHierarchy?.screenWidth ?? Infinity) - insets.right,
  );
  return Object.values(result.elements).every((elements) =>
    elements.every(
      ({ bounds }) =>
        bounds.bottom <= top ||
        bounds.top >= bottom ||
        bounds.right <= left ||
        bounds.left >= right,
    ),
  );
}

/**
 * Synchronous counterpart to the async, device-confirmed status-bar-only gate
 * below (issue #6220): `activeWindow.appId` is empty even after every
 * fallback (viewHierarchy packageName, bootstrap attribution, etc.) has
 * already run against this result, so nothing identifies which app — if any —
 * the captured hierarchy belongs to. The async gate needs an independent
 * dumpsys read of the foreground app to name the mismatch; when that
 * confirming read itself comes back empty (or races), this still catches the
 * case without a device round-trip. A missing `viewHierarchy` is left to the
 * `unavailable` freshness path instead — this is only about a hierarchy that
 * WAS captured but carries no window identity.
 */
/**
 * Whether the observation carries ANY signal identifying a real foreground
 * application: a usable `activeWindow.appId`, `viewHierarchy.packageName`, or
 * a valid `foregroundActivity` (the raw accessibility signal, checked
 * directly rather than only through `activeWindow`). The third signal matters
 * on its own: deriving `activeWindow` from `foregroundActivity` in
 * `collectAllData` is gated on screen dimensions being present, so a
 * hierarchy that lacks `packageName`/dimensions but DOES carry a valid
 * `foregroundActivity` never gets an `activeWindow` at all — it must still
 * not be treated as identity-less (issue #6220 follow-up false-positive).
 * Single source of truth for "does this capture name an app", so a future
 * signal is added once here rather than risking one call site missing it.
 */
function hasForegroundAppIdentity(result: ObserveResult): boolean {
  return Boolean(
    result.activeWindow?.appId ||
    result.viewHierarchy?.packageName ||
    hierarchyCarriesActivitySignal(result.viewHierarchy),
  );
}

/**
 * Exported so other consumers can reuse the SAME machine-readable verdict
 * this freshness gate uses, instead of re-deriving "does this capture have a
 * foreground window" from a weaker proxy (e.g. package-name presence, which a
 * status-bar-only capture can still carry as stale metadata). `LaunchApp`
 * uses this to distinguish a status-bar-only/no-window post-launch capture
 * from a genuine wrong-app landing (issue #6239 review follow-up).
 */
export function resolveMissingForegroundWindow(
  result: ObserveResult,
): { reason: "status_bar_only" | "empty_active_window" } | undefined {
  if (!result.viewHierarchy?.hierarchy?.node) {
    return undefined;
  }
  // Status-bar-ONLY geometry is checked FIRST and dominates any lingering
  // identity metadata. `packageName`/`foregroundActivity` can survive on the
  // wire from a PRIOR resumed app even once the tree itself has collapsed to
  // chrome-only content (both ADB foreground reads coming back empty means
  // there is no ground truth to confirm or refute that staleness against) —
  // the geometry is the one signal that cannot lie about what actually came
  // back. `isStatusBarOnlyHierarchy` already distinguishes this incomplete,
  // chrome-only strip from a legitimate FULL-height SystemUI shade capture
  // (it returns `false` the moment any node extends below the status-bar
  // height), so a genuine expanded shade is never caught here — only the
  // provably-incomplete case is (issue #6239 review follow-up).
  if (isStatusBarOnlyHierarchy(result)) {
    return { reason: "status_bar_only" };
  }
  // `hasForegroundAppIdentity` is checked directly (not only via
  // `activeWindow.appId`, which the package-attribution fallback above should
  // already have backfilled from `viewHierarchy.packageName`): later stages
  // (e.g. `reconcileActiveWindowAttribution`, the SystemUI-overlay mirroring)
  // can still re-derive `activeWindow` after this point, and a
  // package/activity-attributed capture must never be reported as having no
  // foreground window regardless of what runs afterward (issue #6220
  // false-positive) — UNLESS the geometry above already proved it incomplete.
  if (hasForegroundAppIdentity(result)) {
    return undefined;
  }
  return { reason: "empty_active_window" };
}

/**
 * The service's own incomplete-capture signal (issue #6151), scoped to whether it
 * actually pertains to the SELECTED/focused window.
 *
 * `ctrlProxyIncomplete` on the wire is a single, generic flag: CtrlProxy sets it
 * whenever ANY active window was rootless, including an unrelated active
 * SystemUI/overlay window that has nothing to do with the focused application
 * (#6151 follow-up). Converting that flag unconditionally into a retracted
 * verdict over-corrects: a perfectly good, verified focused-app hierarchy would
 * be reported `verified: false` / `isFresh: false` on every observe that happens
 * to catch a transient rootless overlay elsewhere on screen.
 *
 * Correlate it the same way `resolveStatusBarOnlyHierarchy` correlates a
 * wrong-window capture: the observed package is the selected window's own
 * identity, so when it matches the device's current foreground app, that
 * window's content is trustworthy and the flag does not describe it — do not
 * retract. It only describes the selected window when the observed package is
 * absent or does not match the foreground app (a substituted window from the
 * incomplete-capture fallback, or no content at all) — the genuine #6151 case,
 * where the focused app's OWN root was null.
 *
 * `foreground` MUST be the SETTLED/confirmed identity (the same post-capture
 * sample `resolveWindowIdentityMismatch` and `resolveStatusBarOnlyHierarchy`
 * trust), never the initial parallel sample taken before capture. During an
 * A→B app transition the initial sample can still read A while the hierarchy
 * (and the confirming read) are already on B; comparing against the stale
 * initial sample would see `observed (B) !== initial foreground (A)` and
 * retract freshness even though B was just confirmed as the settled foreground
 * — discarding the very confirmation the rest of this freshness logic relies on
 * (#6151 follow-up).
 */
function describeIncompleteCapture(
  hierarchy: ObserveResult["viewHierarchy"],
  foreground: string | undefined,
  confirmedFrameworkErrorDialog: boolean,
):
  | {
      sdkInt: number | undefined;
      reason: CtrlProxyIncompleteReason | undefined;
      accessibilityTool: boolean | undefined;
    }
  | undefined {
  if (hierarchy?.ctrlProxyIncomplete !== true) {
    return undefined;
  }
  if (confirmedFrameworkErrorDialog && hierarchy.packageName === FRAMEWORK_WINDOW_PACKAGE) {
    return undefined;
  }
  const observed = hierarchy.packageName;
  if (foreground !== undefined && observed !== undefined && observed === foreground) {
    return undefined;
  }
  // `ctrlProxyIncompleteReason` names the actual cause so the freshness warning can
  // give cause-appropriate advice (issue #6184); pre-#6172 runners omit it, and the
  // freshness layer treats an absent reason as the historical `null_root` default.
  return {
    sdkInt: hierarchy.sdkInt,
    reason: hierarchy.ctrlProxyIncompleteReason,
    accessibilityTool: hierarchy.accessibilityTool,
  };
}

interface SingleDisplayStageContext {
  result: ObserveResult;
}

interface SingleDisplayCaptureContext extends SingleDisplayStageContext {
  options: ObserveScreenExecuteOptions | undefined;
  queryOptions: ObserveScreenExecuteOptions["queryOptions"];
  perf: PerformanceTracker;
  skipWaitForFresh: boolean;
  minTimestamp: number;
  signal: AbortSignal | undefined;
  skipBackStack: boolean;
  observerMode: boolean;
  preserveDisplayState: boolean;
  capturedHierarchy: ViewHierarchyResult | undefined;
  requestedDisplayId: number | undefined;
  observedAndroid: ObservedAndroidDisplay | undefined;
}

interface SingleDisplayReconciliationContext extends SingleDisplayStageContext {
  observerMode: boolean;
  preserveDisplayState: boolean;
  explicitlyRouted: boolean;
  recordProvenance: { revision: number; identityRevision: number };
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
  private hierarchyCollector: HierarchyCollector;
  private deviceStateCollector: DeviceStateCollector;
  private readonly iosLockStateProbe: IosLockStateProbe;
  private performanceAuditor: PerformanceAuditor;
  private accessibilityAuditor: AccessibilityAuditor;
  private accessibilityStateDetector: AccessibilityStateDetector;
  private elementsBuilder: ObserveElementsBuilder;
  private readonly reconciler: ActiveWindowAttributionReconciler;
  private readonly androidCollector: AndroidObservationCollector;
  private readonly displayBinding: DisplayBindingCollector;
  private readonly iosCollector: IosObservationCollector;
  private readonly windowIdentity: WindowIdentityFreshnessResolver;
  private platformValidator: HierarchyPlatformValidator;
  private safeAreaAuditor: SafeAreaAuditor;

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

    // Data sources (either injected or default)
    this.viewHierarchy =
      dependencies?.viewHierarchy ??
      (dependencies?.deviceReadOnly
        ? unavailableReadOnlyHierarchy
        : new ViewHierarchy(device, this.adbFactory));
    this.hierarchyCapture =
      dependencies?.hierarchyCapture ?? wiring.createHierarchyCapture(timer, idGenerator);
    const window = dependencies?.window ?? new Window(device, this.adbFactory);
    const screenshotUtil =
      dependencies?.screenshot ??
      (dependencies?.deviceReadOnly
        ? TakeScreenshot.forObservationRead(device)
        : new TakeScreenshot(device, this.adbFactory));
    this.screenshotService = screenshotUtil;
    const backStack = dependencies?.backStack ?? new GetBackStack(device, this.adbFactory);
    this.predictiveUIState = dependencies?.predictiveUIState ?? new PredictiveUIState();

    installObserveStores(dependencies);

    // Composed services
    this.pathProtection = dependencies?.screenshotPathProtection ?? screenshotPathProtection;
    this.screenshotRecorder =
      dependencies?.screenshotRecorder ??
      wiring.createScreenshotRecorder(screenshotUtil, this.pathProtection);
    this.screenshotEvidenceFiles = dependencies?.screenshotEvidenceFiles;
    this.hierarchyCollector =
      dependencies?.hierarchyCollector ?? wiring.createHierarchyCollector(dependencies);
    this.deviceStateCollector =
      dependencies?.deviceStateCollector ?? wiring.createDeviceStateCollector(window, backStack);
    this.iosLockStateProbe = dependencies?.iosLockStateProbe ?? new NotifyutilIosLockStateProbe();
    this.performanceAuditor = dependencies?.performanceAuditor ?? wiring.createPerformanceAuditor();
    this.accessibilityAuditor =
      dependencies?.accessibilityAuditor ?? wiring.createAccessibilityAuditor();
    this.accessibilityStateDetector =
      dependencies?.accessibilityStateDetector ?? wiring.createAccessibilityStateDetector();
    this.elementsBuilder = new ObserveElementsBuilder();
    this.platformValidator =
      dependencies?.platformValidator ?? new RealHierarchyPlatformValidator();
    this.safeAreaAuditor = new SafeAreaAuditor();
    this.windowIdentity =
      dependencies?.windowIdentityFreshnessResolver ?? wiring.createWindowIdentity();
    this.reconciler = dependencies?.activeWindowAttributionReconciler ?? wiring.createReconciler();
    // Lazy getters: tests may reassign these collaborators on the instance after construction.
    this.androidCollector = new DefaultAndroidObservationCollector({
      hierarchyCollector: () => this.hierarchyCollector,
      deviceStateCollector: () => this.deviceStateCollector,
      viewHierarchy: () => this.viewHierarchy,
      device: () => this.device,
    });
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
      return this.executeAllDisplays({
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

  private async captureSelectedDisplayHierarchy(options: {
    request: HierarchyCaptureRequest;
    panelKey: string | undefined;
    captureStart: DisplayCaptureStart;
  }): Promise<ViewHierarchyResult> {
    const { request, panelKey, captureStart } = options;
    const captured = await readSelectedDisplayWithRetry({
      ...this.selectedDisplayRead,
      timer: this.timer,
      budgetMs: request.timeoutMs ?? DEFAULT_HIERARCHY_READ_TIMEOUT_MS,
      timeoutMs: request.timeoutMs,
      signal: request.signal,
      read: (attempt) =>
        this.hierarchyCapture.capture(
          attempt.number === 1 ? request : { ...request, timeoutMs: attempt.timeoutMs },
        ),
      classify: (error) => classifySelectedDisplayReadFailure(error, { signal: request.signal }),
      assertFenceCurrent: () => {
        const deviceId = this.device.deviceId;
        if (displayTransitions.revision(deviceId) !== captureStart.revision) {
          throw staleDisplayError(
            captureStart.identityRevision,
            displayTransitions.identityRevision(deviceId),
            displayTransitions.currentObservedPanel(deviceId)?.key,
          );
        }
      },
      wrap: (error, info) => {
        const message = `Unable to read selected display "${panelKey}": ${String(error)}`;
        return info.exhausted
          ? new SelectedDisplayReadError(message, {
              cause: error,
              kind: info.kind,
              attempts: info.attempts,
            })
          : new DisplaySelectionError(message, { cause: error });
      },
    });
    return captured.hierarchy;
  }

  private shouldPropagateCaptureError(
    error: unknown,
    context: {
      display: string | undefined;
      signal: AbortSignal | undefined;
    },
  ): boolean {
    if (
      error instanceof StrictSettledScreenshotCaptureError ||
      error instanceof DisplaySelectionError
    ) {
      return true;
    }
    const explicitAndroidDisplay =
      this.device.platform === "android" &&
      context.display !== undefined &&
      context.display !== "active";
    if (!explicitAndroidDisplay) {
      return false;
    }
    return (
      error instanceof AndroidDisplayReadError ||
      error instanceof StaleDisplayError ||
      (context.signal?.aborted === true && error === context.signal.reason)
    );
  }

  private async captureObserverHierarchy(
    request: HierarchyCaptureRequest,
  ): Promise<ViewHierarchyResult> {
    try {
      return (await this.hierarchyCapture.capture(request)).hierarchy;
    } catch (error) {
      if (request.signal?.aborted) {
        throw error;
      }
      const detail = describeError(error);
      logger.warn(`[ObserveScreen] Observer hierarchy unavailable: ${detail}`, error);
      return {
        hierarchy: {
          error: "Hierarchy service unavailable",
          unavailableReason:
            error instanceof ObserverPendingRequestTimeoutError
              ? "request_timed_out"
              : "connection_lost",
          unavailableDetail: detail,
        },
        fresh: false,
      };
    }
  }

  private async captureDeviceReadScreenshot(
    result: ObserveResult,
    signal?: AbortSignal,
    screenshotOptions?: ScreenshotEncodingOptions,
    options: { requireFreshScreenshot?: boolean; display?: string } = {},
  ): Promise<void> {
    const { requireFreshScreenshot = false, display = this.requestedDisplay } = options;
    result.screenshotCaptureAttempted = true;
    result.screenshotOrientation = this.device.platform === "ios" ? "native" : "display";
    const displayId = await this.resolveReadDisplayId(result, { signal, display });
    const captureOptions = {
      format: screenshotOptions?.format ?? "png",
      ...screenshotOptions,
      displayId,
    };
    const capture =
      this.screenshotService instanceof TakeScreenshot
        ? await this.screenshotService.executeObservationRead(captureOptions, signal)
        : await this.screenshotService.execute(captureOptions, signal);
    signal?.throwIfAborted();
    if (capture.success && capture.path) {
      Object.assign(
        result,
        await observationScreenshotEvidence(capture.path, "fresh", undefined, {
          files: this.screenshotEvidenceFiles,
          timer: this.timer,
          protection: this.pathProtection,
        }),
      );
      await this.attachScreenshotRaster(result, capture.screenshotImageSize);
      result.screenshotSettled = true;
      return;
    }
    await this.handleDeviceReadScreenshotFailure(
      result,
      capture.error ?? "Screenshot capture failed",
      displayId,
      requireFreshScreenshot,
    );
  }

  private async handleDeviceReadScreenshotFailure(
    result: ObserveResult,
    failure: string,
    displayId: number | undefined,
    requireFreshScreenshot: boolean,
  ): Promise<void> {
    if (requireFreshScreenshot) {
      throw new ActionableError(
        `observe crop screenshot capture failed for device ${this.device.deviceId}: ${failure}. Retry with a fresh settled capture.`,
      );
    }
    const cachedScreenshot = this.eligibleCachedScreenshot(displayId, result.display);
    if (cachedScreenshot) {
      try {
        Object.assign(
          result,
          await observationScreenshotEvidence(cachedScreenshot.path, "cached", failure, {
            files: this.screenshotEvidenceFiles,
            timer: this.timer,
            protection: this.pathProtection,
          }),
        );
        await this.attachScreenshotRaster(result, cachedScreenshot.imageSize);
      } catch (error) {
        logger.warn(`[OBSERVE] Cached screenshot unavailable: ${describeError(error)}`, error);
      }
    }
    result.screenshotSettled = false;
    result.screenshotSettledError = failure;
  }

  private async resolveReadDisplayId(
    result: ObserveResult,
    options: { signal?: AbortSignal; display?: string } = {},
  ): Promise<number | undefined> {
    const { signal, display = this.requestedDisplay } = options;
    if (this.device.platform !== "android" || !display || display === "active") {
      return undefined;
    }
    const panel = resolveTargetDisplay(this.device.displays, display, {});
    const displayId = await this.observedAndroidDisplayCache.logicalIdForPanel(
      this.device,
      this.adb,
      panel.key,
      signal,
    );
    result.display = { ...result.display, key: panel.key, role: panel.role };
    return displayId;
  }

  private eligibleCachedScreenshot(
    displayId: number | undefined,
    observed: ObserveResult["display"],
  ): { path: string; imageSize?: { width: number; height: number } } | undefined {
    const cached = getObserveCacheStore().getRecentInMemoryForDevice(this.device.deviceId);
    if (!this.cachedScreenshotDisplayMatches(cached, displayId, observed)) {
      return undefined;
    }
    if (cached?.screenshotPath) {
      return { path: cached.screenshotPath, imageSize: cached.screenshotImageSize };
    }
    const path = this.deviceWideScreenshotPath(displayId);
    return path ? { path } : undefined;
  }

  /** The device-wide screenshot state has no panel provenance, so it never serves a multi-panel device. */
  private deviceWideScreenshotPath(displayId: number | undefined): string | undefined {
    const explicitDisplay = Boolean(this.requestedDisplay && this.requestedDisplay !== "active");
    return !explicitDisplay && displayId === undefined && !this.hasMultiplePanels()
      ? getScreenshotStateStore().getPath(this.device.deviceId)
      : undefined;
  }

  private hasMultiplePanels(): boolean {
    return (this.device.displays?.panels.length ?? 0) > 1;
  }

  private cachedScreenshotDisplayMatches(
    cached: ObserveResult | undefined,
    displayId: number | undefined,
    observed: ObserveResult["display"],
  ): boolean {
    const displayMatches = [
      undefined,
      "active",
      cached?.display.key,
      cached?.display.role,
    ].includes(this.requestedDisplay);
    const displayIdMatches = [undefined, cached?.viewHierarchy?.displayId].includes(displayId);
    // A default or "active" read resolves its panel from live state, so the request alone cannot
    // prove which panel a cached screenshot came from. On multi-panel devices the cached entry
    // must carry this observation's panel key and display generation.
    const panelMatches = !this.hasMultiplePanels() || sameObservedPanel(cached?.display, observed);
    return displayMatches && displayIdMatches && panelMatches;
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
    const displayId = await this.resolveReadDisplayId(result, { signal });
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
      return this.executeAllDisplays(options);
    }
    return this.executeSingleDisplay(options);
  }

  private async executeAllDisplays(
    options?: ObserveScreenExecuteOptions & { deviceReadScreenshot?: ScreenshotEncodingOptions },
  ): Promise<ObserveResult> {
    const deviceReadScreenshot = options?.deviceReadScreenshot;
    assertAllDisplayObserveSupported(this.device.platform);
    // Reuse the existing hierarchy-capture budget; one deadline covers every panel.
    const deadline = this.timer.now() + (options?.timeoutMs ?? 15000);
    const active = await this.readAggregatePanel("active", {
      options,
      deadline,
      deviceReadScreenshot,
    });
    const panels = this.device.displays?.panels;
    if (!panels?.length) {
      // Discovery omits single-screen inventory: retain exactly the ordinary result.
      return active;
    }
    const activePanelKey = panels.some((panel) => panel.key === active.display.key)
      ? active.display.key
      : resolveTargetDisplay(this.device.displays, "active", {
          focusedPanelKey: displayTransitions.observedPanel(this.device.deviceId)?.key,
        }).key;
    const displays: DisplayObservation[] = [];
    for (const panel of panels) {
      const observation =
        panel.key === activePanelKey
          ? active
          : await this.readAggregatePanel(panel.key, {
              options: {
                ...options,
                // Extra screenshots would overwrite shared screenshot state. Only the
                // normal active capture supplies a path; extras are hierarchy reads.
                skipScreenshot: true,
                skipPerformanceAudit: true,
                skipAccessibilityAudit: true,
                skipRecompositionTracking: true,
              },
              deadline,
            });
      const {
        display,
        screenSize,
        viewHierarchy,
        elements,
        screenshotPath,
        screenshotExpiresAt,
        systemInsets,
        insets,
        activeWindow,
      } = observation;
      displays.push({
        display: { ...display, key: panel.key, role: panel.role },
        screenSize,
        viewHierarchy,
        elements,
        screenshotPath,
        screenshotExpiresAt,
        systemInsets,
        insets,
        activeWindow,
        freshness:
          observation.freshness ?? computeFreshness({ now: this.timer.now(), unavailable: true }),
      });
    }
    const result = { ...active, displays };
    await publishScreenshotPaths(result, this.pathProtection);
    return result;
  }

  private async readAggregatePanel(
    display: string,
    request: {
      options?: ObserveScreenExecuteOptions;
      deadline: number;
      deviceReadScreenshot?: ScreenshotEncodingOptions;
    },
  ): Promise<ObserveResult> {
    const { options, deadline, deviceReadScreenshot } = request;
    const remaining = Math.max(0, deadline - this.timer.now());
    const controller = new AbortController();
    const callerSignal = options?.signal;
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, controller.signal])
      : controller.signal;
    let timedOut = remaining === 0;
    try {
      callerSignal?.throwIfAborted();
      if (timedOut) {
        throw new DisplaySelectionError("Observe deadline reached; retry this panel separately.");
      }
      return await raceWithDeadline(
        async () => {
          const result = await this.executeSingleDisplay({
            ...options,
            display,
            signal,
            timeoutMs: remaining,
            skipCache: true,
            preserveDisplayState: true,
          });
          if (deviceReadScreenshot !== undefined) {
            await this.captureDeviceReadScreenshot(result, signal, deviceReadScreenshot, {
              display,
            });
          }
          return result;
        },
        {
          timer: this.timer,
          timeoutMs: remaining,
          signal: callerSignal,
          label: `Observe display ${display}`,
          onTimeout: () => {
            timedOut = true;
            controller.abort();
          },
        },
      );
    } catch (error) {
      callerSignal?.throwIfAborted();
      logger.warn(`[ObserveScreen] Display ${display} unavailable: ${describeError(error)}`, error);
      if (display === "active" && !timedOut) {
        return this.createCriticalFallback(error);
      }
      const result = this.createBaseResult();
      const panel = resolveTargetDisplay(this.device.displays, display, {
        focusedPanelKey: displayTransitions.observedPanel(this.device.deviceId)?.key,
      });
      result.display = {
        ...result.display,
        key: panel.key,
        role: panel.role,
        generation: displayTransitions.identityRevision(this.device.deviceId),
      };
      result.screenSize = { ...panel.sizePx, units: "physical-pixels" };
      result.freshness = computeFreshness({
        now: this.timer.now(),
        unavailable: true,
        unavailableReason: timedOut ? "request_timed_out" : "unknown",
        unavailableDetail: describeError(error),
      });
      return result;
    }
  }

  private captureSingleDisplayData(context: SingleDisplayCaptureContext): Promise<void> {
    const {
      result,
      options,
      queryOptions,
      perf,
      skipWaitForFresh,
      minTimestamp,
      signal,
      skipBackStack,
      observerMode,
      preserveDisplayState,
      capturedHierarchy,
      requestedDisplayId,
      observedAndroid,
    } = context;

    // Phase 1+2: hierarchy + derived device state (platform-specific orchestration).
    return this.collectAllData(
      result,
      queryOptions,
      perf,
      skipWaitForFresh,
      minTimestamp,
      signal,
      skipBackStack,
      observerMode || preserveDisplayState || options?.skipRecompositionTracking === true,
      capturedHierarchy,
      this.device.platform === "android" && options?.requireFreshExtraction
        ? { timeoutMs: options.timeoutMs, requireFreshExtraction: options.requireFreshExtraction }
        : options?.timeoutMs,
      requestedDisplayId ?? observedAndroid?.logicalId ?? 0,
    );
  }

  private enrichSingleDisplayElements(context: SingleDisplayStageContext): void {
    const { result } = context;

    // Hierarchy collection and accepted recaptures each replace `screenSize`.
    // Stamp its output-only unit marker after all of them, before the result is
    // cached, so every served and cached observation uses one platform source
    // of truth without changing the platform-native numeric coordinates.
    this.stampScreenSizeUnits(result);

    // Uncapped here; the output boundary (sanitizeObserveResult / the observe
    // served path in finalizeToolResponse) caps AFTER any scope narrowing so an
    // in-scope warning is never lost to a cap taken against the full tree (#5074).
    result.layoutWarnings = { scope: "full", warnings: this.safeAreaAuditor.inspect(result) };

    if (result.viewHierarchy) {
      result.elements = this.elementsBuilder.build(result.viewHierarchy, this.device.platform);
    }
  }

  private recordSingleDisplayTransition(context: SingleDisplayReconciliationContext) {
    const { result, observerMode, preserveDisplayState, explicitlyRouted, recordProvenance } =
      context;
    return (
      !observerMode &&
      !preserveDisplayState &&
      !explicitlyRouted &&
      displayTransitions.record(
        this.device.deviceId,
        result,
        this.device.platform === "ios" && (this.device.displays?.panels.length ?? 0) > 1
          ? "ios"
          : "android",
        recordProvenance,
      )
    );
  }

  private reconcileSingleDisplayFreshness(context: SingleDisplayReconciliationContext) {
    const { result, recordProvenance } = context;

    const staleDisplay =
      displayTransitions.revision(this.device.deviceId) !== recordProvenance.revision;
    const geometryTransition = this.recordSingleDisplayTransition(context);
    // Stale coordinates retain this observation's reconciled provenance, never a later push's fence.
    result.display.generation = staleDisplay
      ? recordProvenance.identityRevision
      : displayTransitions.identityRevision(this.device.deviceId);
    result.displayRevision = staleDisplay
      ? recordProvenance.revision
      : displayTransitions.revision(this.device.deviceId);
    return { staleDisplay, geometryTransition };
  }

  private async executeSingleDisplay(
    options?: ObserveScreenExecuteOptions & { preserveDisplayState?: boolean },
  ): Promise<ObserveResult> {
    const intent = this.resolveSingleDisplayIntent(options);
    try {
      const run = await this.beginSingleDisplay(intent);
      const captured = await this.captureSingleDisplay(run);
      if (captured.earlyResult) {
        return captured.earlyResult;
      }
      const reconciled = await this.reconcileSingleDisplay(run, captured);
      await this.enrichSingleDisplay(run);
      await this.settleSingleDisplay(run, captured, reconciled);
      return await this.publishSingleDisplay(run);
    } catch (err) {
      return await this.failSingleDisplay(err, intent);
    }
  }

  /** Normalize the caller's options once; every stage reads these, none re-derives them. */
  private resolveSingleDisplayIntent(
    options: (ObserveScreenExecuteOptions & { preserveDisplayState?: boolean }) | undefined,
  ): SingleDisplayIntent {
    const flags = resolveSingleDisplayFlags(options);
    return {
      ...flags,
      options,
      androidDisplayCache: this.selectAndroidDisplayCache(
        flags.observerMode || flags.preserveDisplayState,
      ),
      displayRequest: options?.display ?? this.defaultDisplayRequest(),
      perf: options?.perf ?? new NoOpPerformanceTracker(),
      iosLockState: this.startIosLockStateProbe(flags.signal),
    };
  }

  /** Read-only probes must not refresh an owner's display/posture caches. */
  private selectAndroidDisplayCache(readOnly: boolean): SingleDisplayIntent["androidDisplayCache"] {
    return readOnly
      ? new ObservedAndroidDisplayCache(this.timer, true)
      : this.observedAndroidDisplayCache;
  }

  private defaultDisplayRequest(): string | undefined {
    return this.requestedDisplay === "all" ? undefined : this.requestedDisplay;
  }

  private startIosLockStateProbe(
    signal: AbortSignal | undefined,
  ): SingleDisplayIntent["iosLockState"] {
    return this.device.platform === "ios" &&
      resolveIosDeviceKind({ deviceId: this.device.deviceId }) === "simulator"
      ? this.iosLockStateProbe.read(this.device.deviceId, signal)
      : undefined;
  }

  /** Stage 0: resolve the targeted display and pin the capture-start fences. */
  private async beginSingleDisplay(intent: SingleDisplayIntent): Promise<SingleDisplayRun> {
    const { perf, skipWaitForFresh, minTimestamp, signal, preserveDisplayState } = intent;
    logger.debug(
      `Executing observe command (skipWaitForFresh=${skipWaitForFresh}, minTimestamp=${minTimestamp})`,
    );
    const startTime = this.timer.now();
    throwIfAborted(signal);

    const result = this.createBaseResult();
    const captureStart = {
      revision: displayTransitions.revision(this.device.deviceId),
      identityRevision: displayTransitions.identityRevision(this.device.deviceId),
    };
    const targetBinding = this.displayBinding.resolveTarget({
      result,
      displayRequest: intent.displayRequest,
      androidDisplayCache: intent.androidDisplayCache,
      signal,
    });
    // Only the Android resolution is asynchronous; await it only then so iOS adds no tick.
    const binding = targetBinding instanceof Promise ? await targetBinding : targetBinding;
    const { explicitlyRouted, requestedDisplayId } = binding;

    const routedAggregateSecondary =
      preserveDisplayState &&
      explicitlyRouted &&
      requestedDisplayId !== undefined &&
      requestedDisplayId !== 0;

    // Capture the device's cache generation before the hierarchy is captured so
    // a concurrent invalidation (e.g. terminateApp force-stop) that lands while
    // this observation is in flight fences out our late put() below, instead of
    // repopulating the just-cleared cache with the terminated app's hierarchy
    // (issue #5884).
    const cacheGeneration = getObserveCacheStore().currentGeneration(this.device.deviceId);

    perf.serial("observe");

    return {
      ...intent,
      ...binding,
      result,
      startTime,
      captureStart,
      routedAggregateSecondary,
      cacheGeneration,
    };
  }

  /** The catch path of one observation: rethrow, or degrade to a critical fallback result. */
  private async failSingleDisplay(
    err: unknown,
    intent: SingleDisplayIntent,
  ): Promise<ObserveResult> {
    const { preserveDisplayState, observerMode, displayRequest, signal, iosLockState } = intent;
    if (preserveDisplayState) {
      signal?.throwIfAborted();
      if (!observerMode && (displayRequest === undefined || displayRequest === "active")) {
        logger.error("Critical error in aggregate active observation:", err);
        return this.createCriticalFallback(err);
      }
    }
    if (observerMode || preserveDisplayState) {
      throw toActionableError(err, `Unable to observe device ${this.device.deviceId}`);
    }
    if (this.shouldPropagateCaptureError(err, { display: displayRequest, signal })) {
      throw displayPinFailure(err);
    }
    const errorMessage = err instanceof Error ? err.stack || err.message : String(err);
    logger.error(`Critical error in observe command: ${errorMessage}`);
    ScreenshotJobTracker.cancelJob(this.device.deviceId);
    getScreenshotStateStore().update(
      this.device.deviceId,
      undefined,
      `Observation failed: ${errorMessage}`,
    );
    const fallback = this.createBaseResult();
    if (iosLockState) {
      fallback.deviceLock = await iosLockState;
    }
    return this.createCriticalFallback(err, { fallback });
  }

  /** Stage 1: start the foreground probe and capture the hierarchy and its derived device state. */
  private async captureSingleDisplay(run: SingleDisplayRun): Promise<SingleDisplayCaptured> {
    const { options, result, perf, queryOptions, skipWaitForFresh, minTimestamp, signal } = run;
    const foregroundSnapshot = this.startForegroundProbe(run);
    const foregroundIdentity: Promise<string | undefined> = foregroundSnapshot.then(
      (sample) => sample?.packageName,
    );
    const capturedHierarchy = await this.captureRequestedHierarchy(run);

    if (options?.hierarchyOnly) {
      // Commit verification reuses the same hierarchy/focus extraction, then
      // returns before device-state reads, cache writes, predictions or audits.
      await this.hierarchyCollector.collect(
        result,
        queryOptions,
        perf,
        skipWaitForFresh,
        minTimestamp,
        signal,
        true,
        capturedHierarchy,
        options.timeoutMs,
      );
      throwIfAborted(signal);
      perf.end();
      return { earlyResult: result, foregroundSnapshot, foregroundIdentity };
    }
    await this.captureSingleDisplayData({
      result,
      options,
      queryOptions,
      perf,
      skipWaitForFresh,
      minTimestamp,
      signal,
      skipBackStack: run.skipBackStack,
      observerMode: run.observerMode,
      preserveDisplayState: run.preserveDisplayState,
      capturedHierarchy,
      requestedDisplayId: run.requestedDisplayId,
      observedAndroid: run.observedAndroid,
    });
    return { earlyResult: undefined, foregroundSnapshot, foregroundIdentity };
  }

  /**
   * Ground-truth foreground app for the window-identity freshness check
   * (issue #5867). Started here so it overlaps hierarchy collection and adds
   * no serial latency; Android only (dumpsys resumed/focused activity),
   * best-effort.
   */
  private startForegroundProbe(run: SingleDisplayRun): SingleDisplayCaptured["foregroundSnapshot"] {
    const { options, signal, observerMode, routedAggregateSecondary, requestedDisplayId } = run;
    return !options?.hierarchyOnly &&
      this.device.platform === "android" &&
      (!observerMode || routedAggregateSecondary)
      ? this.deviceStateCollector.collectForegroundSnapshot(signal, {
          displayId: requestedDisplayId,
        })
      : Promise.resolve(null);
  }

  private buildHierarchyCaptureRequest(run: SingleDisplayRun) {
    const { options, observerMode, preserveDisplayState, minTimestamp, signal } = run;
    return {
      // The cached reader is not display-scoped; explicit Android panels require a routed sync.
      freshness:
        run.requestedDisplayId !== undefined && options?.freshness === "cached-ok"
          ? ("fresh" as const)
          : (options?.freshness ?? ("fresh" as const)),
      observerMode,
      ...(preserveDisplayState ? { preserveDisplayState: true } : {}),
      minTimestamp: minTimestamp > 0 ? minTimestamp : undefined,
      signal,
      timeoutMs: options?.timeoutMs,
      displayId: run.requestedDisplayId,
    };
  }

  /** Pre-capture the hierarchy by whichever route the request selects; undefined means collect later. */
  private async captureRequestedHierarchy(
    run: SingleDisplayRun,
  ): Promise<ViewHierarchyResult | undefined> {
    const { options, observerMode, requestedDisplayId, requestedPanel, captureStart } = run;
    const captureRequest = this.buildHierarchyCaptureRequest(run);
    if (observerMode) {
      return await this.captureObserverHierarchy(captureRequest);
    }
    if (requestedDisplayId !== undefined) {
      return await this.captureSelectedDisplayHierarchy({
        request: captureRequest,
        panelKey: requestedPanel?.key,
        captureStart,
      });
    }
    if (
      (options?.freshness || options?.hierarchyOnly) &&
      !(this.device.platform === "android" && options.requireFreshExtraction)
    ) {
      try {
        const captured = await this.hierarchyCapture.capture(captureRequest);
        return captured.hierarchy;
      } catch (error) {
        // A failed pre-capture can be retried and reported by the hierarchy collector.
        logger.warn(`[ObserveScreen] Freshness capture failed; collecting hierarchy: ${error}`);
      }
    }
    return undefined;
  }

  /** Stage 2: reconcile window and activity attribution and bind the final display. */
  private async reconcileSingleDisplay(
    run: SingleDisplayRun,
    captured: SingleDisplayCaptured,
  ): Promise<SingleDisplayReconciled> {
    const { result, signal } = run;
    // A caller may omit back-stack collection for an intermediate capture.
    // Use the sampled display's activity when CtrlProxy's window event came
    // from another panel.
    const sampledForeground = await captured.foregroundSnapshot;
    // The framework-window probe is a serial ADB read. Keep it lazy, but share
    // one result across both freshness checks for this execute() call.
    let confirmedFrameworkErrorDialog: Promise<boolean> | undefined;
    const getConfirmedFrameworkErrorDialog = (): Promise<boolean> => {
      confirmedFrameworkErrorDialog ??= this.isConfirmedFrameworkErrorDialog(
        result.viewHierarchy,
        signal,
      );
      return confirmedFrameworkErrorDialog;
    };

    const replacedStaleHierarchy = await this.recoverInitialWindowMismatch(
      run,
      captured,
      getConfirmedFrameworkErrorDialog,
    );
    if (replacedStaleHierarchy) {
      // The replacement has a new package; dialog confirmation belongs to it.
      confirmedFrameworkErrorDialog = undefined;
    }

    this.adoptSampledPrimaryActivity(run, sampledForeground);
    this.attributeRoutedAggregateSecondary(run, sampledForeground);

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

    const postCaptureForeground = await this.resolvePostCaptureForeground(run);
    await this.verifyCachedHierarchyIfRequested(run, postCaptureForeground);
    const recordProvenance = await this.bindFinalSingleDisplay(run);
    this.attachOtherDisplays(result);
    return {
      sampledForeground,
      postCaptureForeground,
      hierarchyPlatformValid,
      getConfirmedFrameworkErrorDialog,
      recordProvenance,
    };
  }

  /** Recover only a confirmed app-vs-app mismatch; returns whether the hierarchy was replaced. */
  private async recoverInitialWindowMismatch(
    run: SingleDisplayRun,
    captured: SingleDisplayCaptured,
    getConfirmedFrameworkErrorDialog: () => Promise<boolean>,
  ): Promise<boolean> {
    const { options, result, startTime, minTimestamp, signal, skipBackStack } = run;
    if (!this.shouldRecoverWrongWindow(run)) {
      return false;
    }
    // Recover before screenshots and all derived processing. Polls already manage
    // their own extraction policy.
    const initialMismatch = await this.windowIdentity.resolveWindowIdentityMismatch(
      result,
      captured.foregroundIdentity,
      { sampled: false, identity: undefined, activityAttributionMismatch: false },
      getConfirmedFrameworkErrorDialog,
      minTimestamp,
      signal,
    );
    const remainingMs = Math.min(
      500,
      (options?.timeoutMs ?? DEFAULT_HIERARCHY_READ_TIMEOUT_MS) - (this.timer.now() - startTime),
    );
    if (!initialMismatch || remainingMs <= 0) {
      return false;
    }
    await this.refreshKnownStaleHierarchy(
      result,
      initialMismatch.foreground,
      options,
      remainingMs,
      {
        skipBackStack,
        displayId: run.requestedDisplayId ?? run.observedAndroid?.logicalId ?? 0,
      },
    );
    return true;
  }

  private shouldRecoverWrongWindow(run: SingleDisplayRun): boolean {
    const { options, observerMode, preserveDisplayState, explicitlyRouted } = run;
    return (
      this.device.platform === "android" &&
      !observerMode &&
      !preserveDisplayState &&
      !explicitlyRouted &&
      !options?.skipRecompositionTracking &&
      !options?.requireFreshExtraction &&
      !options?.skipStaleWindowRecovery
    );
  }

  /** Name the sampled display's activity when CtrlProxy's window event came from another panel. */
  private adoptSampledPrimaryActivity(
    run: SingleDisplayRun,
    sampledForeground: SingleDisplayReconciled["sampledForeground"],
  ): void {
    const { result } = run;
    if (sampledForeground === null || !isMultiDisplayPrimarySample(run, sampledForeground)) {
      return;
    }
    if (
      sampledForeground.packageName === result.viewHierarchy?.packageName &&
      sampledForeground.activityName &&
      result.activeWindow
    ) {
      result.activeWindow = {
        ...result.activeWindow,
        appId: sampledForeground.packageName,
        activityName: sampledForeground.activityName,
      };
    }
  }

  private attributeRoutedAggregateSecondary(
    run: SingleDisplayRun,
    sampledForeground: SingleDisplayReconciled["sampledForeground"],
  ): void {
    if (!run.routedAggregateSecondary) {
      return;
    }
    const { result } = run;
    // CtrlProxy's last window event and the legacy Window bootstrap can name
    // another panel. Attribute only this display's sampled app or captured tree.
    const appId = sampledForeground?.packageName ?? result.viewHierarchy?.packageName;
    result.activeWindow = appId
      ? { appId, activityName: sampledForeground?.activityName ?? "", layoutSeqSum: 0 }
      : undefined;
  }

  /**
   * Routed reads retain their selected hierarchy; attribution recaptures use the
   * focused display and would silently replace it with another panel's tree.
   */
  private async resolvePostCaptureForeground(
    run: SingleDisplayRun,
  ): Promise<SingleDisplayReconciled["postCaptureForeground"]> {
    const { result, signal, observerMode, preserveDisplayState, explicitlyRouted } = run;
    if (explicitlyRouted) {
      return {
        sampled: false,
        identity: undefined,
        activityAttributionMismatch: false,
        displayId: run.requestedDisplayId,
      };
    }
    if (observerMode) {
      return { sampled: false, identity: undefined, activityAttributionMismatch: false };
    }
    return await this.reconcileActiveWindowAttribution(result, {
      signal,
      readOnly: preserveDisplayState,
    });
  }

  /**
   * An explicit observe must hand back a tree it verified against the device, or
   * report that it could not (#9963). Reconciliation above may already have
   * re-extracted; only a cache hit still served unverified costs one more read.
   */
  private async verifyCachedHierarchyIfRequested(
    run: SingleDisplayRun,
    postCaptureForeground: SingleDisplayReconciled["postCaptureForeground"],
  ): Promise<void> {
    const { options, result, signal, startTime, skipBackStack } = run;
    if (!options?.verifyCachedHierarchy || postCaptureForeground.activityAttributionMismatch) {
      return;
    }
    await this.verifyCachedAndroidHierarchy(result, {
      signal,
      remainingMs: Math.min(
        500,
        (options.timeoutMs ?? DEFAULT_HIERARCHY_READ_TIMEOUT_MS) - (this.timer.now() - startTime),
      ),
      eligible: !run.observerMode && !run.preserveDisplayState && !run.explicitlyRouted,
      sideSamples: {
        skipBackStack,
        displayId: run.requestedDisplayId ?? run.observedAndroid?.logicalId ?? 0,
      },
    });
  }

  /**
   * Reconciliation can replace the tree. Bind the final hierarchy's panel
   * before screenshot routing or transition fencing observes this result.
   */
  private async bindFinalSingleDisplay(run: SingleDisplayRun): Promise<DisplayRecordProvenance> {
    const finalBinding = this.displayBinding.bindFinalDisplay({
      result: run.result,
      displayRequest: run.displayRequest,
      androidDisplayCache: run.androidDisplayCache,
      observedAndroid: run.observedAndroid,
      requestedPanel: run.requestedPanel,
      requestedDisplayId: run.requestedDisplayId,
      explicitlyRouted: run.explicitlyRouted,
      preserveDisplayState: run.preserveDisplayState,
      observerMode: run.observerMode,
      recordProvenance: run.captureStart,
      signal: run.signal,
    });
    // Only the Android binding is asynchronous; await it only then so iOS adds no tick.
    return (finalBinding instanceof Promise ? await finalBinding : finalBinding).recordProvenance;
  }

  private attachOtherDisplays(result: ObserveResult): void {
    const panels = this.device.displays?.panels;
    if (panels && panels.length > 1) {
      result.otherDisplays = panels
        .filter((panel) => panel.key !== result.display.key)
        .map((panel) => ({ key: panel.key, role: panel.role, size: panel.sizePx }));
    }
  }

  /** Stage 3: derive elements, start screenshots, and run audits and predictions. */
  private async enrichSingleDisplay(run: SingleDisplayRun): Promise<void> {
    this.enrichSingleDisplayElements({ result: run.result });
    await this.startSingleDisplayScreenshot(run);
    await this.runSingleDisplayAudits(run);
  }

  private async startSingleDisplayScreenshot(run: SingleDisplayRun): Promise<void> {
    const { options, result, perf, signal, screenshotMode, requestedDisplayId } = run;
    // The hierarchy has completed before any capture starts.
    if (screenshotMode === "none") {
      result.screenshotCaptureAttempted = false;
      return;
    }
    const screenshotDisplayId = requestedDisplayId;
    const capture = prototypeCaptureOptions(options?.screenshotOptions);
    result.screenshotCaptureAttempted = true;
    stampPrototypeHidden(result, capture);
    if (screenshotMode === "settled") {
      result.screenshotOrientation = this.device.platform === "ios" ? "native" : "display";
      await this.captureSettledScreenshot(
        result,
        perf,
        signal,
        options?.screenshot === "settled",
        screenshotDisplayId,
        options?.screenshotOptions,
      );
    } else if (serverConfig.getAccessibilityAuditConfig()) {
      await this.screenshotRecorder.capture(
        result.observationId,
        perf,
        signal,
        screenshotDisplayId,
        capture,
      );
    } else {
      this.screenshotRecorder.start(
        result.observationId,
        perf,
        signal,
        screenshotDisplayId,
        capture,
      );
    }
  }

  private async runSingleDisplayAudits(run: SingleDisplayRun): Promise<void> {
    const { options, result, perf, signal, observerMode } = run;
    // Attach recomposition metrics if enabled.
    if (!options?.skipRecompositionTracking && !observerMode) {
      await this.processRecomposition(result, perf);
    }

    // Audits + accessibility state detection (each is config-gated; failures don't propagate)
    if (!options?.skipPerformanceAudit && !observerMode) {
      await this.performanceAuditor.run(result, perf);
    }
    if (!options?.skipAccessibilityAudit && !observerMode) {
      await this.accessibilityAuditor.run(result, perf);
    }
    if (!observerMode) {
      await this.accessibilityStateDetector.run(result, perf, signal);
    }

    if (!observerMode) {
      await this.attachPredictionsIfEnabled(result);
    }
  }

  /** Predictive UI (opt-in via config). */
  private async attachPredictionsIfEnabled(result: ObserveResult): Promise<void> {
    if (!serverConfig.isPredictiveUiEnabled()) {
      return;
    }
    try {
      const predictions = await this.predictiveUIState.generate(result, this.device);
      this.attachPredictions(result, predictions);
    } catch (error) {
      logger.warn(`[PredictiveUIState] Failed to generate predictions: ${error}`);
    }
  }

  /** Stage 4: compute the freshness verdict, settle display provenance and cache the result. */
  private async settleSingleDisplay(
    run: SingleDisplayRun,
    captured: SingleDisplayCaptured,
    reconciled: SingleDisplayReconciled,
  ): Promise<void> {
    const { options, result, perf, signal, observerMode, preserveDisplayState } = run;
    await this.computeSingleDisplayFreshness(run, captured, reconciled);

    const { staleDisplay, geometryTransition } = this.reconcileSingleDisplayFreshness({
      result,
      observerMode,
      preserveDisplayState,
      explicitlyRouted: run.explicitlyRouted,
      recordProvenance: reconciled.recordProvenance,
    });
    const cacheGeneration = geometryTransition
      ? getObserveCacheStore().currentGeneration(this.device.deviceId)
      : run.cacheGeneration;
    if (
      this.device.platform === "android" &&
      (geometryTransition ||
        displayTransitions.revision(this.device.deviceId) !== run.captureStart.revision)
    ) {
      await this.resampleDeviceLock(result, signal);
    }
    this.identifyCapture(result, options?.freshness ?? "cached-ok");
    if (run.iosLockState) {
      result.deviceLock = await run.iosLockState;
    }

    // Polls defer their cache write until ObservePoll selects the returned result.
    if (!staleDisplay && shouldCacheSingleDisplay(run)) {
      await perf.track("cacheResult", () =>
        getObserveCacheStore().put(this.device.deviceId, result, cacheGeneration),
      );
    }
  }

  private async resampleDeviceLock(result: ObserveResult, signal: AbortSignal | undefined) {
    // The ordinary lock sample may precede a fold discovered by the final hierarchy.
    delete result.deviceLock;
    await this.deviceStateCollector.collectDeviceLock(result, signal);
  }

  /**
   * Freshness diagnostics.
   *
   * This used to read `isFresh = requestedAfter === undefined ? true : …`,
   * i.e. the literal `true` on every plain `observe` call — and
   * `minTimestamp` is not reachable from the public tool schema, so that was
   * the path virtually every consumer took. The field named for the exact
   * property in question measured nothing. It is now always a measurement:
   * capture age, plus whether the delegate verified the tree against the
   * device on this call. See ./observationFreshness.ts.
   *
   * Computed BEFORE caching so the persisted result carries the verdict: the
   * observe cache serializes the result at `put` time (the filesystem store),
   * so a verdict attached afterward would be lost on a daemon-restart cache
   * reload within the TTL, and a consumer reading the cached tree directly
   * (e.g. `SwipeOn.getScrollableContext`, nav/registry embeds) would accept a
   * phantom hierarchy without its `isFresh: false` signal (issue #5867).
   */
  private async computeSingleDisplayFreshness(
    run: SingleDisplayRun,
    captured: SingleDisplayCaptured,
    reconciled: SingleDisplayReconciled,
  ): Promise<void> {
    const { result, minTimestamp, signal, observerMode } = run;
    const { foregroundIdentity } = captured;
    const { postCaptureForeground, getConfirmedFrameworkErrorDialog } = reconciled;
    const statusBarOnlyHierarchy = await this.windowIdentity.resolveStatusBarOnlyHierarchy(
      result,
      foregroundIdentity,
      postCaptureForeground,
      signal,
    );
    await this.windowIdentity.attributeFocusedOwnWindowToForeground(
      result,
      foregroundIdentity,
      minTimestamp,
    );
    const windowIdentityMismatch = await this.windowIdentity.resolveWindowIdentityMismatch(
      result,
      foregroundIdentity,
      postCaptureForeground,
      getConfirmedFrameworkErrorDialog,
      minTimestamp,
      signal,
    );
    result.freshness = computeFreshness({
      requestedAfter: minTimestamp > 0 ? minTimestamp : undefined,
      actualTimestamp: this.resolveObservationTimestampMs(result),
      hostAgeBasisMs: this.windowIdentity.resolveHostReceivedAtMs(result),
      now: this.timer.now(),
      verified:
        typeof result.viewHierarchy === "object" && result.viewHierarchy !== null
          ? result.viewHierarchy.fresh
          : undefined,
      ...describeHierarchyUnavailability(run, reconciled),
      missingForegroundWindow: resolveMissingForegroundWindow(result),
      statusBarOnlyHierarchy,
      windowIdentityMismatch,
      activityAttributionMismatch: postCaptureForeground.activityAttributionMismatch,
      // A matching package and recent timestamp do not verify an empty first-run
      // capture (#6352). Use all content collections, not just clickable controls:
      // text-only and media-only screens remain valid. This runs before caching.
      emptyFocusedWindow: this.device.platform === "android" && isEmptyFocusedWindow(result),
      incompleteCapture: await this.describeIncompleteSingleDisplay(run, reconciled),
    });

    if (windowIdentityMismatch) {
      recordWrongWindowEvidence(result);
    }

    if (observerMode && result.freshness?.unavailableDetail) {
      result.freshness.warning += ` ${result.freshness.unavailableDetail}`;
    }
  }

  /**
   * The SETTLED/confirmed foreground, not the initial parallel sample: during an
   * A→B transition the initial sample can still read A while the hierarchy and the
   * confirming read are already on B, and comparing against stale A would retract a
   * capture that was just confirmed as B (#6151 follow-up). Only sampled when the
   * flag is actually set — the common case never pays the extra device read.
   */
  private async describeIncompleteSingleDisplay(
    run: SingleDisplayRun,
    reconciled: SingleDisplayReconciled,
  ) {
    const { viewHierarchy } = run.result;
    const incomplete = viewHierarchy?.ctrlProxyIncomplete === true;
    return describeIncompleteCapture(
      viewHierarchy,
      incomplete
        ? await this.windowIdentity.confirmForegroundIdentity(
            reconciled.postCaptureForeground,
            run.signal,
          )
        : undefined,
      incomplete ? await reconciled.getConfirmedFrameworkErrorDialog() : false,
    );
  }

  /** Stage 5: attach timings, protect the screenshot and decide whether the read grants authority. */
  private async publishSingleDisplay(run: SingleDisplayRun): Promise<ObserveResult> {
    const { result, perf, startTime, skipBackStack, observerMode } = run;
    perf.end();

    // Attach the windowed performance snapshot when opted in (independent of --debug-perf).
    if (!observerMode) {
      await this.attachPerfSnapshot(result);
    }
    attachPerfTimings(result, perf);

    if (result.screenshotPath) {
      result.screenshotExpiresAt = await this.pathProtection.protect(result.screenshotPath);
    }
    if (this.device.platform === "android" && !observerMode && skipBackStack) {
      this.deferredBackStackDisplays.set(
        result,
        run.requestedDisplayId ?? run.observedAndroid?.logicalId ?? 0,
      );
    }
    logger.debug("Observe command completed");
    logger.debug(`Total observe command execution took ${this.timer.now() - startTime}ms`);
    return this.grantsObservationRead(result) ? recordObservationRead(result) : result;
  }

  /**
   * cached-ok may serve CtrlProxy's client cache without a device read.
   * Its fresh=false verdict must not grant this action acquisition authority.
   */
  private grantsObservationRead(result: ObserveResult): boolean {
    if (this.device.platform === "ios") {
      return wasIosHierarchyAcquiredFromDevice(result.viewHierarchy);
    }
    return this.device.platform !== "android" || result.viewHierarchy?.fresh === true;
  }

  /**
   * One bounded hierarchy extraction; derived work and screenshots run later once. The
   * lock state and back stack sampled with the discarded window are re-read against the
   * replacement (#9982), within the same budget and only when the replacement is applied.
   */
  private async refreshKnownStaleHierarchy(
    result: ObserveResult,
    foreground: string,
    options: ObserveScreenExecuteOptions | undefined,
    remainingMs: number,
    sideSamples: { skipBackStack: boolean; displayId: number },
  ): Promise<void> {
    const startedAt = this.timer.now();
    const hierarchy = await this.readIndependentHierarchy(
      result.viewHierarchy?.updatedAt,
      options?.signal,
      remainingMs,
      "Known-stale hierarchy refresh",
    );
    if (
      hierarchy?.fresh === true &&
      hasUsableHierarchy(hierarchy) &&
      hierarchy.packageName === foreground &&
      this.platformValidator.validate(this.device.platform, hierarchy).valid
    ) {
      this.applyRecapturedHierarchy(result, hierarchy);
      this.recorrelateActiveWindowToRecapture(result, hierarchy);
      // Earlier back-stack/lock samples describe the discarded window.
      delete result.backStack;
      delete result.deviceLock;
      await this.resampleAfterStaleWindowRecovery(result, {
        ...sideSamples,
        signal: options?.signal,
        budgetMs: remainingMs - (this.timer.now() - startedAt),
      });
    }
  }

  /**
   * Re-read the lock state and (unless the caller skipped it) the back stack for the
   * window that replaced a stale one. The reads land on a scratch observation and are
   * copied only if they finish inside the budget, so a read that loses the deadline
   * cannot write onto the published result later. A failed or late read leaves the
   * field absent.
   */
  private async resampleAfterStaleWindowRecovery(
    result: ObserveResult,
    options: {
      skipBackStack: boolean;
      displayId: number;
      signal: AbortSignal | undefined;
      budgetMs: number;
    },
  ): Promise<void> {
    const { skipBackStack, displayId, signal, budgetMs } = options;
    if (budgetMs <= 0) {
      return;
    }
    const sampled: ObserveResult = {
      ...result,
      deviceLock: undefined,
      backStack: undefined,
      errors: undefined,
    };
    const abort = new AbortController();
    const readSignal = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
    try {
      await raceWithDeadline(
        Promise.all([
          this.deviceStateCollector.collectDeviceLock(sampled, readSignal),
          skipBackStack
            ? Promise.resolve()
            : this.deviceStateCollector.collectBackStack(
                sampled,
                new NoOpPerformanceTracker(),
                readSignal,
                displayId,
              ),
        ]),
        {
          timer: this.timer,
          timeoutMs: budgetMs,
          signal,
          label: "Stale-window side-sample refresh",
          onTimeout: () => abort.abort(),
        },
      );
    } catch (error) {
      throwIfAborted(signal);
      logger.warn(
        `[ObserveScreen] Stale-window side-sample refresh failed: ${describeError(error)}`,
        error,
      );
      return;
    }
    if (sampled.deviceLock) {
      result.deviceLock = sampled.deviceLock;
    }
    if (sampled.backStack) {
      result.backStack = sampled.backStack;
    }
    for (const error of sampled.errors ?? []) {
      appendObserveError(result, error);
    }
  }

  /**
   * Explicit-observe verification (#9963). CtrlProxy serves a push-cache entry younger
   * than its serve window without a device read, which `computeFreshness` reports as
   * unverified, so the next action re-observes in full. Replace such a hit with one
   * synchronous extraction of the same window. Only an unverified same-package tree is
   * replaced. Samples taken alongside the cached tree are kept when the new tree itself
   * names the same activity as the kept `activeWindow`. When it names another one or
   * cannot be compared, they are dropped and re-read for the new window with the budget
   * left over (#9982), so the field is only absent if that re-read fails or runs out of
   * time. When the read fails the cached tree stays and its freshness verdict keeps
   * saying it was not verified.
   */
  private async verifyCachedAndroidHierarchy(
    result: ObserveResult,
    options: {
      signal?: AbortSignal;
      remainingMs: number;
      eligible: boolean;
      sideSamples: { skipBackStack: boolean; displayId: number };
    },
  ): Promise<void> {
    const cached = result.viewHierarchy;
    if (!cached || !this.needsCachedVerification(cached, options)) {
      return;
    }
    const startedAt = this.timer.now();
    const hierarchy = await this.readIndependentHierarchy(
      cached.updatedAt,
      options.signal,
      options.remainingMs,
      "Cached hierarchy verification",
    );
    if (!hierarchy || !this.isVerifyingReplacement(hierarchy, cached)) {
      return;
    }
    const sameWindow = treeNamesWindow(hierarchy, result.activeWindow);
    this.applyRecapturedHierarchy(result, hierarchy);
    if (!sameWindow) {
      // A same-package A->B move between the adb reads and this read would publish
      // B's tree under A's identity. The kept samples cannot be tied to the new tree,
      // so re-correlate exactly as the other recapture paths do, then re-read the
      // samples for the window now being published. Only this path reads the device.
      this.recorrelateActiveWindowToRecapture(result, hierarchy);
      delete result.backStack;
      delete result.deviceLock;
      await this.resampleAfterStaleWindowRecovery(result, {
        ...options.sideSamples,
        signal: options.signal,
        budgetMs: options.remainingMs - (this.timer.now() - startedAt),
      });
    }
  }

  private needsCachedVerification(
    cached: NonNullable<ObserveResult["viewHierarchy"]>,
    options: { eligible: boolean; remainingMs: number },
  ): boolean {
    return (
      options.eligible &&
      this.device.platform === "android" &&
      cached.fresh !== true &&
      hasUsableHierarchy(cached) &&
      options.remainingMs > 0
    );
  }

  private isVerifyingReplacement(
    hierarchy: NonNullable<ObserveResult["viewHierarchy"]>,
    cached: NonNullable<ObserveResult["viewHierarchy"]>,
  ): boolean {
    return (
      hierarchy.fresh === true &&
      hasUsableHierarchy(hierarchy) &&
      hierarchy.packageName === cached.packageName &&
      this.platformValidator.validate(this.device.platform, hierarchy).valid
    );
  }

  /**
   * One extraction that must not be served from the host cache. A positive, inclusive
   * device floor requests independent extraction without requiring the replacement to
   * have a later timestamp. Failures are logged and yield `undefined`; only an abort
   * propagates.
   */
  private async readIndependentHierarchy(
    updatedAt: number | undefined,
    signal: AbortSignal | undefined,
    remainingMs: number,
    label: string,
  ): Promise<ViewHierarchyResult | undefined> {
    const retryController = new AbortController();
    const retrySignal = signal
      ? AbortSignal.any([signal, retryController.signal])
      : retryController.signal;
    try {
      return await raceWithDeadline(
        // Use the same reader as the initial collection, including its injected
        // client. A fresh action capture can construct a separate resident client.
        () =>
          this.viewHierarchy.getViewHierarchy(
            {},
            new NoOpPerformanceTracker(),
            true,
            Math.max(1, updatedAt ?? 1),
            retrySignal,
            { timeoutMs: remainingMs, requireFreshExtraction: true },
          ),
        {
          timer: this.timer,
          timeoutMs: remainingMs,
          signal,
          label,
          onTimeout: () => retryController.abort(),
        },
      );
    } catch (error) {
      throwIfAborted(signal);
      logger.warn(`[ObserveScreen] ${label} failed: ${describeError(error)}`, error);
      return undefined;
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
        this.device.platform,
        result.viewHierarchy,
        freshness,
        this.timer,
        this.idGenerator,
        {
          captureId: result.observationId,
          iosMultiPanel:
            this.device.platform === "ios" && (this.device.displays?.panels.length ?? 0) > 1,
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
    signal?: AbortSignal,
    observation?: ObserveResult,
    screenshot?: ScreenshotMode,
    screenshotOptions?: ObserveScreenshotOptions,
  ): Promise<void> {
    const screenshotObservation = observation ?? this.createBaseResult();
    const displayId = await this.screenshotDisplayId(signal, observation);
    const screenshotMode = resolveScreenshotMode(screenshot);
    const capture = prototypeCaptureOptions(screenshotOptions);
    if (observation) {
      observation.screenshotCaptureAttempted = true;
      stampPrototypeHidden(observation, capture);
      if (screenshotMode === "settled") {
        observation.screenshotOrientation = this.device.platform === "ios" ? "native" : "display";
      }
    }
    if (screenshotMode === "settled") {
      await this.captureSettledScreenshot(
        screenshotObservation,
        perf,
        signal,
        screenshot === "settled",
        displayId,
        screenshotOptions,
      );
    } else {
      await this.screenshotRecorder.captureFresh(
        screenshotObservation.observationId,
        perf,
        signal,
        displayId,
        capture,
      );
    }
    if (observation) {
      await this.runAccessibilityAudit(observation, perf);
    }
  }

  private async captureSettledScreenshot(
    observation: ObserveResult,
    perf: PerformanceTracker,
    signal: AbortSignal | undefined,
    strict: boolean,
    displayId?: number,
    screenshotOptions?: ObserveScreenshotOptions,
  ): Promise<void> {
    try {
      if (!this.screenshotRecorder.captureSettled) {
        throw new ActionableError("Settled screenshot capture is unavailable");
      }
      const path = await this.screenshotRecorder.captureSettled(
        observation.observationId,
        perf,
        signal,
        displayId,
        screenshotOptions,
      );
      const screenshotEvidence = await observationScreenshotEvidence(path, "fresh", undefined, {
        files: this.screenshotEvidenceFiles,
        timer: this.timer,
        protection: this.pathProtection,
      });
      Object.assign(observation, screenshotEvidence);
      const imageSize = getScreenshotStateStore().getImageSizeForObservation(
        this.device.deviceId,
        observation.observationId,
        path,
      );
      await this.attachScreenshotRaster(observation, imageSize);
      this.refineIosPanelOrientation(observation);
      observation.screenshotSettled = true;
    } catch (error) {
      signal?.throwIfAborted();
      if (strict) {
        throw new StrictSettledScreenshotCaptureError(error, this.device.deviceId);
      }
      observation.screenshotSettled = false;
      observation.screenshotSettledError = describeError(error);
      logger.warn(
        `[OBSERVE] Settled screenshot unavailable: ${observation.screenshotSettledError}`,
        error,
      );
    }
  }

  private refineIosPanelOrientation(observation: ObserveResult): void {
    // Only settled multi-panel iOS captures refine the platform orientation preset.
    if (this.device.platform === "ios" && (this.device.displays?.panels.length ?? 0) > 1) {
      const rasterSize = observation.screenshotImageSize;
      observation.screenshotOrientation =
        rasterSize &&
        rasterSize.width > rasterSize.height ===
          observation.screenSize.width > observation.screenSize.height
          ? "display"
          : "native";
    }
  }

  /** Best-effort raster evidence belongs to the returned path, never the screen-size guess. */
  private async attachScreenshotRaster(
    observation: ObserveResult,
    imageSize: { width: number; height: number } | undefined,
  ): Promise<void> {
    delete observation.screenshotImageSize;
    delete observation.screenshotPixelsPerNativeUnit;
    delete observation.screenshotScaleProvenance;
    try {
      if (
        !imageSize ||
        ![imageSize.width, imageSize.height].every((value) => Number.isInteger(value) && value > 0)
      ) {
        logger.warn("[OBSERVE] Could not read screenshot raster dimensions");
        return;
      }
      observation.screenshotImageSize = { width: imageSize.width, height: imageSize.height };
      const hierarchy: Partial<ViewHierarchyResult> = observation.viewHierarchy ?? {};
      const scale = snapshotRasterGeometry(
        imageSize,
        {
          platform: this.device.platform,
          screenSize: observation.screenSize,
          rotation: hierarchy.rotation ?? observation.rotation,
          nativeScale: hierarchy.nativeScale,
          rasterOrientation:
            this.device.platform === "ios" &&
            !(
              (this.device.displays?.panels.length ?? 0) > 1 &&
              imageSize.width > imageSize.height ===
                observation.screenSize.width > observation.screenSize.height
            )
              ? "native"
              : "display",
        },
        "observe",
      );
      observation.screenshotPixelsPerNativeUnit = scale.pixelsPerNativeUnit;
      observation.screenshotScaleProvenance = scale.scaleProvenance;
    } catch (error) {
      logger.warn(
        `[OBSERVE] Could not derive screenshot raster scale: ${describeError(error)}`,
        error,
      );
      return;
    }
  }

  async runAccessibilityAudit(
    observation: ObserveResult,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
  ): Promise<void> {
    await this.accessibilityAuditor.run(observation, perf);
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
      snapshot.startup = getLastStartupTimingMs(this.device.deviceId, appId);
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
    return this.hierarchyCollector.extractScreenSize(
      viewHierarchy,
      this.device.platform === "ios" && (this.device.displays?.panels.length ?? 0) > 1,
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
      units: this.device.platform === "ios" ? "points" : "physical-pixels",
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
  collectAllData(
    result: ObserveResult,
    queryOptions?: import("../../models/ViewHierarchyQueryOptions").ViewHierarchyQueryOptions,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    skipWaitForFresh: boolean = false,
    minTimestamp: number = 0,
    signal?: AbortSignal,
    skipBackStack: boolean = false,
    readOnly: boolean = false,
    capturedHierarchy?: ViewHierarchyResult,
    readOptions?: number | HierarchyReadOptions,
    displayId: number = 0,
  ): Promise<void> {
    switch (this.device.platform) {
      case "android":
        return this.androidCollector.collect({
          result,
          queryOptions,
          perf,
          skipWaitForFresh,
          minTimestamp,
          signal,
          skipBackStack,
          readOnly,
          capturedHierarchy,
          readOptions,
          displayId,
        });
      case "ios":
        return this.iosCollector.collect({
          result,
          queryOptions,
          perf,
          skipWaitForFresh,
          minTimestamp,
          signal,
          readOnly,
          capturedHierarchy,
          readOptions,
        });
      default:
        return Promise.resolve();
    }
  }

  private attachPredictions(
    result: ObserveResult,
    predictions: ObserveResult["predictions"],
  ): void {
    if (predictions) {
      result.predictions = predictions;
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

  /**
   * `getForegroundApp` reports the resumed activity beneath an AppErrorDialog,
   * while the dialog itself is the focused framework window. Confirm that rare
   * divergence before treating the captured `android` hierarchy as stale.
   */
  private async isConfirmedFrameworkErrorDialog(
    viewHierarchy: ViewHierarchyResult | undefined,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (viewHierarchy?.packageName !== FRAMEWORK_WINDOW_PACKAGE) {
      return false;
    }
    const parser = new DefaultElementParser();
    let appErrorResourceFound = false;
    let alertTitleFound = false;
    let closeAppButtonFound = false;
    let waitButtonFound = false;
    let anrTitleFound = false;
    let waitActionFound = false;
    for (const root of parser.extractRootNodes(viewHierarchy)) {
      parser.traverseNode(root, (node: unknown) => {
        const properties = parser.extractNodeProperties(node as ViewHierarchyNode);
        const resourceId = properties["resource-id"] ?? properties.resourceId;
        appErrorResourceFound ||=
          typeof resourceId === "string" && resourceId.startsWith(APP_ERROR_RESOURCE_ID_PREFIX);
        alertTitleFound ||= resourceId === ALERT_TITLE_RESOURCE_ID;
        closeAppButtonFound ||= resourceId === CLOSE_APP_BUTTON_RESOURCE_ID;
        waitButtonFound ||= resourceId === WAIT_BUTTON_RESOURCE_ID;
        const text = properties.text ?? properties["content-desc"];
        anrTitleFound ||= typeof text === "string" && /\b(?:isn't|is not) responding\b/i.test(text);
        waitActionFound ||= text === "Wait";
      });
    }
    const capturedDialog =
      appErrorResourceFound ||
      (anrTitleFound && waitActionFound) ||
      (alertTitleFound && closeAppButtonFound && waitButtonFound);
    if (!capturedDialog) {
      return false;
    }
    try {
      const { stdout } = await this.adb.executeCommand(`shell "dumpsys window"`, { signal });
      return /mCurrentFocus=Window\{[^}\r\n]*Application (?:Error:|Not Responding)/.test(stdout);
    } catch (error) {
      // This optional confirmation must not fail observe; fall back to the normal mismatch gate.
      logger.debug("Failed to read focused framework window from dumpsys:", error);
      return false;
    }
  }

  private resolveObservationTimestampMs(result: ObserveResult): number | undefined {
    return result.viewHierarchy?.updatedAt;
  }
}

/** The prototype-hiding part of an observe's screenshot options, for the non-settled captures. */
function prototypeCaptureOptions(
  options: ObserveScreenshotOptions | undefined,
): { hidePrototypes: true } | undefined {
  return options?.hidePrototypes === true ? { hidePrototypes: true } : undefined;
}

/**
 * A capture requested with the prototype hidden either excludes it or produces no image (#9305), so
 * the observation is marked when the capture is requested; observe reports it for `layer: "app"`.
 */
function stampPrototypeHidden(
  observation: ObserveResult,
  capture: { hidePrototypes: true } | undefined,
): void {
  if (capture) {
    observation.screenshotIncludesPrototype = false;
  } else {
    // A new capture without hiding replaces whatever an earlier capture of this object recorded.
    delete observation.screenshotIncludesPrototype;
  }
}

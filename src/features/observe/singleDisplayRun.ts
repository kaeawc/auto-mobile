import type { ObserveResult, ViewHierarchyResult } from "../../models";
import type { ObservedAndroidDisplay } from "./ObservationDisplay";
import type { PerformanceTracker } from "../../utils/PerformanceTracker";
import { processTimingData } from "../../utils/PerformanceTracker";
import { resolveScreenshotMode, type ScreenshotMode } from "./automaticScreenshotPolicy";
import type {
  DisplayRecordProvenance,
  DisplayTargetBinding,
  DisplayTargetContext,
} from "./collectors/DisplayBindingCollector";
import type { DeviceStateCollector } from "./collectors/DeviceStateCollector";
import type { IosLockStateProbe } from "./ios/IosLockStateProbe";
import type { PostCaptureForegroundIdentity } from "./ActiveWindowAttribution";
import type { ObserveScreenExecuteOptions } from "./interfaces/ObserveScreen";

/**
 * Value types and pure helpers for the stages of one single-display observation
 * (capture, reconcile, enrich, settle, publish) that ObserveScreen orchestrates.
 */

/** Caller options normalized once; shared by every stage and by the failure path. */
export interface SingleDisplayIntent {
  options: (ObserveScreenExecuteOptions & { preserveDisplayState?: boolean }) | undefined;
  perf: PerformanceTracker;
  queryOptions: ObserveScreenExecuteOptions["queryOptions"];
  skipWaitForFresh: boolean;
  minTimestamp: number;
  signal: AbortSignal | undefined;
  skipBackStack: boolean;
  observerMode: boolean;
  preserveDisplayState: boolean;
  displayRequest: DisplayTargetContext["displayRequest"];
  androidDisplayCache: DisplayTargetContext["androidDisplayCache"];
  screenshotMode: ScreenshotMode;
  iosLockState: ReturnType<IosLockStateProbe["read"]> | undefined;
}

/** One observation in flight: the intent plus what the display target and capture fences resolved. */
export interface SingleDisplayRun extends SingleDisplayIntent, DisplayTargetBinding {
  result: ObserveResult;
  startTime: number;
  captureStart: DisplayRecordProvenance;
  routedAggregateSecondary: boolean;
  cacheGeneration: number;
}

export interface SingleDisplayCaptured {
  earlyResult: ObserveResult | undefined;
  foregroundSnapshot: ReturnType<DeviceStateCollector["collectForegroundSnapshot"]>;
  foregroundIdentity: Promise<string | undefined>;
}

export interface SingleDisplayReconciled {
  sampledForeground: Awaited<SingleDisplayCaptured["foregroundSnapshot"]>;
  postCaptureForeground: PostCaptureForegroundIdentity;
  hierarchyPlatformValid: boolean;
  getConfirmedFrameworkErrorDialog: () => Promise<boolean>;
  recordProvenance: DisplayRecordProvenance;
}

function resolveSkipWaitForFresh(
  options: Pick<ObserveScreenExecuteOptions, "freshness" | "skipWaitForFresh"> | undefined,
): boolean {
  return options?.freshness
    ? options.freshness === "cached-ok"
    : (options?.skipWaitForFresh ?? true);
}

/** The sample describes a multi-display device whose primary display this observation targets. */
export function isMultiDisplayPrimarySample(
  run: Pick<SingleDisplayRun, "result" | "requestedDisplayId" | "observedAndroid">,
  sampled: { displayCount?: number },
): boolean {
  return (
    (run.result.backStack?.displayCount ?? 0) < 2 &&
    (sampled.displayCount ?? 0) > 1 &&
    (run.requestedDisplayId ?? run.observedAndroid?.logicalId) === 0
  );
}

/** The option-derived intent fields that need no device or timer access. */
export function resolveSingleDisplayFlags(
  options: (ObserveScreenExecuteOptions & { preserveDisplayState?: boolean }) | undefined,
) {
  return {
    preserveDisplayState: options?.preserveDisplayState === true,
    observerMode: options?.observerMode === true,
    queryOptions: options?.queryOptions,
    skipWaitForFresh: resolveSkipWaitForFresh(options),
    minTimestamp: options?.minTimestamp ?? 0,
    signal: options?.signal,
    skipBackStack: options?.skipBackStack ?? false,
    screenshotMode: (options?.skipScreenshot
      ? "none"
      : resolveScreenshotMode(options?.screenshot)) as ScreenshotMode,
  };
}

export function shouldCacheSingleDisplay(
  run: Pick<SingleDisplayRun, "options" | "observerMode" | "preserveDisplayState">,
): boolean {
  const { options } = run;
  return (
    !run.observerMode &&
    !run.preserveDisplayState &&
    !options?.skipCache &&
    !options?.skipRecompositionTracking
  );
}

/** True when the captured hierarchy carries no usable tree. */
export function isHierarchyUnusable(result: ObserveResult, preserveDisplayState: boolean): boolean {
  const hierarchy = result.viewHierarchy?.hierarchy;
  return (
    (preserveDisplayState && hierarchy?.unavailableReason !== undefined) ||
    hierarchy === undefined ||
    hierarchy.error !== undefined ||
    (result.viewHierarchy?.ctrlProxyIncomplete === true && !hierarchy.node)
  );
}

/** The freshness fields describing whether the captured hierarchy is usable at all. */
export function describeHierarchyUnavailability(
  run: Pick<
    SingleDisplayRun,
    "result" | "preserveDisplayState" | "requestedDisplayId" | "routedAggregateSecondary"
  >,
  reconciled: Pick<SingleDisplayReconciled, "sampledForeground" | "hierarchyPlatformValid">,
) {
  const { result, requestedDisplayId } = run;
  const foregroundUnavailable =
    run.routedAggregateSecondary && reconciled.sampledForeground === null;
  const hierarchy = result.viewHierarchy?.hierarchy;
  return {
    unavailable:
      foregroundUnavailable ||
      !reconciled.hierarchyPlatformValid ||
      isHierarchyUnusable(result, run.preserveDisplayState),
    unavailableReason:
      hierarchy?.unavailableReason ?? (foregroundUnavailable ? "unknown" : undefined),
    unavailableDetail:
      hierarchy?.unavailableDetail ??
      (foregroundUnavailable
        ? `The foreground app of display ${requestedDisplayId} could not be determined.`
        : undefined),
  };
}

/** Attach performance timing if enabled (with filtering and truncation). */
export function attachPerfTimings(result: ObserveResult, perf: PerformanceTracker): void {
  const processedTimings = processTimingData(perf.getTimings());
  if (!processedTimings) {
    return;
  }
  result.perfTiming = processedTimings.data;
  if (processedTimings.truncated) {
    result.perfTimingTruncated = true;
  }
}

export interface SingleDisplayStageContext {
  result: ObserveResult;
}

export interface SingleDisplayCaptureContext extends SingleDisplayStageContext {
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

export interface SingleDisplayReconciliationContext extends SingleDisplayStageContext {
  observerMode: boolean;
  preserveDisplayState: boolean;
  explicitlyRouted: boolean;
  recordProvenance: { revision: number; identityRevision: number };
}

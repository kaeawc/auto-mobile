import { applyIosLockStateReading } from "./ios/IosLockStateProbe";
import type { ObservationCollectionRequest } from "./collectors/ObservationCollectionRequest";
import { displayPinFailure } from "./SessionDisplayContext";
import { SelectedDisplayReadPolicy } from "./SelectedDisplayRead";
import { HierarchyCapture } from "./HierarchyCapture";
import { logger } from "../../utils/logger";
import { throwIfAborted } from "../../utils/toolUtils";
import { BootedDevice, ObserveResult, ViewHierarchyResult } from "../../models";
import { NoOpPerformanceTracker } from "../../utils/PerformanceTracker";
import {
  resolveSingleDisplayFlags,
  SingleDisplayCaptureContext,
  SingleDisplayCaptured,
  SingleDisplayIntent,
  SingleDisplayRun,
} from "./singleDisplayRun";
import {
  captureObserverHierarchy,
  captureSelectedDisplayHierarchy,
  shouldPropagateCaptureError,
} from "./hierarchyCaptureRoutes";
import { ScreenshotJobTracker } from "../../utils/ScreenshotJobTracker";
import { Timer } from "../../utils/SystemTimer";
import type { ObserveScreenExecuteOptions } from "./interfaces/ObserveScreen";
import { getObserveCacheStore } from "./cache/ObserveCacheRegistry";
import { getScreenshotStateStore } from "./screenshot/ScreenshotStateRegistry";
import { DisplayBindingCollector } from "./collectors/DisplayBindingCollector";
import type { DeviceStateCollectorPort, HierarchyCollectorPort } from "./collectors/collectorPorts";
import { toActionableError } from "../../models/ActionableError";
import { resolveIosDeviceKind } from "../../utils/ios-cmdline-tools/IosDeviceKind";
import { IosLockStateProbe } from "./ios/IosLockStateProbe";
import { ObservedAndroidDisplayCache } from "./ObservationDisplay";
import { displayTransitions } from "./DisplayTransition";

/** Stages 0 and 1 of one single-display observation: normalize the caller's options, resolve the targeted display, then capture the hierarchy and derived device state. */
export interface SingleDisplayCaptureStageDependencies {
  device: () => BootedDevice;
  timer: () => Timer;
  displayBinding: () => DisplayBindingCollector;
  hierarchyCapture: () => HierarchyCapture;
  hierarchyCollector: () => HierarchyCollectorPort;
  deviceStateCollector: () => DeviceStateCollectorPort;
  iosLockStateProbe: () => IosLockStateProbe;
  observedAndroidDisplayCache: () => ObservedAndroidDisplayCache;
  requestedDisplay: () => string | undefined;
  selectedDisplayRead: () => SelectedDisplayReadPolicy;
  createBaseResult: () => ObserveResult;
  createCriticalFallback: (error: unknown, options?: { fallback?: ObserveResult }) => ObserveResult;
  collectAllData: (result: ObserveResult, request: ObservationCollectionRequest) => Promise<void>;
}

export class SingleDisplayCaptureStage {
  constructor(private readonly d: SingleDisplayCaptureStageDependencies) {}

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
    return this.d.collectAllData(result, {
      queryOptions,
      perf,
      skipWaitForFresh,
      minTimestamp,
      signal,
      skipBackStack,
      readOnly: observerMode || preserveDisplayState || options?.skipRecompositionTracking === true,
      capturedHierarchy,
      readOptions:
        this.d.device().platform === "android" && options?.requireFreshExtraction
          ? { timeoutMs: options.timeoutMs, requireFreshExtraction: options.requireFreshExtraction }
          : options?.timeoutMs,
      displayId: requestedDisplayId ?? observedAndroid?.logicalId ?? 0,
    });
  }
  resolveSingleDisplayIntent(
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
      ? new ObservedAndroidDisplayCache(this.d.timer(), true)
      : this.d.observedAndroidDisplayCache();
  }

  private defaultDisplayRequest(): string | undefined {
    return this.d.requestedDisplay() === "all" ? undefined : this.d.requestedDisplay();
  }

  private startIosLockStateProbe(
    signal: AbortSignal | undefined,
  ): SingleDisplayIntent["iosLockState"] {
    return this.d.device().platform === "ios" &&
      resolveIosDeviceKind({ deviceId: this.d.device().deviceId }) === "simulator"
      ? this.d.iosLockStateProbe().read(this.d.device().deviceId, signal)
      : undefined;
  }

  /** Stage 0: resolve the targeted display and pin the capture-start fences. */
  async beginSingleDisplay(intent: SingleDisplayIntent): Promise<SingleDisplayRun> {
    const { perf, skipWaitForFresh, minTimestamp, signal, preserveDisplayState } = intent;
    logger.debug(
      `Executing observe command (skipWaitForFresh=${skipWaitForFresh}, minTimestamp=${minTimestamp})`,
    );
    const startTime = this.d.timer().now();
    throwIfAborted(signal);

    const result = this.d.createBaseResult();
    const captureStart = {
      revision: displayTransitions.revision(this.d.device().deviceId),
      identityRevision: displayTransitions.identityRevision(this.d.device().deviceId),
    };
    const targetBinding = this.d.displayBinding().resolveTarget({
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
    const cacheGeneration = getObserveCacheStore().currentGeneration(this.d.device().deviceId);

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
  async failSingleDisplay(err: unknown, intent: SingleDisplayIntent): Promise<ObserveResult> {
    const { preserveDisplayState, observerMode, displayRequest, signal, iosLockState } = intent;
    if (preserveDisplayState) {
      signal?.throwIfAborted();
      if (!observerMode && (displayRequest === undefined || displayRequest === "active")) {
        logger.error("Critical error in aggregate active observation:", err);
        return this.d.createCriticalFallback(err);
      }
    }
    if (observerMode || preserveDisplayState) {
      throw toActionableError(err, `Unable to observe device ${this.d.device().deviceId}`);
    }
    if (
      shouldPropagateCaptureError(this.d.device().platform, err, {
        display: displayRequest,
        signal,
      })
    ) {
      throw displayPinFailure(err);
    }
    const errorMessage = err instanceof Error ? err.stack || err.message : String(err);
    logger.error(`Critical error in observe command: ${errorMessage}`);
    ScreenshotJobTracker.cancelJob(this.d.device().deviceId);
    getScreenshotStateStore().update(
      this.d.device().deviceId,
      undefined,
      `Observation failed: ${errorMessage}`,
    );
    const fallback = this.d.createBaseResult();
    if (iosLockState) {
      applyIosLockStateReading(fallback, await iosLockState);
    }
    return this.d.createCriticalFallback(err, { fallback });
  }

  /** Stage 1: start the foreground probe and capture the hierarchy and its derived device state. */
  async captureSingleDisplay(run: SingleDisplayRun): Promise<SingleDisplayCaptured> {
    const { options, result, perf, queryOptions, skipWaitForFresh, minTimestamp, signal } = run;
    const foregroundSnapshot = this.startForegroundProbe(run);
    const foregroundIdentity: Promise<string | undefined> = foregroundSnapshot.then(
      (sample) => sample?.packageName,
    );
    const capturedHierarchy = await this.captureRequestedHierarchy(run);

    if (options?.hierarchyOnly) {
      // Commit verification reuses the same hierarchy/focus extraction, then
      // returns before device-state reads, cache writes, predictions or audits.
      await this.d.hierarchyCollector().collect(result, {
        queryOptions,
        perf,
        skipWaitForFresh,
        minTimestamp,
        signal,
        readOnly: true,
        capturedHierarchy,
        readOptions: options.timeoutMs,
      });
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
      this.d.device().platform === "android" &&
      (!observerMode || routedAggregateSecondary)
      ? this.d.deviceStateCollector().collectForegroundSnapshot(signal, {
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
      return await captureObserverHierarchy(this.d.hierarchyCapture(), captureRequest);
    }
    if (requestedDisplayId !== undefined) {
      return await captureSelectedDisplayHierarchy(
        {
          selectedDisplayRead: this.d.selectedDisplayRead(),
          timer: this.d.timer(),
          hierarchyCapture: this.d.hierarchyCapture(),
          deviceId: this.d.device().deviceId,
        },
        {
          request: captureRequest,
          panelKey: requestedPanel?.key,
          captureStart,
        },
      );
    }
    if (
      (options?.freshness || options?.hierarchyOnly) &&
      !(this.d.device().platform === "android" && options.requireFreshExtraction)
    ) {
      try {
        const captured = await this.d.hierarchyCapture().capture(captureRequest);
        return captured.hierarchy;
      } catch (error) {
        // A failed pre-capture can be retried and reported by the hierarchy collector.
        logger.warn(`[ObserveScreen] Freshness capture failed; collecting hierarchy: ${error}`);
      }
    }
    return undefined;
  }
}

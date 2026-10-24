import { applyIosLockStateReading } from "./ios/IosLockStateProbe";
import { WindowIdentityFreshnessResolver } from "./WindowIdentityFreshness";
import { HierarchyCaptureRequest } from "./HierarchyCapture";
import { BootedDevice, ObserveResult } from "../../models";
import {
  describeHierarchyUnavailability,
  SingleDisplayReconciliationContext,
  shouldCacheSingleDisplay,
  SingleDisplayCaptured,
  SingleDisplayReconciled,
  SingleDisplayRun,
} from "./singleDisplayRun";
import { Timer } from "../../utils/SystemTimer";
import { getObserveCacheStore } from "./cache/ObserveCacheRegistry";
import { PlatformObservationTraits } from "./collectors/PlatformObservationTraits";
import type { DeviceStateCollectorPort } from "./collectors/collectorPorts";
import { computeFreshness, recordWrongWindowEvidence } from "./observationFreshness";
import { displayTransitions } from "./DisplayTransition";
import {
  describeIncompleteCapture,
  isEmptyFocusedWindow,
  resolveMissingForegroundWindow,
} from "./observationVerdict";

/** Stage 4 of one single-display observation: compute the freshness verdict, settle display provenance and cache the result. */
export interface SingleDisplaySettleStageDependencies {
  device: () => BootedDevice;
  timer: () => Timer;
  windowIdentity: () => WindowIdentityFreshnessResolver;
  deviceStateCollector: () => DeviceStateCollectorPort;
  platformTraits: () => PlatformObservationTraits;
  identifyCapture: (result: ObserveResult, freshness: HierarchyCaptureRequest["freshness"]) => void;
  resolveObservationTimestampMs: (result: ObserveResult) => number | undefined;
}

export class SingleDisplaySettleStage {
  constructor(private readonly d: SingleDisplaySettleStageDependencies) {}

  private recordSingleDisplayTransition(context: SingleDisplayReconciliationContext) {
    const { result, observerMode, preserveDisplayState, explicitlyRouted, recordProvenance } =
      context;
    return (
      !observerMode &&
      !preserveDisplayState &&
      !explicitlyRouted &&
      displayTransitions.record(
        this.d.device().deviceId,
        result,
        this.d.platformTraits().isIosMultiPanel() ? "ios" : "android",
        recordProvenance,
      )
    );
  }

  private reconcileSingleDisplayFreshness(context: SingleDisplayReconciliationContext) {
    const { result, recordProvenance } = context;

    const staleDisplay =
      displayTransitions.revision(this.d.device().deviceId) !== recordProvenance.revision;
    const geometryTransition = this.recordSingleDisplayTransition(context);
    // Stale coordinates retain this observation's reconciled provenance, never a later push's fence.
    result.display.generation = staleDisplay
      ? recordProvenance.identityRevision
      : displayTransitions.identityRevision(this.d.device().deviceId);
    result.displayRevision = staleDisplay
      ? recordProvenance.revision
      : displayTransitions.revision(this.d.device().deviceId);
    return { staleDisplay, geometryTransition };
  }
  /** Stage 4: compute the freshness verdict, settle display provenance and cache the result. */
  async settleSingleDisplay(
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
      ? getObserveCacheStore().currentGeneration(this.d.device().deviceId)
      : run.cacheGeneration;
    if (
      this.d.device().platform === "android" &&
      (geometryTransition ||
        displayTransitions.revision(this.d.device().deviceId) !== run.captureStart.revision)
    ) {
      await this.resampleDeviceLock(result, signal);
    }
    this.d.identifyCapture(result, options?.freshness ?? "cached-ok");
    if (run.iosLockState) {
      applyIosLockStateReading(result, await run.iosLockState);
    }

    // Polls defer their cache write until ObservePoll selects the returned result.
    if (!staleDisplay && shouldCacheSingleDisplay(run)) {
      await perf.track("cacheResult", () =>
        getObserveCacheStore().put(this.d.device().deviceId, result, cacheGeneration),
      );
    }
  }

  private async resampleDeviceLock(result: ObserveResult, signal: AbortSignal | undefined) {
    // The ordinary lock sample may precede a fold discovered by the final hierarchy.
    delete result.deviceLock;
    delete result.deviceLockUnknown;
    await this.d.deviceStateCollector().collectDeviceLock(result, signal);
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
    const statusBarOnlyHierarchy = await this.d
      .windowIdentity()
      .resolveStatusBarOnlyHierarchy(result, foregroundIdentity, postCaptureForeground, signal);
    await this.d
      .windowIdentity()
      .attributeFocusedOwnWindowToForeground(result, foregroundIdentity, minTimestamp);
    const windowIdentityMismatch = await this.d
      .windowIdentity()
      .resolveWindowIdentityMismatch(
        result,
        foregroundIdentity,
        postCaptureForeground,
        getConfirmedFrameworkErrorDialog,
        minTimestamp,
        signal,
      );
    result.freshness = computeFreshness({
      requestedAfter: minTimestamp > 0 ? minTimestamp : undefined,
      actualTimestamp: this.d.resolveObservationTimestampMs(result),
      hostAgeBasisMs: this.d.windowIdentity().resolveHostReceivedAtMs(result),
      now: this.d.timer().now(),
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
      emptyFocusedWindow: this.d.device().platform === "android" && isEmptyFocusedWindow(result),
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
        ? await this.d
            .windowIdentity()
            .confirmForegroundIdentity(reconciled.postCaptureForeground, run.signal)
        : undefined,
      incomplete ? await reconciled.getConfirmedFrameworkErrorDialog() : false,
    );
  }
}

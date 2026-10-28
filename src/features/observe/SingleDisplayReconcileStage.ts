import { WindowIdentityFreshnessResolver } from "./WindowIdentityFreshness";
import { PostCaptureForegroundIdentity } from "./ActiveWindowAttribution";
import { DEFAULT_HIERARCHY_READ_TIMEOUT_MS } from "./DeviceHierarchyCapture";
import {
  BootedDevice,
  ObserveResult,
  requireAndroidOrIosPlatform,
  ViewHierarchyResult,
} from "../../models";
import {
  isMultiDisplayPrimarySample,
  SingleDisplayCaptured,
  SingleDisplayReconciled,
  SingleDisplayRun,
} from "./singleDisplayRun";
import { StaleHierarchyRecovery } from "./StaleHierarchyRecovery";
import { Timer } from "../../utils/SystemTimer";
import {
  DisplayBindingCollector,
  DisplayRecordProvenance,
} from "./collectors/DisplayBindingCollector";
import { enforceHierarchyPlatform, HierarchyPlatformValidator } from "./HierarchyPlatformValidator";

/** Stage 2 of one single-display observation: reconcile window and activity attribution and bind the final display. */
export interface SingleDisplayReconcileStageDependencies {
  device: () => BootedDevice;
  timer: () => Timer;
  windowIdentity: () => WindowIdentityFreshnessResolver;
  staleRecovery: () => StaleHierarchyRecovery;
  displayBinding: () => DisplayBindingCollector;
  platformValidator: () => HierarchyPlatformValidator;
  reconcileActiveWindowAttribution: (
    result: ObserveResult,
    options?: { signal?: AbortSignal; readOnly?: boolean },
  ) => Promise<PostCaptureForegroundIdentity>;
  isConfirmedFrameworkErrorDialog: (
    viewHierarchy: ViewHierarchyResult | undefined,
    signal?: AbortSignal,
  ) => Promise<boolean>;
}

export class SingleDisplayReconcileStage {
  constructor(private readonly d: SingleDisplayReconcileStageDependencies) {}

  /** Stage 2: reconcile window and activity attribution and bind the final display. */
  async reconcileSingleDisplay(
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
      confirmedFrameworkErrorDialog ??= this.d.isConfirmedFrameworkErrorDialog(
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
      requireAndroidOrIosPlatform(this.d.device().platform, "Observing the view hierarchy"),
      this.d.device().deviceId,
      this.d.platformValidator(),
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
    const initialMismatch = await this.d
      .windowIdentity()
      .resolveWindowIdentityMismatch(
        result,
        captured.foregroundIdentity,
        { sampled: false, identity: undefined, activityAttributionMismatch: false },
        getConfirmedFrameworkErrorDialog,
        minTimestamp,
        signal,
      );
    const remainingMs = Math.min(
      500,
      (options?.timeoutMs ?? DEFAULT_HIERARCHY_READ_TIMEOUT_MS) -
        (this.d.timer().now() - startTime),
    );
    if (!initialMismatch || remainingMs <= 0) {
      return false;
    }
    await this.d
      .staleRecovery()
      .refreshKnownStaleHierarchy(result, initialMismatch.foreground, options, remainingMs, {
        skipBackStack,
        displayId: run.requestedDisplayId ?? run.observedAndroid?.logicalId ?? 0,
      });
    return true;
  }

  private shouldRecoverWrongWindow(run: SingleDisplayRun): boolean {
    const { options, observerMode, preserveDisplayState, explicitlyRouted } = run;
    return (
      this.d.device().platform === "android" &&
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
    return await this.d.reconcileActiveWindowAttribution(result, {
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
    await this.d.staleRecovery().verifyCachedAndroidHierarchy(result, {
      signal,
      remainingMs: Math.min(
        500,
        (options.timeoutMs ?? DEFAULT_HIERARCHY_READ_TIMEOUT_MS) -
          (this.d.timer().now() - startTime),
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
    const finalBinding = this.d.displayBinding().bindFinalDisplay({
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
    const panels = this.d.device().displays?.panels;
    if (panels && panels.length > 1) {
      result.otherDisplays = panels
        .filter((panel) => panel.key !== result.display.key)
        .map((panel) => ({ key: panel.key, role: panel.role, size: panel.sizePx }));
    }
  }
}

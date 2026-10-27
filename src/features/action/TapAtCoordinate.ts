import { androidCtrlProxyClientForPlatform } from "../observe/android/androidCtrlProxyClientFor";
import { AndroidCoordinateTalkBack } from "./AndroidCoordinateTalkBack";
import { AndroidCoordinateTapDispatcher } from "./AndroidCoordinateTapDispatcher";
import type { TapAtPlanContext } from "../../models/TapAtGeometry";
import type { AccessibilityDetector } from "../../ctrlProxy/accessibility/interfaces/AccessibilityDetector";
import { accessibilityDetector as defaultAccessibilityDetector } from "../../ctrlProxy/accessibility/AccessibilityDetector";
import { FeatureFlagService, type FeatureFlagReader } from "../featureFlags/FeatureFlagService";
import { TalkBackTapStrategy } from "../talkback/TalkBackTapStrategy";
import { talkBackDisplayRefusal } from "../talkback/talkBackDisplayRefusal";
import {
  DefaultTalkBackNavigationDriverFactory,
  type TalkBackNavigationDriverFactory,
} from "../talkback/TalkBackNavigationDriver";
import { DispatchedObservationError } from "../../models/DispatchedObservationError";
import {
  resolveCoordinateTapCtrlProxyTimeoutMs,
  resolveGestureCtrlProxyTimeoutMs,
} from "./gestureTransportTimeout";
import { ActionableError, unsupportedPlatformError } from "../../models/ActionableError";
import {
  BootedDevice,
  ObserveResult,
  TapAtOptions,
  TapAtResult,
  toActionableError,
} from "../../models";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { createGlobalPerformanceTracker } from "../../utils/PerformanceTracker";
import type { Timer } from "../../utils/SystemTimer";
import { throwIfAborted } from "../../utils/toolUtils";
import { IOSCtrlProxyClient } from "../observe/ios";
import { withStaleDisplay } from "../observe/StaleDisplayError";
import { isAdoptableCapture } from "../observe/isAdoptableCapture";
import {
  hasSameTapTargetingLayout,
  snapshotReferences,
  type SnapshotReferenceStore,
} from "../observe/SnapshotReferenceStore";
import { prepareTargetDisplayAction, type RenderedObservationReader } from "./TargetDisplayAction";
import { executeTouchscreenInput, supportsCtrlProxyGestureDisplay } from "./touchscreenInput";
import {
  BaseVisualChange,
  type DisplayFenceDependencies,
  type ProgressCallback,
} from "./BaseVisualChange";
import {
  type CoordinateTapClient,
  type IosCoordinateTapClient,
  dispatchAndroidCoordinateTap,
  dispatchIosCoordinateTap,
  dispatchIosDoubleTap,
  isStaleFrameContextRejection,
  indeterminateTapError,
} from "./coordinateTapDispatch";
import { dispatchAndroidDoubleTap } from "./androidDoubleTap";

import { tapDurationMs, LONG_PRESS_MIN_MS } from "./tapAtGesture";
import { resolveTapAtCall, type TapAtCall } from "./ActionCall";
import { collectWarnings, partialDoubleTapNote } from "./tapSharedHelpers";
import { dispatchStylusTap, refusedTap, stylusTapRefusal } from "./stylusPointer";
import { TapAtGeometryError } from "./TapAtGeometryError";
import {
  failurePoint,
  inputPoint,
  resolveCoordinates,
  resolveTapAtCoordinates,
} from "./tapAtCoordinateResolution";

export { resolveTapAtCoordinates };

type AndroidCoordinateTapDispatch = typeof dispatchAndroidCoordinateTap;
type IosCoordinateTapDispatch = typeof dispatchIosCoordinateTap;

export interface TapAtCoordinateDependencies extends DisplayFenceDependencies {
  timer?: Timer;
  featureFlags?: FeatureFlagReader;
  accessibilityDetector?: AccessibilityDetector;
  talkBackStrategy?: Pick<TalkBackTapStrategy, "executePreciseTap" | "executeCoordinateFallback">;
  talkBackDriverFactory?: TalkBackNavigationDriverFactory;
  androidClient?: CoordinateTapClient & { supportsCommand?: (name: string) => Promise<boolean> };
  iosClient?: IosCoordinateTapClient;
  dispatchAndroidCoordinateTap?: AndroidCoordinateTapDispatch;
  dispatchIosCoordinateTap?: IosCoordinateTapDispatch;
  dispatchIosDoubleTap?: typeof dispatchIosDoubleTap;
  invalidateIosCache?: () => void;
  lastRenderedObservation?: RenderedObservationReader;
  snapshotReferences?: SnapshotReferenceStore;
}

function resolveTalkBackDependencies(
  dependencies: TapAtCoordinateDependencies,
  timer: Timer,
  defaultDriverFactory: TalkBackNavigationDriverFactory,
) {
  const talkBackDriverFactory = dependencies.talkBackDriverFactory ?? defaultDriverFactory;
  return {
    featureFlags: dependencies.featureFlags ?? FeatureFlagService.getInstance(),
    accessibilityDetector: dependencies.accessibilityDetector ?? defaultAccessibilityDetector,
    talkBackDriverFactory,
    talkBackStrategy:
      dependencies.talkBackStrategy ??
      new TalkBackTapStrategy({ timer, driverFactory: talkBackDriverFactory }),
    useContextualFocusTap: dependencies.talkBackDriverFactory === undefined,
  };
}

/** Tap one absolute point in the native coordinate space reported by observe. */
export class TapAtCoordinate extends BaseVisualChange {
  private readonly androidClient: CoordinateTapClient & {
    supportsCommand?: (name: string) => Promise<boolean>;
  };
  private readonly iosDoubleTap: typeof dispatchIosDoubleTap;
  private readonly iosClient: IosCoordinateTapClient;
  private readonly iosCoordinateTap: IosCoordinateTapDispatch;
  private readonly invalidateIosCache: () => void;
  private readonly lastRenderedObservation?: RenderedObservationReader;
  private readonly snapshotReferences: SnapshotReferenceStore;
  private readonly androidTalkBack: AndroidCoordinateTalkBack;
  private readonly androidDispatcher: AndroidCoordinateTapDispatcher;

  constructor(
    device: BootedDevice,
    adb: AdbExecutor | null = null,
    dependencies: TapAtCoordinateDependencies = {},
  ) {
    super(device, adb, dependencies.timer, dependencies.renderedDisplayRevision, dependencies);
    this.androidClient =
      dependencies.androidClient ?? androidCtrlProxyClientForPlatform(device, this.adbFactory);
    this.iosClient = dependencies.iosClient ?? IOSCtrlProxyClient.getInstance(device);
    this.iosDoubleTap = dependencies.dispatchIosDoubleTap ?? dispatchIosDoubleTap;
    this.iosCoordinateTap = dependencies.dispatchIosCoordinateTap ?? dispatchIosCoordinateTap;
    this.invalidateIosCache =
      dependencies.invalidateIosCache ??
      (() => IOSCtrlProxyClient.getExistingInstance(this.device.deviceId)?.invalidateCache());
    this.lastRenderedObservation = dependencies.lastRenderedObservation;
    this.snapshotReferences = dependencies.snapshotReferences ?? snapshotReferences;
    const talkBack = resolveTalkBackDependencies(
      dependencies,
      this.timer,
      new DefaultTalkBackNavigationDriverFactory(this.adbFactory),
    );
    this.androidTalkBack = new AndroidCoordinateTalkBack({
      target: this,
      androidClient: this.androidClient,
      ...talkBack,
    });
    const target = this;
    this.androidDispatcher = new AndroidCoordinateTapDispatcher({
      host: {
        // Keep the public ADB and observation injection seams live after construction.
        get adb() {
          return target.adb;
        },
        get observeScreen() {
          return target.observeScreen;
        },
        assertDisplayRevisionCurrent: (fence) => this.assertDisplayRevisionCurrent(fence),
        assertSnapshotCurrent: (options, observation) =>
          this.assertSnapshotCurrent(options, observation),
        resolveFreshFrameRetry: (options, point, initial, refreshed) =>
          this.resolveFreshFrameRetry(options, point, initial, refreshed),
        retryFreshness: (options) => this.retryFreshness(options),
      },
      androidClient: this.androidClient,
      androidCoordinateTap:
        dependencies.dispatchAndroidCoordinateTap ?? dispatchAndroidCoordinateTap,
      androidTalkBack: this.androidTalkBack,
      timer: this.timer,
    });
  }

  private async executeOnDisplay(
    options: TapAtOptions,
    display: string,
    onTapDelivered: (talkBack?: boolean) => void,
    signal?: AbortSignal,
    onDispatchCompleted?: () => void,
    onActivationWarnings?: (warnings?: string[]) => void,
  ): Promise<TapAtResult> {
    const action = options.action ?? "tap";
    const { observation, displayId, assertCurrent } = await prepareTargetDisplayAction(
      this.device,
      display,
      this.observeScreen,
      this.adb,
      {
        lastRenderedObservation: this.lastRenderedObservation,
        signal,
        transitions: this.displayTransitionReader,
      },
    );
    const stale = this.staleSnapshotReason(options, observation);
    if (stale) {
      return {
        success: false,
        x: inputPoint(options).x,
        y: inputPoint(options).y,
        action,
        error: stale,
      };
    }
    const resolved = resolveCoordinates(options, observation, this.device.platform);
    if ("error" in resolved) {
      return {
        success: false,
        x: resolved.x,
        y: resolved.y,
        action,
        error: resolved.error,
      };
    }
    return this.observedInteraction(
      async () => {
        assertCurrent();
        const talkBackEnabled =
          this.device.platform === "android" &&
          (await this.androidTalkBack.resolveState(signal, onActivationWarnings));
        if (talkBackEnabled) {
          // The shared TalkBack driver has no display-addressed activation capability.
          const refusal = talkBackDisplayRefusal(displayId);
          if (refusal) {
            throw refusal;
          }
          await this.dispatchDisplayTalkBackTapWithOneFreshRetry(options, resolved, observation, {
            signal,
            assertCurrent,
            onTapDelivered: () => onTapDelivered(true),
            onActivationWarnings,
          });
        } else {
          await this.dispatchGesture(options, resolved, observation, signal, displayId, {
            assertCurrent,
            onTapDelivered,
            onWarning: (warning) => onActivationWarnings?.([warning]),
          });
        }
        onDispatchCompleted?.();
        return { success: true, x: resolved.x, y: resolved.y, action };
      },
      {
        changeExpected: false,
        display: observation.display.key,
        previousObservation: observation,
        signal,
      },
    );
  }

  async execute(options: TapAtOptions, call?: TapAtCall<TapAtPlanContext>): Promise<TapAtResult>;
  /** @deprecated Pass an {@link ActionCall} instead of positional arguments. */
  async execute(
    options: TapAtOptions,
    progress?: ProgressCallback,
    signal?: AbortSignal,
    planContext?: TapAtPlanContext,
  ): Promise<TapAtResult>;
  async execute(
    options: TapAtOptions,
    progressOrCall?: ProgressCallback | TapAtCall<TapAtPlanContext>,
    signalArg?: AbortSignal,
    planContextArg?: TapAtPlanContext,
  ): Promise<TapAtResult> {
    const { progress, signal, planContext } = resolveTapAtCall(
      progressOrCall,
      signalArg,
      planContextArg,
    );
    const error = stylusTapRefusal(this.device.platform, options);
    if (error) {
      return refusedTap(error, inputPoint(options), options.action);
    }
    return this.executeTap(options, progress, signal, planContext);
  }

  private async executeTap(
    options: TapAtOptions,
    progress?: ProgressCallback,
    signal?: AbortSignal,
    planContext?: TapAtPlanContext,
  ): Promise<TapAtResult> {
    options = { ...options, planContext };
    const action = options.action ?? "tap";
    const perf = createGlobalPerformanceTracker();
    perf.serial("tapAt");
    let dispatchedCoordinates: { x: number; y: number } | undefined;
    let iosDispatchTimestamp: number | undefined;
    const delivery = { tapsDelivered: 0, talkBack: false, displayCompleted: false };
    const warnings = new Set<string>();
    const onActivationWarnings = collectWarnings(warnings);
    const onTapDelivered = (talkBack = false) => {
      delivery.talkBack ||= talkBack;
      delivery.tapsDelivered++;
    };
    const transitionRevision = this.captureTransitionRevision();

    try {
      throwIfAborted(signal);
      if (options.display !== undefined) {
        const result = await this.executeOnDisplay(
          options,
          options.display,
          onTapDelivered,
          signal,
          () => {
            delivery.displayCompleted = true;
          },
          onActivationWarnings,
        );
        return { ...result, ...(warnings.size ? { warnings: [...warnings] } : {}) };
      }
      if (
        this.hasStaleCallerRevision(this.displayTransitionReader.revision(this.device.deviceId))
      ) {
        return withStaleDisplay(
          { success: false, x: inputPoint(options).x, y: inputPoint(options).y, action },
          this.staleDisplay(transitionRevision.observedGeneration),
        );
      }
      let preDispatchObservation: ObserveResult | null = null;
      const result = await this.observedInteraction(
        async () => {
          // Validate against the latest available frame immediately before dispatch.
          // Observe defaults to skipWaitForFresh=true, so cache validity matters here.
          const observeResult = await this.observeScreen.execute({
            freshness: "cached-ok",
            signal,
            perf,
          });
          preDispatchObservation = observeResult;
          if (this.currentActionRevision() !== transitionRevision.revision) {
            return withStaleDisplay(
              { success: false, x: inputPoint(options).x, y: inputPoint(options).y, action },
              this.staleDisplay(transitionRevision.observedGeneration),
            );
          }
          const stale = this.staleSnapshotReason(options, observeResult);
          if (stale) {
            return {
              success: false,
              x: inputPoint(options).x,
              y: inputPoint(options).y,
              action,
              error: stale,
            };
          }
          const resolved = resolveCoordinates(options, observeResult, this.device.platform);
          if ("error" in resolved) {
            return {
              success: false,
              x: resolved.x,
              y: resolved.y,
              action,
              error: resolved.error,
            };
          }
          dispatchedCoordinates = resolved;

          this.assertDisplayRevisionCurrent(transitionRevision);
          throwIfAborted(signal);
          switch (this.device.platform) {
            case "android": {
              if (options.pointer) {
                // Stylus goes straight through `input stylus`: no TalkBack routing and no finger fallback.
                await dispatchStylusTap(this.adb, resolved, options, {
                  signal,
                  assertCurrent: () => this.assertDisplayRevisionCurrent(transitionRevision),
                });
                onTapDelivered();
                break;
              }
              const talkBackEnabled = await this.androidTalkBack.resolveState(
                signal,
                onActivationWarnings,
              );
              delivery.talkBack = talkBackEnabled;
              await this.androidDispatcher.dispatchAndroidTaps(
                options,
                resolved,
                observeResult,
                transitionRevision,
                perf,
                { signal, onTapDelivered, talkBackEnabled, onActivationWarnings },
              );
              break;
            }
            case "ios":
              iosDispatchTimestamp = await this.dispatchIosTapsWithOneFreshRetry(
                options,
                resolved,
                observeResult,
                transitionRevision,
                onTapDelivered,
                signal,
              );
              break;
            default:
              throw unsupportedPlatformError(this.device.platform, "tap at coordinates");
          }

          return { success: true, x: resolved.x, y: resolved.y, action };
        },
        {
          changeExpected: false,
          progress,
          perf,
          signal,
          // The pre-dispatch observation above supplies the target and frame
          // context; do not resolve a second cached one first.
          skipPreviousObserve: true,
          observationTimestampProvider: () => iosDispatchTimestamp,
          predictionContext: {
            toolName: "tapAt",
            toolArgs: {
              ...options,
              action,
              platform: this.device.platform,
            },
          },
        },
      );
      // Preserve the initial pre-action evidence, including across a fresh frame retry,
      // just as observedInteraction does for tools with a base pre-observation.
      this.annotateDeviceLock(result, preDispatchObservation);
      return { ...result, ...(warnings.size ? { warnings: [...warnings] } : {}) };
    } catch (error) {
      if (error instanceof TapAtGeometryError) {
        throw error;
      }
      this.rethrowObservationAbort(error, signal, delivery.displayCompleted);
      return this.createDispatchFailure(error, options, dispatchedCoordinates, delivery);
    } finally {
      perf.end();
    }
  }

  private captureTransitionRevision(): { revision: number; observedGeneration: number } {
    return {
      revision: this.currentActionRevision(),
      // With no caller stamp, in-flight fences report the action-start identity generation.
      observedGeneration:
        this.renderedDisplayGeneration(this.device.deviceId) ??
        this.displayTransitionReader.identityRevision(this.device.deviceId),
    };
  }

  private createDispatchFailure(
    error: unknown,
    options: TapAtOptions,
    dispatchedCoordinates: { x: number; y: number } | undefined,
    delivery: { tapsDelivered: number; talkBack: boolean },
  ): TapAtResult {
    const action = options.action ?? "tap";
    const { tapsDelivered, talkBack } = delivery;
    logger.warn(`tapAt dispatch failed: ${errorMessage(error)}`, error);
    const point = dispatchedCoordinates ?? failurePoint(options, this.device.platform);
    const result = withStaleDisplay(
      {
        success: false,
        x: point.x,
        y: point.y,
        error: `Failed to tap at coordinates: ${errorMessage(error)}`,
        action,
      },
      error,
    );
    if (talkBack && action !== "longPress") {
      if (error instanceof DispatchedObservationError && tapsDelivered === 3) {
        result.error += " A TalkBack focus touch and an activation double tap were delivered.";
      }
    } else {
      result.error +=
        error instanceof DispatchedObservationError
          ? ` ${tapsDelivered} ${tapsDelivered === 1 ? "tap was" : "taps were"} delivered.`
          : partialDoubleTapNote(action, tapsDelivered);
    }
    return result;
  }

  /**
   * The pre-dispatch observation may be a cached frame the runner has already moved past (a
   * gesture such as pinchOn advances it without the daemon seeing a new frame, #13437). A runner
   * stale-frame rejection proves nothing was dispatched, so observe a genuinely fresh frame and
   * retry once when the tap target is unchanged. A second rejection surfaces to the caller.
   */
  private async dispatchIosTapsWithOneFreshRetry(
    options: TapAtOptions,
    point: { x: number; y: number },
    observation: ObserveResult,
    transitionRevision: { revision: number; observedGeneration: number },
    onTapDelivered: () => void,
    signal?: AbortSignal,
  ): Promise<number> {
    const frameContext = observation.viewHierarchy?.frameContext;
    try {
      return await this.dispatchIosTaps(
        options,
        point,
        frameContext,
        transitionRevision,
        onTapDelivered,
        signal,
      );
    } catch (error) {
      throwIfAborted(signal);
      const actionable = toActionableError(error, "Failed to dispatch iOS coordinate tap");
      if (frameContext === undefined || !isStaleFrameContextRejection(actionable.message)) {
        throw actionable;
      }
      const refreshed = await this.observeScreen.execute({ freshness: "fresh", signal });
      this.assertDisplayRevisionCurrent(transitionRevision);
      this.assertSnapshotCurrent(options, refreshed);
      const retry = this.resolveFreshFrameRetry(options, point, observation, refreshed);
      if (!retry || !isAdoptableCapture(observation, refreshed, true)) {
        throw actionable;
      }
      // No loop: a second stale rejection surfaces to the caller.
      return await this.dispatchIosTaps(
        options,
        retry.point,
        retry.frameContext,
        transitionRevision,
        onTapDelivered,
        signal,
      );
    }
  }

  private async dispatchIosTaps(
    options: TapAtOptions,
    point: { x: number; y: number },
    frameContext: string | undefined,
    transitionRevision: { revision: number; observedGeneration: number },
    onTapDelivered: () => void,
    signal?: AbortSignal,
  ): Promise<number> {
    this.assertDisplayRevisionCurrent(transitionRevision);
    const dispatch = options.action === "doubleTap" ? this.iosDoubleTap : this.iosCoordinateTap;
    await dispatch(this.iosClient, point.x, point.y, tapDurationMs(options, "ios"), frameContext, {
      signal,
    });
    try {
      onTapDelivered();
      if (options.action === "doubleTap") {
        onTapDelivered();
      }
      throwIfAborted(signal);
      return this.timer.now();
    } finally {
      this.invalidateIosCacheSafely();
    }
  }

  private invalidateIosCacheSafely(): void {
    try {
      this.invalidateIosCache();
    } catch (error) {
      logger.warn(`tapAt iOS cache invalidation failed: ${errorMessage(error)}`, error);
    }
  }

  private async dispatchDisplayTalkBackTapWithOneFreshRetry(
    options: TapAtOptions,
    resolved: { x: number; y: number },
    observation: ObserveResult,
    context: {
      signal?: AbortSignal;
      assertCurrent: () => void;
      onTapDelivered: () => void;
      onActivationWarnings?: (warnings?: string[]) => void;
    },
  ): Promise<void> {
    const { signal, assertCurrent } = context;
    const frameContext = observation.viewHierarchy?.frameContext;
    let delivered = false;
    let talkBackDispatched = false;
    const dispatchContext = {
      assertCurrent,
      onTapDelivered: () => {
        delivered = true;
        context.onTapDelivered();
      },
      onDispatched: () => {
        talkBackDispatched = true;
      },
      onActivationWarnings: context.onActivationWarnings,
    };
    try {
      await this.androidTalkBack.dispatchTap(
        options,
        resolved,
        frameContext,
        signal,
        dispatchContext,
      );
    } catch (error) {
      throwIfAborted(signal);
      const actionable = toActionableError(error, "Failed to dispatch Android coordinate tap");
      if (
        delivered ||
        talkBackDispatched ||
        frameContext === undefined ||
        !isStaleFrameContextRejection(actionable.message)
      ) {
        throw actionable;
      }

      // Pin the prepared panel instead of resolving an active-display alias again.
      const refreshedObservation = await this.observeScreen.execute({
        display: observation.display.key,
        freshness: this.retryFreshness(options),
        signal,
      });
      assertCurrent();
      this.assertSnapshotCurrent(options, refreshedObservation);
      const retry = this.resolveFreshFrameRetry(
        options,
        resolved,
        observation,
        refreshedObservation,
      );
      if (refreshedObservation.display.key !== observation.display.key || !retry) {
        throw actionable;
      }
      // No loop: a second stale rejection surfaces to the caller.
      await this.androidTalkBack.dispatchTap(
        options,
        retry.point,
        retry.frameContext,
        signal,
        dispatchContext,
      );
    }
  }

  private resolveFreshFrameRetry(
    options: TapAtOptions,
    point: { x: number; y: number },
    initial: ObserveResult,
    refreshed: ObserveResult,
  ): { point: { x: number; y: number }; frameContext: string } | undefined {
    const resolved = resolveCoordinates(options, refreshed, this.device.platform);
    const frameContext = refreshed.viewHierarchy?.frameContext;
    if (
      "error" in resolved ||
      resolved.x !== point.x ||
      resolved.y !== point.y ||
      !frameContext ||
      // iOS tokens identify semantic state, not captures. A genuinely fresh capture can
      // repeat the rejected token after transient post-gesture UI settles (#13437).
      (this.device.platform !== "ios" && frameContext === initial.viewHierarchy?.frameContext)
    ) {
      return undefined;
    }
    if (!options.snapshotId && !hasSameTapTargetingLayout(initial, refreshed)) {
      throw new ActionableError(
        "Stale frame context: screen layout changed since the last observation. Observe again and recompute coordinates, or pass a fresh snapshotId.",
      );
    }
    return { point: resolved, frameContext };
  }

  private assertDisplayRevisionCurrent(fence: {
    revision: number;
    observedGeneration: number;
  }): void {
    if (this.currentActionRevision() !== fence.revision) {
      throw this.staleDisplay(fence.observedGeneration);
    }
  }

  private currentActionRevision(): number {
    return this.device.platform === "ios"
      ? this.displayTransitionReader.identityRevision(this.device.deviceId)
      : this.displayTransitionReader.revision(this.device.deviceId);
  }

  private staleSnapshotReason(
    options: TapAtOptions,
    observation: ObserveResult,
  ): string | undefined {
    return options.snapshotId
      ? this.snapshotReferences.staleReason(options.snapshotId, this.device.deviceId, observation)
      : undefined;
  }

  private assertSnapshotCurrent(options: TapAtOptions, observation: ObserveResult): void {
    const stale = this.staleSnapshotReason(options, observation);
    if (stale) {
      throw new ActionableError(stale);
    }
  }

  private retryFreshness(options: TapAtOptions): "fresh" | "cached-ok" {
    return options.snapshotId ? "fresh" : "cached-ok";
  }

  private hasStaleCallerRevision(revision: number): boolean {
    const callerRevision = this.renderedDisplayRevision(this.device.deviceId);
    if (callerRevision === undefined) {
      return false;
    }
    return this.device.platform === "ios"
      ? !this.displayTransitionReader.sameIdentitySince(this.device.deviceId, callerRevision)
      : callerRevision !== revision;
  }

  private async dispatchAndroidDisplayGesture(
    point: { x: number; y: number },
    duration: number,
    command: string,
    displayId: number | undefined,
    signal: AbortSignal | undefined,
    context: { assertCurrent: () => void; onTapDelivered: () => void },
  ): Promise<void> {
    if (await supportsCtrlProxyGestureDisplay(this.androidClient, displayId)) {
      throwIfAborted(signal);
      context.assertCurrent();
      let dispatched = false;
      const onDispatch = () => {
        dispatched = true;
      };
      const result = await this.androidClient.requestTapCoordinates({
        x: point.x,
        y: point.y,
        duration,
        timeoutMs: resolveCoordinateTapCtrlProxyTimeoutMs(duration),
        onDispatch,
        signal,
        displayId: displayId === 0 ? undefined : displayId,
        beforeSend: context.assertCurrent,
      });
      if (result.success) {
        context.onTapDelivered();
      }
      throwIfAborted(signal);
      if (result.success) {
        return;
      }
      if (dispatched) {
        throw indeterminateTapError(result.error);
      }
      if (isStaleFrameContextRejection(result.error)) {
        throw new ActionableError(result.error ?? "Stale frame context");
      }
      logger.warn(
        `[TapAtCoordinate] dispatchGesture tap failed (${result.error}), falling back to ADB input`,
      );
    }
    throwIfAborted(signal);
    context.assertCurrent();
    await executeTouchscreenInput(this.adb, command, displayId, signal, context.assertCurrent, {
      timeoutMs:
        duration >= LONG_PRESS_MIN_MS ? resolveGestureCtrlProxyTimeoutMs(duration) : undefined,
    });
    context.onTapDelivered();
    throwIfAborted(signal);
  }

  private async dispatchGesture(
    options: TapAtOptions,
    point: { x: number; y: number },
    observation: ObserveResult,
    signal: AbortSignal | undefined,
    displayId: number | undefined,
    context: {
      assertCurrent: () => void;
      onTapDelivered: () => void;
      onWarning?: (warning: string) => void;
    },
  ): Promise<void> {
    const action = options.action ?? "tap";
    const duration = tapDurationMs(options, this.device.platform);
    const dispatch = async () => {
      throwIfAborted(signal);
      context.assertCurrent();
      if (this.device.platform === "android") {
        const command =
          action === "longPress"
            ? `swipe ${point.x} ${point.y} ${point.x} ${point.y} ${duration}`
            : `tap ${point.x} ${point.y}`;
        await this.dispatchAndroidDisplayGesture(
          point,
          duration,
          command,
          displayId,
          signal,
          context,
        );
      } else if (this.device.platform === "ios") {
        await (action === "doubleTap" ? this.iosDoubleTap : this.iosCoordinateTap)(
          this.iosClient,
          point.x,
          point.y,
          duration,
          observation.viewHierarchy?.frameContext,
          { signal },
        );
        context.onTapDelivered();
        if (action === "doubleTap") {
          context.onTapDelivered();
        }
      } else {
        throw unsupportedPlatformError(this.device.platform, "tapAt gesture");
      }
    };
    if (this.device.platform === "android" && action === "doubleTap") {
      await dispatchAndroidDoubleTap({
        // A non-default panel must be routable before one gesture may target it.
        client: (await supportsCtrlProxyGestureDisplay(this.androidClient, displayId))
          ? this.androidClient
          : undefined,
        point,
        displayId: displayId === 0 ? undefined : displayId,
        timer: this.timer,
        signal,
        assertCurrent: context.assertCurrent,
        onTapDelivered: context.onTapDelivered,
        onWarning: context.onWarning,
        tap: () => dispatch(),
      });
      return;
    }
    await dispatch();
    if (this.device.platform === "ios") {
      try {
        throwIfAborted(signal);
      } finally {
        this.invalidateIosCacheSafely();
      }
      return;
    }
  }
}

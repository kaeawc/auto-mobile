import { rejectTvosTouch } from "../tvos/TvosActions";
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
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { throwIfAborted } from "../../utils/toolUtils";
import { IOSCtrlProxyClient } from "../observe/ios";
import type {
  IosVoiceOverDetector,
  VoiceOverStateClient,
} from "../accessibility/interfaces/IosVoiceOverDetector";
import { iosVoiceOverDetector as defaultIosVoiceOverDetector } from "../accessibility/IosVoiceOverDetector";
import { withVoiceOverTimeoutContextIfOn } from "./tapIosVoiceOver";
import { withStaleDisplay } from "../observe/StaleDisplayError";
import {
  describeTransposedLayout,
  staleGeometryTapError,
} from "../observe/transposedLayoutGeometry";
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
import {
  StylusOutcomeIndeterminateError,
  dispatchStylusTap,
  refusedTap,
  stylusTapRefusal,
} from "./stylusPointer";
import { LONG_PRESS_DEFAULT_MS } from "./tapAtGesture";
import {
  dispatchRichStylus,
  pointerNeedsInstrumentation,
  strokeRequest,
  tapStrokePoints,
  type RichStylusOptions,
} from "./pointer/richStylus";
import { TapAtGeometryError } from "./TapAtGeometryError";
import {
  isAndroidXr,
  type AndroidXrDetector,
} from "../../utils/android-cmdline-tools/androidXrDevice";
import {
  failurePoint,
  inputPoint,
  resolveCoordinates,
  resolveTapAtCoordinates,
} from "./tapAtCoordinateResolution";

export { resolveTapAtCoordinates };

type AndroidCoordinateTapDispatch = typeof dispatchAndroidCoordinateTap;
// Existing injected dispatchers may omit metadata.
type IosCoordinateTapDispatch = (
  ...args: Parameters<typeof dispatchIosCoordinateTap>
) => Promise<{ route?: string } | void>;
type IosDoubleTapDispatch = (
  ...args: Parameters<typeof dispatchIosDoubleTap>
) => Promise<{ route?: string } | void>;

/** Delivery hooks for a tap on an explicitly named display. */
interface DisplayTapCall {
  onTapDelivered: (talkBack?: boolean) => void;
  signal?: AbortSignal;
  onDispatchCompleted?: () => void;
  onActivationWarnings?: (warnings?: string[]) => void;
}

/** The display revision an iOS tap is fenced to and its delivery hook. */
interface IosTapDispatchContext {
  transitionRevision: { revision: number; observedGeneration: number };
  onTapDelivered: () => void;
  signal?: AbortSignal;
}

/** The target panel, cancellation and fence for one display-addressed coordinate gesture. */
interface DisplayGestureContext {
  displayId: number | undefined;
  signal: AbortSignal | undefined;
  assertCurrent: () => void;
  onTapDelivered: () => void;
}

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
  dispatchIosDoubleTap?: IosDoubleTapDispatch;
  invalidateIosCache?: () => void;
  /** Read only after an iOS tap times out, to add VoiceOver guidance (#17626). */
  iosVoiceOverDetector?: Pick<IosVoiceOverDetector, "isVoiceOverEnabled">;
  iosVoiceOverStateClient?: VoiceOverStateClient;
  lastRenderedObservation?: RenderedObservationReader;
  snapshotReferences?: SnapshotReferenceStore;
  /** Stylus routes and device facts; the defaults use instrumentation or root-only uinput and live device facts. */
  stylus?: Pick<RichStylusOptions, "injectors" | "readEnvironment">;
  /** The shared XR predicate; tests inject a fake so no `pm has-feature` probe runs. */
  xrDetector?: AndroidXrDetector;
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

/** The runner may still be busy with the timed-out press; the state is usually cached. */
const TAP_AT_VOICEOVER_PROBE_TIMEOUT_MS = 1000;

/** iOS VoiceOver state for timeout guidance; only a confirmed-on probe counts. */
function iosVoiceOverProbe(
  device: BootedDevice,
  {
    detector,
    stateClient,
    featureFlags,
    timer,
  }: {
    detector: Pick<IosVoiceOverDetector, "isVoiceOverEnabled">;
    stateClient: () => VoiceOverStateClient;
    featureFlags: FeatureFlagReader;
    timer: Timer;
  },
): () => Promise<boolean> {
  return () => {
    // The request timeout starts only after a reconnect, so bound the whole probe here.
    const controller = new AbortController();
    return raceWithDeadline(
      () =>
        detector.isVoiceOverEnabled(device.deviceId, stateClient(), {
          featureFlags,
          timeoutMs: TAP_AT_VOICEOVER_PROBE_TIMEOUT_MS,
          signal: controller.signal,
        }),
      {
        timer,
        timeoutMs: TAP_AT_VOICEOVER_PROBE_TIMEOUT_MS,
        label: "tapAt VoiceOver probe",
        onTimeout: () => controller.abort(),
      },
    );
  };
}

/** Tap one absolute point in the native coordinate space reported by observe. */
export class TapAtCoordinate extends BaseVisualChange {
  private readonly androidClient: CoordinateTapClient & {
    supportsCommand?: (name: string) => Promise<boolean>;
  };
  private readonly iosDoubleTap: IosDoubleTapDispatch;
  private readonly iosClient: IosCoordinateTapClient;
  private readonly iosCoordinateTap: IosCoordinateTapDispatch;
  private readonly invalidateIosCache: () => void;
  private readonly isIosVoiceOverOn: () => Promise<boolean>;
  private readonly lastRenderedObservation?: RenderedObservationReader;
  private readonly stylusRoutes: Pick<RichStylusOptions, "injectors" | "readEnvironment">;
  private readonly snapshotReferences: SnapshotReferenceStore;
  private readonly androidTalkBack: AndroidCoordinateTalkBack;
  private readonly androidDispatcher: AndroidCoordinateTapDispatcher;
  private readonly xrDetector?: AndroidXrDetector;
  private androidXr?: boolean;

  constructor(
    device: BootedDevice,
    adb: AdbExecutor | null = null,
    dependencies: TapAtCoordinateDependencies = {},
  ) {
    super(device, {
      adb,
      timer: dependencies.timer,
      displayFence: dependencies,
    });
    rejectTvosTouch(device.platform, "tapAt");
    this.androidClient =
      dependencies.androidClient ?? androidCtrlProxyClientForPlatform(device, this.adbFactory);
    const liveIosClient = () => IOSCtrlProxyClient.getInstance(device);
    this.iosClient = dependencies.iosClient ?? liveIosClient();
    this.iosDoubleTap = dependencies.dispatchIosDoubleTap ?? dispatchIosDoubleTap;
    this.iosCoordinateTap = dependencies.dispatchIosCoordinateTap ?? dispatchIosCoordinateTap;
    this.invalidateIosCache =
      dependencies.invalidateIosCache ??
      (() => IOSCtrlProxyClient.getExistingInstance(this.device.deviceId)?.invalidateCache());
    this.lastRenderedObservation = dependencies.lastRenderedObservation;
    this.stylusRoutes = dependencies.stylus ?? {};
    this.snapshotReferences = dependencies.snapshotReferences ?? snapshotReferences;
    this.xrDetector = dependencies.xrDetector;
    const talkBack = resolveTalkBackDependencies(
      dependencies,
      this.timer,
      new DefaultTalkBackNavigationDriverFactory(this.adbFactory),
    );
    this.isIosVoiceOverOn = iosVoiceOverProbe(device, {
      detector: dependencies.iosVoiceOverDetector ?? defaultIosVoiceOverDetector,
      stateClient: () => dependencies.iosVoiceOverStateClient ?? liveIosClient(),
      featureFlags: talkBack.featureFlags,
      timer: this.timer,
    });
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
    call: DisplayTapCall,
  ): Promise<TapAtResult> {
    const { onTapDelivered, signal, onDispatchCompleted, onActivationWarnings } = call;
    const action = options.action ?? "tap";
    const { observation, displayId, followUpDisplay, assertCurrent } =
      await prepareTargetDisplayAction(this.device, display, this.observeScreen, {
        adb: this.adb,
        lastRenderedObservation: this.lastRenderedObservation,
        signal,
        transitions: this.displayTransitionReader,
      });
    const refusal = this.preDispatchRefusal(options, observation);
    if (refusal) {
      return refusal;
    }
    const resolved = await this.resolveWithXr(options, observation, signal);
    if ("error" in resolved) {
      return {
        success: false,
        x: resolved.x,
        y: resolved.y,
        action,
        error: resolved.error,
      };
    }
    const result: TapAtResult = await this.observedInteraction(
      async () => {
        assertCurrent();
        let dispatchRoute: string | undefined;
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
            followUpDisplay,
            onTapDelivered: () => onTapDelivered(true),
            onActivationWarnings,
          });
        } else {
          const dispatched = await this.dispatchGesture(options, resolved, observation, {
            signal,
            displayId,
            assertCurrent,
            onTapDelivered,
            onWarning: (warning) => onActivationWarnings?.([warning]),
          });
          dispatchRoute = dispatched?.route;
        }
        onDispatchCompleted?.();
        return {
          success: true,
          x: resolved.x,
          y: resolved.y,
          action,
          ...(dispatchRoute !== undefined ? { dispatchRoute } : {}),
          ...(resolved.xrPanel ? { xrPanel: resolved.xrPanel } : {}),
          ...(resolved.warning ? { warning: resolved.warning } : {}),
        };
      },
      {
        changeExpected: false,
        display: followUpDisplay,
        previousObservation: observation,
        signal,
      },
    );
    this.annotateIosEffect(result, observation);
    return result;
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
    rejectTvosTouch(this.device.platform, "tapAt");
    const { progress, signal, planContext } = resolveTapAtCall(
      progressOrCall,
      signalArg,
      planContextArg,
    );
    const error = stylusTapRefusal(this.device.platform, options);
    if (error) {
      return refusedTap(error, inputPoint(options), options.action);
    }
    return this.executeTap({ ...options, planContext }, progress, signal);
  }

  /** A stylus tap or long press: `adb input stylus` for the plain case, instrumentation or uinput for more. */
  private async dispatchStylusTapAt(
    options: TapAtOptions,
    resolved: { x: number; y: number },
    transitionRevision: ReturnType<TapAtCoordinate["captureTransitionRevision"]>,
    signal?: AbortSignal,
  ): Promise<void> {
    const fence = {
      signal,
      assertCurrent: () => this.assertDisplayRevisionCurrent(transitionRevision),
    };
    if (!pointerNeedsInstrumentation(options.pointer)) {
      await dispatchStylusTap(this.adb, resolved, options, fence);
      return;
    }
    // Pressure, tilt, orientation or buttons: refused before input when the device lacks the route (#13099).
    const durationMs =
      options.action === "longPress" ? (options.durationMs ?? LONG_PRESS_DEFAULT_MS) : undefined;
    try {
      await dispatchRichStylus(
        this.device,
        this.adb,
        strokeRequest(options.pointer!, tapStrokePoints(resolved, durationMs)),
        { ...fence, ...this.stylusRoutes },
      );
    } catch (error) {
      // Once the stroke was sent, an unconfirmed result may have been applied.
      throw error instanceof StylusOutcomeIndeterminateError
        ? indeterminateTapError(error.message)
        : error;
    }
  }

  private async executeTap(
    options: TapAtOptions,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<TapAtResult> {
    const action = options.action ?? "tap";
    const perf = createGlobalPerformanceTracker();
    perf.serial("tapAt");
    let dispatchedCoordinates: { x: number; y: number } | undefined;
    let iosDispatch: { timestamp: number; route?: string } | undefined;
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
        const result = await this.executeOnDisplay(options, options.display, {
          onTapDelivered,
          signal,
          onDispatchCompleted: () => {
            delivery.displayCompleted = true;
          },
          onActivationWarnings,
        });
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
      const result: TapAtResult = await this.observedInteraction(
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
          const refusal = this.preDispatchRefusal(options, observeResult);
          if (refusal) {
            return refusal;
          }
          const resolved = await this.resolveWithXr(options, observeResult, signal);
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
                // Stylus goes straight through `input stylus`, instrumentation or uinput: no
                // TalkBack routing and no finger fallback.
                await this.dispatchStylusTapAt(options, resolved, transitionRevision, signal);
                onTapDelivered();
                break;
              }
              const talkBackEnabled = await this.androidTalkBack.resolveState(
                signal,
                onActivationWarnings,
              );
              delivery.talkBack = talkBackEnabled;
              await this.androidDispatcher.dispatchAndroidTaps(options, resolved, observeResult, {
                transitionRevision,
                perf,
                signal,
                onTapDelivered,
                talkBackEnabled,
                onActivationWarnings,
              });
              break;
            }
            case "ios":
              iosDispatch = await this.dispatchIosTapsWithOneFreshRetry(
                options,
                resolved,
                observeResult,
                { transitionRevision, onTapDelivered, signal },
              );
              break;
            default:
              throw unsupportedPlatformError(this.device.platform, "tap at coordinates");
          }

          return {
            success: true,
            x: resolved.x,
            y: resolved.y,
            action,
            ...(iosDispatch?.route !== undefined ? { dispatchRoute: iosDispatch.route } : {}),
            ...(resolved.xrPanel ? { xrPanel: resolved.xrPanel } : {}),
            ...(resolved.warning ? { warning: resolved.warning } : {}),
          };
        },
        {
          changeExpected: false,
          progress,
          perf,
          signal,
          // The pre-dispatch observation above supplies the target and frame
          // context; do not resolve a second cached one first.
          skipPreviousObserve: true,
          observationTimestampProvider: () => iosDispatch?.timestamp,
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
      this.annotateIosEffect(result, preDispatchObservation);
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

  private annotateIosEffect(result: TapAtResult, previousObservation: ObserveResult | null): void {
    if (this.device.platform === "ios" && result.success && result.observation) {
      result.effect = this.deriveInteractionEffect(previousObservation, result.observation);
    }
  }

  /** A stale snapshot, or an iOS observation laid out for the transposed screen (#18245). */
  private preDispatchRefusal(
    options: TapAtOptions,
    observation: ObserveResult,
  ): TapAtResult | undefined {
    const mismatch =
      this.device.platform === "ios" ? describeTransposedLayout(observation) : undefined;
    const error =
      this.staleSnapshotReason(options, observation) ??
      (mismatch === undefined ? undefined : staleGeometryTapError(mismatch));
    if (error === undefined) {
      return undefined;
    }
    const { x, y } = inputPoint(options);
    return { success: false, x, y, action: options.action ?? "tap", error };
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
    context: IosTapDispatchContext,
  ): Promise<{ timestamp: number; route?: string }> {
    const { transitionRevision, signal } = context;
    const frameContext = observation.viewHierarchy?.frameContext;
    try {
      return await this.dispatchIosTaps(options, point, frameContext, context);
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
      return await this.dispatchIosTaps(options, retry.point, retry.frameContext, context);
    }
  }

  private async dispatchIosTaps(
    options: TapAtOptions,
    point: { x: number; y: number },
    frameContext: string | undefined,
    context: IosTapDispatchContext,
  ): Promise<{ timestamp: number; route?: string }> {
    const { transitionRevision, onTapDelivered, signal } = context;
    this.assertDisplayRevisionCurrent(transitionRevision);
    const dispatched = await this.dispatchIosCoordinateTap(options.action, point, {
      durationMs: tapDurationMs(options, "ios"),
      frameContext,
      signal,
    });
    try {
      onTapDelivered();
      if (options.action === "doubleTap") {
        onTapDelivered();
      }
      throwIfAborted(signal);
      return { timestamp: this.timer.now(), ...dispatched };
    } finally {
      this.invalidateIosCacheSafely();
    }
  }

  /** One iOS coordinate gesture; a timeout with VoiceOver on names the remedy. */
  private async dispatchIosCoordinateTap(
    action: TapAtOptions["action"],
    point: { x: number; y: number },
    request: { durationMs: number; frameContext?: string; signal?: AbortSignal },
  ): Promise<{ route?: string } | void> {
    const { durationMs, frameContext, signal } = request;
    const dispatch = action === "doubleTap" ? this.iosDoubleTap : this.iosCoordinateTap;
    let dispatched: { route?: string } | void = undefined;
    await withVoiceOverTimeoutContextIfOn(async () => {
      dispatched = await dispatch(this.iosClient, point, {
        durationMs,
        frameContext,
        options: { signal },
      });
    }, this.isIosVoiceOverOn);
    return dispatched;
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
      followUpDisplay: string;
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
      await this.androidTalkBack.dispatchTap(options, resolved, frameContext, {
        signal,
        context: dispatchContext,
      });
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
        display: context.followUpDisplay,
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
      await this.androidTalkBack.dispatchTap(options, retry.point, retry.frameContext, {
        signal,
        context: dispatchContext,
      });
    }
  }

  /** Resolves with the shared XR predicate for every Android tapAt, including native points. */
  private async resolveWithXr(
    options: TapAtOptions,
    observation: ObserveResult,
    signal?: AbortSignal,
  ): Promise<ReturnType<typeof resolveCoordinates>> {
    if (this.device.platform === "android") {
      this.androidXr = await isAndroidXr(
        { device: this.device, adb: this.adb, backStack: observation.backStack, signal },
        this.xrDetector,
      );
    }
    return resolveCoordinates(
      { ...options, androidXr: this.androidXr },
      observation,
      this.device.platform,
    );
  }

  private resolveFreshFrameRetry(
    options: TapAtOptions,
    point: { x: number; y: number },
    initial: ObserveResult,
    refreshed: ObserveResult,
  ): { point: { x: number; y: number }; frameContext: string } | undefined {
    // The XR answer is a device property, so the retry reuses the one the first resolve read.
    const resolved = resolveCoordinates(
      { ...options, androidXr: this.androidXr },
      refreshed,
      this.device.platform,
    );
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
    context: DisplayGestureContext,
  ): Promise<void> {
    const { displayId, signal } = context;
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
    await executeTouchscreenInput(this.adb, command, displayId, {
      signal,
      assertCurrent: context.assertCurrent,
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
    context: DisplayGestureContext & { onWarning?: (warning: string) => void },
  ): Promise<{ route?: string } | void> {
    const { signal, displayId } = context;
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
        await this.dispatchAndroidDisplayGesture(point, duration, command, context);
      } else if (this.device.platform === "ios") {
        const dispatched = await this.dispatchIosCoordinateTap(action, point, {
          durationMs: duration,
          frameContext: observation.viewHierarchy?.frameContext,
          signal,
        });
        context.onTapDelivered();
        if (action === "doubleTap") {
          context.onTapDelivered();
        }
        return dispatched;
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
        tap: async () => {
          await dispatch();
        },
      });
      return;
    }
    const dispatched = await dispatch();
    if (this.device.platform === "ios") {
      try {
        throwIfAborted(signal);
      } finally {
        this.invalidateIosCacheSafely();
      }
      return dispatched;
    }
  }
}

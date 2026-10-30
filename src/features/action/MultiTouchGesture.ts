import { DispatchedObservationError } from "../../models/DispatchedObservationError";
import { logger } from "../../utils/logger";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { BootedDevice, ObserveResult } from "../../models";
import type { MultiTouchOptions, MultiTouchResult } from "../../models/MultiTouchOptions";
import { createGlobalPerformanceTracker } from "../../utils/PerformanceTracker";
import type { PerformanceTracker } from "../../utils/PerformanceTracker";
import type { Timer } from "../../utils/SystemTimer";
import { awaitWhileRequestIsLive, throwIfAborted } from "../../utils/toolUtils";
import { layerGestureRefusal } from "../observe/hierarchyLayer";
import { StaleDisplayError, withStaleDisplay } from "../observe/StaleDisplayError";
import { AndroidCtrlProxyClient } from "../observe/android";
import { IOSCtrlProxyClient } from "../observe/ios";
import { isRunnerGestureOutcomeUnknown } from "../observe/ios/runnerErrorCodes";
import { resolveActionCall, type ActionCall } from "./ActionCall";
import { BaseVisualChange, type DisplayFenceDependencies } from "./BaseVisualChange";
import { resolveGestureCtrlProxyTimeoutMs } from "./gestureTransportTimeout";
import {
  planMultiTouch,
  validateMultiTouchOptions,
  type MultiTouchPlan,
} from "./multiTouchGeometry";
import { OBSERVED_INTERACTION_PROFILES, SETTLE_BUDGET_MS } from "./observedInteractionProfiles";
import { resolveTapAtCoordinates } from "./TapAtCoordinate";

const TOOL_NAME = "multiTouch";

type DispatchOutcome = {
  success: boolean;
  error?: string;
  errorCode?: string;
  dispatched?: boolean;
  acknowledged?: boolean;
  unsupportedCapability?: string;
};

/** The request one platform client receives: every finger shares the first finger's stroke. */
export interface MultiTouchDispatchRequest {
  plan: MultiTouchPlan;
  perf: PerformanceTracker;
  signal?: AbortSignal;
  onDispatch: () => void;
  beforeSend: () => void;
}

export interface MultiTouchClients {
  android?: (request: MultiTouchDispatchRequest) => Promise<DispatchOutcome>;
  ios?: (request: MultiTouchDispatchRequest) => Promise<DispatchOutcome>;
}

export interface MultiTouchGestureDependencies extends DisplayFenceDependencies {
  timer?: Timer;
  clients?: MultiTouchClients;
  invalidateIosCache?: () => void;
}

/** The raw caller point, echoed on a failure that never reached a resolved native point. */
function inputEcho(options: MultiTouchOptions) {
  return { x1: options.x, y1: options.y, x2: options.x, y2: options.y };
}

function isOutcomeUnknown(outcome: DispatchOutcome, dispatched: boolean): boolean {
  return (
    isRunnerGestureOutcomeUnknown(outcome) ||
    (outcome.acknowledged === false && (outcome.dispatched === true || dispatched))
  );
}

/** Simultaneous 2-5 finger tap, long press or swipe at a screen point. */
export class MultiTouchGesture extends BaseVisualChange {
  private readonly clients: Required<MultiTouchClients>;
  private readonly invalidateIosCache: () => void;

  constructor(
    device: BootedDevice,
    adb: AdbExecutor | null = null,
    dependencies: MultiTouchGestureDependencies = {},
  ) {
    super(device, {
      adb,
      timer: dependencies.timer,
      displayFence: dependencies,
    });
    this.clients = {
      android: dependencies.clients?.android ?? ((request) => this.dispatchAndroid(request)),
      ios: dependencies.clients?.ios ?? ((request) => this.dispatchIos(request)),
    };
    this.invalidateIosCache =
      dependencies.invalidateIosCache ??
      (() => IOSCtrlProxyClient.getExistingInstance(this.device.deviceId)?.invalidateCache());
  }

  private dispatchAndroid(request: MultiTouchDispatchRequest): Promise<DispatchOutcome> {
    const { plan } = request;
    return AndroidCtrlProxyClient.getInstance(this.device).requestMultiFingerSwipe({
      x1: plan.points[0].x,
      y1: plan.points[0].y,
      x2: plan.end.x,
      y2: plan.end.y,
      fingerCount: plan.fingers,
      duration: plan.durationMs,
      fingerSpacing: plan.fingerSpacing,
      timeoutMs: resolveGestureCtrlProxyTimeoutMs(plan.durationMs),
      perf: request.perf,
      signal: request.signal,
      onDispatch: request.onDispatch,
      beforeSend: request.beforeSend,
    });
  }

  private dispatchIos(request: MultiTouchDispatchRequest): Promise<DispatchOutcome> {
    const { plan } = request;
    return IOSCtrlProxyClient.getInstance(this.device).requestMultiFingerSwipe({
      x1: plan.points[0].x,
      y1: plan.points[0].y,
      x2: plan.end.x,
      y2: plan.end.y,
      fingerCount: plan.fingers,
      duration: plan.durationMs,
      timeoutMs: resolveGestureCtrlProxyTimeoutMs(plan.durationMs),
      perf: request.perf,
      fingerSpacing: plan.fingerSpacing,
      signal: request.signal,
      onDispatch: request.onDispatch,
      beforeSend: request.beforeSend,
    });
  }

  async execute(options: MultiTouchOptions, call: ActionCall = {}): Promise<MultiTouchResult> {
    const { progress, signal } = resolveActionCall(call);
    const perf = createGlobalPerformanceTracker();
    perf.serial(TOOL_NAME);
    let iosDispatchTimestamp: number | undefined;
    let preDispatchObservation: ObserveResult | null = null;

    const failure = (error: string, plan?: MultiTouchPlan): MultiTouchResult => ({
      success: false,
      ...inputEcho(options),
      ...(plan
        ? { x1: plan.points[0].x, y1: plan.points[0].y, x2: plan.end.x, y2: plan.end.y }
        : {}),
      duration: 0,
      error,
      action: options.action,
      fingers: plan?.fingers ?? options.fingers ?? 2,
      fingerSpacing: plan?.fingerSpacing ?? options.fingerSpacing ?? 0,
      points: plan?.points ?? [],
    });

    try {
      throwIfAborted(signal);
      const invalid = validateMultiTouchOptions(options);
      if (invalid) {
        return failure(invalid);
      }
      const result = await this.observedInteraction(
        async (_observed, fence) => {
          const observation = await this.observeScreen.execute({
            freshness: "cached-ok",
            signal,
            perf,
          });
          preDispatchObservation = observation;
          const center = resolveTapAtCoordinates(
            { x: options.x, y: options.y, coordinateSpace: options.coordinateSpace },
            observation,
            this.device.platform,
            TOOL_NAME,
          );
          if ("error" in center) {
            return failure(center.error);
          }
          const plan = planMultiTouch(options, center, observation.screenSize);
          if ("error" in plan) {
            return failure(plan.error);
          }
          // Touch routing follows the window under every finger-down point.
          const layerRefusal = layerGestureRefusal(
            observation.viewHierarchy,
            options.layer,
            plan.points,
            options.action === "swipe" ? "swipe" : options.action,
          );
          if (layerRefusal) {
            return failure(layerRefusal, plan);
          }
          throwIfAborted(signal);
          return this.dispatch(plan, options.action, { perf, signal, fence }, (timestamp) => {
            iosDispatchTimestamp = timestamp;
          });
        },
        {
          ...OBSERVED_INTERACTION_PROFILES.rawCoordinateGesture,
          skipPreviousObserve: true,
          timeoutMs: SETTLE_BUDGET_MS.brief,
          progress,
          perf,
          signal,
          observationTimestampProvider: () => iosDispatchTimestamp,
          predictionContext: {
            toolName: TOOL_NAME,
            toolArgs: { ...options, platform: this.device.platform },
          },
        },
      );
      this.annotateDeviceLock(result, preDispatchObservation);
      return result;
    } catch (error) {
      if (error instanceof StaleDisplayError || error instanceof DispatchedObservationError) {
        logger.warn(`${TOOL_NAME} refused after a display change: ${error.message}`);
        return withStaleDisplay(failure(error.message), error);
      }
      throw error;
    } finally {
      perf.end();
    }
  }

  private async dispatch(
    plan: MultiTouchPlan,
    action: MultiTouchResult["action"],
    context: {
      perf: PerformanceTracker;
      signal?: AbortSignal;
      fence?: { assertCurrent(): void };
    },
    markIosDispatch: (timestamp: number) => void,
  ): Promise<MultiTouchResult> {
    const { perf, signal, fence } = context;
    let dispatched = false;
    const outcome = await perf.track("executeMultiTouch", () =>
      awaitWhileRequestIsLive(
        this.clients[this.device.platform === "ios" ? "ios" : "android"]({
          plan,
          perf,
          signal,
          onDispatch: () => {
            dispatched = true;
          },
          beforeSend: () => fence?.assertCurrent(),
        }),
        signal,
      ),
    );
    throwIfAborted(signal);
    const base = {
      x1: plan.points[0].x,
      y1: plan.points[0].y,
      x2: plan.end.x,
      y2: plan.end.y,
      duration: plan.durationMs,
      action,
      fingers: plan.fingers,
      fingerSpacing: plan.fingerSpacing,
      points: plan.points,
      warning: plan.warning,
    };
    if (this.device.platform === "ios" && (outcome.success || dispatched)) {
      markIosDispatch(this.timer.now());
      this.invalidateIosCache();
    }
    if (outcome.success) {
      return { ...base, success: true };
    }
    const refusal = outcome.unsupportedCapability
      ? `${plan.fingers}-finger gestures need the CtrlProxy capability ${outcome.unsupportedCapability}, but the connected CtrlProxy build does not advertise multi-finger gestures (the installed APK is likely older than this daemon). Two-finger gestures (fingers: 2) still work. To get a build that supports ${plan.fingers} fingers, upgrade AutoMobile, or set AUTOMOBILE_CTRL_PROXY_APK_PATH to a CtrlProxy APK built from matching source (android/control-proxy) and restart the daemon. Nothing was dispatched.`
      : undefined;
    // A request written to the device whose reply never arrived may already have landed.
    const indeterminate = refusal === undefined && isOutcomeUnknown(outcome, dispatched);
    return {
      ...base,
      success: false,
      duration: 0,
      error: refusal ?? outcome.error ?? "Multi-finger gesture failed",
      ...(indeterminate ? { outcomeIndeterminate: true, retryable: false } : {}),
    };
  }
}

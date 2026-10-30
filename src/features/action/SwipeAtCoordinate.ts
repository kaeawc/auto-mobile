import {
  dispatchRichStylus,
  pointerNeedsInstrumentation,
  strokeRequest,
  type RichStylusOptions,
} from "./pointer/richStylus";
import type { PointerOption } from "../../models/PointerOption";
import { androidCtrlProxyClientForPlatform } from "../observe/android/androidCtrlProxyClientFor";
import { ActionableError } from "../../models/ActionableError";
import { DispatchedObservationError } from "../../models/DispatchedObservationError";
import { logger } from "../../utils/logger";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { BootedDevice, ObserveResult, SwipeResult, TapAtOptions } from "../../models";
import type { SwipeAtOptions, SwipeAtRecordingContext } from "../../models/SwipeAtOptions";
import type { ElementGeometry } from "../../utils/interfaces/ElementGeometry";
import { createGlobalPerformanceTracker } from "../../utils/PerformanceTracker";
import type { Timer } from "../../utils/SystemTimer";
import { throwIfAborted } from "../../utils/toolUtils";
import { layerGestureRefusal } from "../observe/hierarchyLayer";
import { StaleDisplayError, withStaleDisplay } from "../observe/StaleDisplayError";
import { IOSCtrlProxyClient } from "../observe/ios";
import { snapshotReferences, type SnapshotReferenceStore } from "../observe/SnapshotReferenceStore";
import { DefaultElementGeometry } from "../utility/ElementGeometry";
import { resolveActionCall, type ActionCall } from "./ActionCall";
import { BaseVisualChange, type DisplayFenceDependencies } from "./BaseVisualChange";
import { ExecuteGesture } from "./ExecuteGesture";
import { withVelocity } from "./swipeon/swipeDurationReport";
import { validateDurationMs } from "./swipeon/swipeTiming";
import { OBSERVED_INTERACTION_PROFILES, SETTLE_BUDGET_MS } from "./observedInteractionProfiles";
import { resolveTapAtCoordinates } from "./TapAtCoordinate";
import { prepareTargetDisplayAction, type RenderedObservationReader } from "./TargetDisplayAction";
import {
  executeTouchscreenInput,
  inputDurationArgument,
  supportsCtrlProxyGestureDisplay,
} from "./touchscreenInput";
import { errorMessage } from "../../utils/describeUnknownError";
import {
  StylusOutcomeIndeterminateError,
  dispatchStylusSwipe,
  stylusRefusal,
} from "./stylusPointer";
import { type AndroidCtrlProxy } from "../observe/android";
import {
  selectedDisplayPin,
  unsupportedDisplayOptionMessage,
} from "../observe/SessionDisplayContext";

const TOOL_NAME = "swipeAt";

export interface SwipeAtCoordinateDependencies extends DisplayFenceDependencies {
  timer?: Timer;
  snapshotReferences?: SnapshotReferenceStore;
  executeGesture?: Pick<ExecuteGesture, "swipe">;
  geometry?: Pick<ElementGeometry, "getSwipeDurationFromSpeed">;
  invalidateIosCache?: () => void;
  /** CtrlProxy client that carries `displayId` for an explicit-display swipe. */
  androidClient?: Pick<AndroidCtrlProxy, "requestSwipe" | "supportsCommand">;
  lastRenderedObservation?: RenderedObservationReader;
  /** Stylus routes and device facts; the defaults use the instrumentation route and the live device. */
  stylus?: Pick<RichStylusOptions, "injectors" | "readEnvironment">;
}

type NativePoint = { x: number; y: number };
type ResolvedSwipe = { from: NativePoint; to: NativePoint } | { error: string };

/** The raw caller input, echoed on a failure that never reached a resolved native point. */
function inputEcho(options: SwipeAtOptions): Pick<SwipeResult, "x1" | "y1" | "x2" | "y2"> {
  const { from, to } = options.image ?? options;
  return { x1: from?.x ?? 0, y1: from?.y ?? 0, x2: to?.x ?? 0, y2: to?.y ?? 0 };
}

/** One `tapAt`-shaped option per endpoint, so both share the tap point resolution. */
function endpointOptions(
  options: SwipeAtOptions,
): [TapAtOptions, TapAtOptions] | { error: string } {
  if (options.image !== undefined) {
    if (options.from !== undefined || options.to !== undefined || options.coordinateSpace) {
      return {
        error: `${TOOL_NAME} image is mutually exclusive with from, to, and coordinateSpace`,
      };
    }
    const { unit, source, from, to } = options.image;
    return [
      { image: { unit, source, x: from.x, y: from.y } },
      { image: { unit, source, x: to.x, y: to.y } },
    ];
  }
  if (!options.from || !options.to) {
    return { error: `${TOOL_NAME} requires from and to points without image` };
  }
  const { coordinateSpace } = options;
  return [
    { x: options.from.x, y: options.from.y, coordinateSpace },
    { x: options.to.x, y: options.to.y, coordinateSpace },
  ];
}

function resolveEndpoints(
  options: SwipeAtOptions,
  observation: ObserveResult,
  platform: BootedDevice["platform"],
): ResolvedSwipe {
  const endpoints = endpointOptions(options);
  if ("error" in endpoints) {
    return endpoints;
  }
  let from: ReturnType<typeof resolveTapAtCoordinates>;
  let to: ReturnType<typeof resolveTapAtCoordinates>;
  try {
    [from, to] = endpoints.map((endpoint) =>
      resolveTapAtCoordinates(endpoint, observation, platform, TOOL_NAME),
    );
  } catch (error) {
    if (!(error instanceof ActionableError)) {
      throw error;
    }
    // Image-relative metadata that does not describe this screen is a caller error, not a crash.
    logger.warn(`${TOOL_NAME} image endpoint rejected: ${error.message}`);
    return { error: error.message.replace(/^tapAt /, `${TOOL_NAME} `) };
  }
  if ("error" in from) {
    return { error: from.error };
  }
  if ("error" in to) {
    return { error: to.error };
  }
  if (from.x === to.x && from.y === to.y) {
    return {
      error: `${TOOL_NAME} from and to resolve to the same point (${from.x}, ${from.y}); use tapAt for a tap or long press`,
    };
  }
  return { from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y } };
}

/** Swipe between two screen points in the coordinate space observe reports. */
export class SwipeAtCoordinate extends BaseVisualChange {
  private readonly executeGesture: Pick<ExecuteGesture, "swipe">;
  private readonly geometry: Pick<ElementGeometry, "getSwipeDurationFromSpeed">;
  private readonly snapshotReferences: SnapshotReferenceStore;
  private readonly invalidateIosCache: () => void;
  private readonly androidClient: Pick<AndroidCtrlProxy, "requestSwipe" | "supportsCommand">;
  private readonly lastRenderedObservation?: RenderedObservationReader;
  private readonly stylusRoutes: Pick<RichStylusOptions, "injectors" | "readEnvironment">;

  constructor(
    device: BootedDevice,
    adb: AdbExecutor | null = null,
    dependencies: SwipeAtCoordinateDependencies = {},
  ) {
    super(device, {
      adb,
      timer: dependencies.timer,
      displayFence: dependencies,
    });
    this.executeGesture = dependencies.executeGesture ?? new ExecuteGesture(device, adb);
    this.geometry = dependencies.geometry ?? new DefaultElementGeometry();
    this.snapshotReferences = dependencies.snapshotReferences ?? snapshotReferences;
    this.androidClient =
      dependencies.androidClient ?? androidCtrlProxyClientForPlatform(device, this.adbFactory);
    this.lastRenderedObservation = dependencies.lastRenderedObservation;
    this.stylusRoutes = dependencies.stylus ?? {};
    this.invalidateIosCache =
      dependencies.invalidateIosCache ??
      (() => IOSCtrlProxyClient.getExistingInstance(this.device.deviceId)?.invalidateCache());
  }

  /** Snapshot staleness, endpoint resolution and layer ownership against one observation. */
  private checkObservation(
    options: SwipeAtOptions,
    observation: ObserveResult,
    failure: (error: string) => SwipeResult,
  ): { resolved: { from: NativePoint; to: NativePoint } } | { failure: SwipeResult } {
    const stale = options.snapshotId
      ? this.snapshotReferences.staleReason(options.snapshotId, this.device.deviceId, observation)
      : undefined;
    if (stale) {
      return { failure: failure(stale) };
    }
    const resolved = resolveEndpoints(options, observation, this.device.platform);
    if ("error" in resolved) {
      return { failure: failure(resolved.error) };
    }
    // Touch routing follows the window under the finger-down point.
    const layerRefusal = layerGestureRefusal(
      observation.viewHierarchy,
      options.layer,
      [resolved.from],
      "swipe",
    );
    return layerRefusal ? { failure: failure(layerRefusal) } : { resolved };
  }

  /**
   * Swipe on a selected Android panel. Resolution runs against that panel's observation and the
   * fence is re-checked immediately before the CtrlProxy request carrying its `displayId`.
   */
  private async executeOnDisplay(
    options: SwipeAtOptions,
    display: string,
    context: {
      call: ReturnType<typeof resolveActionCall>;
      perf: ReturnType<typeof createGlobalPerformanceTracker>;
      failure: (error: string) => SwipeResult;
    },
  ): Promise<SwipeResult> {
    const { call, perf, failure } = context;
    const { progress, signal } = call;
    if (this.device.platform !== "android") {
      return failure(
        selectedDisplayPin() === undefined
          ? "swipeAt `display` is Android-only; omit `display` on iOS"
          : unsupportedDisplayOptionMessage("swipeAt on iOS"),
      );
    }
    let target: Awaited<ReturnType<typeof prepareTargetDisplayAction>>;
    try {
      target = await prepareTargetDisplayAction(this.device, display, this.observeScreen, {
        adb: this.adb,
        lastRenderedObservation: this.lastRenderedObservation,
        signal,
        transitions: this.displayTransitionReader,
      });
    } catch (error) {
      if (
        error instanceof StaleDisplayError ||
        (error instanceof Error && error.name === "AbortError")
      ) {
        throw error;
      }
      logger.warn(`${TOOL_NAME} display routing failed: ${errorMessage(error)}`, error);
      return withStaleDisplay(failure(errorMessage(error)), error);
    }
    const checked = this.checkObservation(options, target.observation, failure);
    if ("failure" in checked) {
      return checked.failure;
    }
    const { from, to } = checked.resolved;
    const panel = target.observation.display.key;
    const duration = options.durationMs ?? this.geometry.getSwipeDurationFromSpeed(options.speed);
    const result = await this.observedInteraction(
      async () => {
        const base = { x1: from.x, y1: from.y, x2: to.x, y2: to.y };
        let dispatched = false;
        try {
          target.assertCurrent();
          throwIfAborted(signal);
          const sent = await perf.track("executeSwipe", () =>
            this.dispatchOnDisplay({
              from,
              to,
              duration,
              target,
              perf,
              signal,
              onDispatch: () => {
                dispatched = true;
              },
            }),
          );
          if (sent.success) {
            return withVelocity({ ...sent, ...base }, from, to, duration);
          }
          return sent.outcomeIndeterminate
            ? { ...sent, ...base }
            : { ...sent, ...base, duration: 0 };
        } catch (error) {
          if (
            error instanceof StaleDisplayError ||
            error instanceof DispatchedObservationError ||
            (error instanceof Error && error.name === "AbortError")
          ) {
            throw error;
          }
          logger.warn(`${TOOL_NAME} display dispatch failed: ${errorMessage(error)}`, error);
          return withStaleDisplay(
            {
              success: false,
              ...base,
              duration: dispatched ? duration : 0,
              error: dispatched
                ? `${errorMessage(error)} (the swipe was dispatched and may have been applied; do not retry automatically)`
                : errorMessage(error),
              ...(dispatched ? { outcomeIndeterminate: true } : {}),
            },
            error,
          );
        }
      },
      {
        ...OBSERVED_INTERACTION_PROFILES.rawCoordinateGesture,
        display: panel,
        previousObservation: target.observation,
        timeoutMs: SETTLE_BUDGET_MS.brief,
        progress,
        perf,
        signal,
      },
    );
    this.annotateDeviceLock(result, target.observation);
    return result;
  }

  /**
   * Default display: the same injection as the no-display path. Other panels: CtrlProxy with the
   * panel's displayId when advertised (falling back to adb if it fails before dispatch), else adb
   * `input touchscreen -d`.
   */
  private async dispatchOnDisplay(input: {
    from: NativePoint;
    to: NativePoint;
    duration: number;
    target: Awaited<ReturnType<typeof prepareTargetDisplayAction>>;
    perf: ReturnType<typeof createGlobalPerformanceTracker>;
    signal?: AbortSignal;
    onDispatch: () => void;
  }): Promise<SwipeResult> {
    const { from, to, duration, target, perf, signal, onDispatch } = input;
    const { displayId } = target;
    if (displayId === undefined || displayId === 0) {
      // The gesture reports its own outcomeIndeterminate; a throw before sending is a plain failure.
      return this.executeGesture.swipe(
        { x1: from.x, y1: from.y, x2: to.x, y2: to.y },
        { duration, displayFence: { assertCurrent: target.assertCurrent } },
        { perf, signal },
      );
    }
    if (await supportsCtrlProxyGestureDisplay(this.androidClient, displayId)) {
      let dispatched = false;
      const base = { x1: from.x, y1: from.y, x2: to.x, y2: to.y };
      let reason: string | undefined;
      try {
        const result = await this.androidClient.requestSwipe({
          x1: from.x,
          y1: from.y,
          x2: to.x,
          y2: to.y,
          duration,
          perf,
          onDispatch: () => {
            dispatched = true;
            onDispatch();
          },
          signal,
          displayId,
          beforeSend: target.assertCurrent,
        });
        throwIfAborted(signal);
        if (result.success) {
          return { success: true, ...base, duration };
        }
        reason = result.error ?? "Android swipe failed";
      } catch (error) {
        if (
          dispatched ||
          error instanceof StaleDisplayError ||
          (error instanceof Error && error.name === "AbortError")
        ) {
          throw error;
        }
        reason = errorMessage(error);
      }
      if (dispatched) {
        return {
          success: false,
          ...base,
          duration,
          error: `${reason} (the swipe was dispatched and may have been applied; do not retry automatically)`,
          outcomeIndeterminate: true,
        };
      }
      logger.warn(`${TOOL_NAME} CtrlProxy swipe failed (${reason}), falling back to ADB input`);
    }
    throwIfAborted(signal);
    await executeTouchscreenInput(
      this.adb,
      `swipe ${from.x} ${from.y} ${to.x} ${to.y} ${inputDurationArgument(duration)}`,
      displayId,
      { signal, assertCurrent: target.assertCurrent, onDispatch },
    );
    return { success: true, x1: from.x, y1: from.y, x2: to.x, y2: to.y, duration };
  }

  /**
   * Stylus swipe through `adb shell input stylus`. It reports its own failure and never retries as
   * a finger: once the command was dispatched, an error leaves the outcome indeterminate.
   */
  private async dispatchStylus(
    resolved: { from: NativePoint; to: NativePoint },
    duration: number,
    fence: { assertCurrent: () => void } | undefined,
    { pointer, signal }: { pointer?: PointerOption; signal?: AbortSignal } = {},
  ): Promise<SwipeResult> {
    const { from, to } = resolved;
    const base = { x1: from.x, y1: from.y, x2: to.x, y2: to.y };
    try {
      if (pointerNeedsInstrumentation(pointer)) {
        // Pressure, tilt, orientation or buttons: the instrumentation route, refused before input
        // when the device lacks it (#13099).
        await dispatchRichStylus(
          this.device,
          this.adb,
          strokeRequest(pointer!, [from, { ...to, durationMs: duration }]),
          { ...this.stylusRoutes, signal, assertCurrent: fence?.assertCurrent },
        );
      } else {
        await dispatchStylusSwipe(
          this.adb,
          { from, to, duration },
          { signal, assertCurrent: fence?.assertCurrent },
        );
      }
      return { success: true, ...base, duration };
    } catch (error) {
      // An abort before the command was sent is a plain cancellation, as is a stale display.
      if (
        error instanceof StaleDisplayError ||
        (error instanceof Error && error.name === "AbortError")
      ) {
        throw error;
      }
      logger.warn(`${TOOL_NAME} stylus dispatch failed: ${errorMessage(error)}`, error);
      // Once the command was sent, an unconfirmed result may have been applied.
      return error instanceof StylusOutcomeIndeterminateError
        ? {
            success: false,
            ...base,
            duration,
            error: `${errorMessage(error)} (the swipe was dispatched and may have been applied; do not retry automatically)`,
            outcomeIndeterminate: true,
          }
        : { success: false, ...base, duration: 0, error: errorMessage(error) };
    }
  }

  async execute(
    options: SwipeAtOptions,
    call: ActionCall & { recordingContext?: SwipeAtRecordingContext } = {},
  ): Promise<SwipeResult> {
    const { progress, signal } = resolveActionCall(call);
    const perf = createGlobalPerformanceTracker();
    perf.serial(TOOL_NAME);
    let iosDispatchTimestamp: number | undefined;
    let preDispatchObservation: ObserveResult | null = null;

    const failure = (error: string): SwipeResult => ({
      success: false,
      ...inputEcho(options),
      duration: 0,
      error,
    });

    try {
      throwIfAborted(signal);
      // Reject an ambiguous or out-of-range duration before any observation or input.
      const durationError = validateDurationMs(options);
      if (durationError) {
        return failure(durationError);
      }
      const stylusError = stylusRefusal({
        pointer: options.pointer,
        platform: this.device.platform,
        gesture: "swipe",
        display: options.display,
      });
      if (stylusError) {
        return failure(stylusError);
      }
      if (options.display !== undefined) {
        return await this.executeOnDisplay(options, options.display, {
          call: { progress, signal },
          perf,
          failure,
        });
      }
      const result = await this.observedInteraction(
        async (_observed, fence) => {
          // Validate against the latest available frame immediately before dispatch.
          const observation = await this.observeScreen.execute({
            freshness: "cached-ok",
            signal,
            perf,
          });
          preDispatchObservation = observation;
          const checked = this.checkObservation(options, observation, failure);
          if ("failure" in checked) {
            return checked.failure;
          }
          const { resolved } = checked;
          if (call.recordingContext) {
            call.recordingContext.screenSize = { ...observation.screenSize };
          }

          throwIfAborted(signal);
          const duration =
            options.durationMs ?? this.geometry.getSwipeDurationFromSpeed(options.speed);
          const result = await perf.track("executeSwipe", () =>
            options.pointer
              ? this.dispatchStylus(resolved, duration, fence, { pointer: options.pointer, signal })
              : this.executeGesture.swipe(
                  {
                    x1: resolved.from.x,
                    y1: resolved.from.y,
                    x2: resolved.to.x,
                    y2: resolved.to.y,
                  },
                  {
                    duration,
                    // A display change since the pre-dispatch read refuses just before the finger goes down.
                    displayFence: fence,
                  },
                  { perf, signal },
                ),
          );
          if (this.device.platform === "ios" && result.success) {
            iosDispatchTimestamp = this.timer.now();
            this.invalidateIosCache();
          }
          return result.success
            ? withVelocity(result, resolved.from, resolved.to, duration)
            : result;
        },
        {
          ...OBSERVED_INTERACTION_PROFILES.rawCoordinateGesture,
          // The pre-dispatch observation above supplies the frame context.
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
      // The base reads the lock state from its own pre-action observation, which this call skips.
      this.annotateDeviceLock(result, preDispatchObservation);
      return result;
    } catch (error) {
      if (error instanceof StaleDisplayError || error instanceof DispatchedObservationError) {
        // Typed like tapAt/swipeOn: the agent gets the canonical message plus `staleDisplay` details.
        logger.warn(`${TOOL_NAME} refused after a display change: ${error.message}`);
        return withStaleDisplay(failure(error.message), error);
      }
      throw error;
    } finally {
      perf.end();
    }
  }
}

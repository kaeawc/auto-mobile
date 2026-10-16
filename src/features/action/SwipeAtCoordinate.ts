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
import { OBSERVED_INTERACTION_PROFILES, SETTLE_BUDGET_MS } from "./observedInteractionProfiles";
import { resolveTapAtCoordinates } from "./TapAtCoordinate";

const TOOL_NAME = "swipeAt";

export interface SwipeAtCoordinateDependencies extends DisplayFenceDependencies {
  timer?: Timer;
  snapshotReferences?: SnapshotReferenceStore;
  executeGesture?: Pick<ExecuteGesture, "swipe">;
  geometry?: Pick<ElementGeometry, "getSwipeDurationFromSpeed">;
  invalidateIosCache?: () => void;
}

/** `ActionCall` for swipeAt: also carries the context the tool-call recorder reads back. */
export interface SwipeAtCall extends ActionCall {
  recordingContext?: SwipeAtRecordingContext;
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

  constructor(
    device: BootedDevice,
    adb: AdbExecutor | null = null,
    dependencies: SwipeAtCoordinateDependencies = {},
  ) {
    super(device, adb, dependencies.timer, dependencies.renderedDisplayRevision, dependencies);
    this.executeGesture = dependencies.executeGesture ?? new ExecuteGesture(device, adb);
    this.geometry = dependencies.geometry ?? new DefaultElementGeometry();
    this.snapshotReferences = dependencies.snapshotReferences ?? snapshotReferences;
    this.invalidateIosCache =
      dependencies.invalidateIosCache ??
      (() => IOSCtrlProxyClient.getExistingInstance(this.device.deviceId)?.invalidateCache());
  }

  async execute(options: SwipeAtOptions, call: SwipeAtCall = {}): Promise<SwipeResult> {
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
      const result = await this.observedInteraction(
        async (_observed, fence) => {
          // Validate against the latest available frame immediately before dispatch.
          const observation = await this.observeScreen.execute({
            freshness: "cached-ok",
            signal,
            perf,
          });
          preDispatchObservation = observation;
          const stale = options.snapshotId
            ? this.snapshotReferences.staleReason(
                options.snapshotId,
                this.device.deviceId,
                observation,
              )
            : undefined;
          if (stale) {
            return failure(stale);
          }
          const resolved = resolveEndpoints(options, observation, this.device.platform);
          if ("error" in resolved) {
            return failure(resolved.error);
          }
          if (call.recordingContext) {
            call.recordingContext.recorded = {
              screenSize: {
                width: observation.screenSize.width,
                height: observation.screenSize.height,
              },
              from: resolved.from,
              to: resolved.to,
            };
          }
          // Touch routing follows the window under the finger-down point.
          const layerRefusal = layerGestureRefusal(
            observation.viewHierarchy,
            options.layer,
            [resolved.from],
            "swipe",
          );
          if (layerRefusal) {
            return failure(layerRefusal);
          }

          throwIfAborted(signal);
          const result = await perf.track("executeSwipe", () =>
            this.executeGesture.swipe(
              resolved.from.x,
              resolved.from.y,
              resolved.to.x,
              resolved.to.y,
              {
                duration: this.geometry.getSwipeDurationFromSpeed(options.speed),
                // A display change since the pre-dispatch read refuses just before the finger goes down.
                displayFence: fence,
              },
              perf,
              signal,
            ),
          );
          if (this.device.platform === "ios" && result.success) {
            iosDispatchTimestamp = this.timer.now();
            this.invalidateIosCache();
          }
          return result;
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

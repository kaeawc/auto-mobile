import { isDeepStrictEqual } from "node:util";
import {
  ActionableError,
  BootedDevice,
  ObserveResult,
  TapAtOptions,
  TapAtResult,
  toActionableError,
} from "../../models";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { errorMessage } from "../../utils/describeUnknownError";
import {
  createGlobalPerformanceTracker,
  type PerformanceTracker,
} from "../../utils/PerformanceTracker";
import type { Timer } from "../../utils/SystemTimer";
import { throwIfAborted } from "../../utils/toolUtils";
import { AndroidCtrlProxyClient } from "../observe/android";
import { IOSCtrlProxyClient } from "../observe/ios";
import { BaseVisualChange, type ProgressCallback } from "./BaseVisualChange";
import {
  type CoordinateTapClient,
  dispatchAndroidCoordinateTap,
  dispatchIosCoordinateTap,
  isStaleFrameContextRejection,
} from "./coordinateTapDispatch";

const ANDROID_TAP_DURATION_MS = 10;
const IOS_TAP_DURATION_MS = 50;

// These capture-only fields are documented by the observation diff as nondeterministic between
// captures of one unchanged Android screen. They cannot establish that a coordinate was retargeted.
const VOLATILE_TAP_LAYOUT_FIELDS = new Set([
  "extras",
  "view-id",
  "occlusionState",
  "occludedBy",
  "occludedByViewId",
]);

type AndroidCoordinateTapDispatch = typeof dispatchAndroidCoordinateTap;
type IosCoordinateTapDispatch = typeof dispatchIosCoordinateTap;

function hasPositiveScreenSize(screenSize: ObserveResult["screenSize"] | undefined): boolean {
  if (!screenSize) {
    return false;
  }
  return (
    Number.isFinite(screenSize.width) &&
    Number.isFinite(screenSize.height) &&
    screenSize.width > 0 &&
    screenSize.height > 0
  );
}

function withoutVolatileTapLayoutFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(withoutVolatileTapLayoutFields);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !VOLATILE_TAP_LAYOUT_FIELDS.has(key))
      .map(([key, child]) => [key, withoutVolatileTapLayoutFields(child)]),
  );
}

function tapTargetingLayout(observation: ObserveResult): unknown | null {
  const rotation = observation.rotation ?? observation.viewHierarchy?.rotation;
  if (!Number.isInteger(rotation) || !observation.viewHierarchy) {
    return null;
  }

  const hierarchy = observation.viewHierarchy;
  return {
    screenSize: {
      width: observation.screenSize?.width,
      height: observation.screenSize?.height,
    },
    rotation,
    systemInsets: observation.systemInsets,
    insets: observation.insets,
    activeWindow: {
      appId: observation.activeWindow?.appId,
      activityName: observation.activeWindow?.activityName,
    },
    screenIdentity: observation.screenIdentity
      ? {
          platform: observation.screenIdentity.platform,
          source: observation.screenIdentity.source,
          key: observation.screenIdentity.key,
        }
      : undefined,
    hierarchy: {
      tree: withoutVolatileTapLayoutFields(hierarchy.hierarchy),
      windows: withoutVolatileTapLayoutFields(hierarchy.windows),
      packageName: hierarchy.packageName,
      foregroundActivity: hierarchy.foregroundActivity,
      screenWidth: hierarchy.screenWidth,
      screenHeight: hierarchy.screenHeight,
      pixelWidth: hierarchy.pixelWidth,
      pixelHeight: hierarchy.pixelHeight,
      nativeScale: hierarchy.nativeScale,
      rotation: hierarchy.rotation,
      systemInsets: hierarchy.systemInsets,
      insets: hierarchy.insets,
    },
  };
}

function hasSameTapTargetingLayout(previous: ObserveResult, refreshed: ObserveResult): boolean {
  const previousLayout = tapTargetingLayout(previous);
  const refreshedLayout = tapTargetingLayout(refreshed);
  return (
    previousLayout !== null &&
    refreshedLayout !== null &&
    isDeepStrictEqual(previousLayout, refreshedLayout)
  );
}

export interface TapAtCoordinateDependencies {
  timer?: Timer;
  androidClient?: CoordinateTapClient;
  iosClient?: CoordinateTapClient;
  dispatchAndroidCoordinateTap?: AndroidCoordinateTapDispatch;
  dispatchIosCoordinateTap?: IosCoordinateTapDispatch;
}

/** Tap one absolute point in the native coordinate space reported by observe. */
export class TapAtCoordinate extends BaseVisualChange {
  private readonly androidClient: CoordinateTapClient;
  private readonly iosClient: CoordinateTapClient;
  private readonly androidCoordinateTap: AndroidCoordinateTapDispatch;
  private readonly iosCoordinateTap: IosCoordinateTapDispatch;

  constructor(
    device: BootedDevice,
    adb: AdbExecutor | null = null,
    dependencies: TapAtCoordinateDependencies = {},
  ) {
    super(device, adb, dependencies.timer);
    this.androidClient =
      dependencies.androidClient ?? AndroidCtrlProxyClient.getInstance(device, this.adbFactory);
    this.iosClient = dependencies.iosClient ?? IOSCtrlProxyClient.getInstance(device);
    this.androidCoordinateTap =
      dependencies.dispatchAndroidCoordinateTap ?? dispatchAndroidCoordinateTap;
    this.iosCoordinateTap = dependencies.dispatchIosCoordinateTap ?? dispatchIosCoordinateTap;
  }

  async execute(
    options: TapAtOptions,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<TapAtResult> {
    const perf = createGlobalPerformanceTracker();
    perf.serial("tapAt");

    try {
      throwIfAborted(signal);
      return await this.observedInteraction(
        async () => {
          // This is deliberately not the cached observation used by other actions:
          // the point is validated against the current screen immediately before it
          // is sent to the native runner. Omitting skipWaitForFresh requests a fresh
          // full observation, which also supplies the optional frame-context token.
          const observeResult = await this.observeScreen.execute({ signal, perf });
          const resolved = this.resolveCoordinates(options, observeResult);
          if ("error" in resolved) {
            return { success: false, x: resolved.x, y: resolved.y, error: resolved.error };
          }

          const frameContext = observeResult.viewHierarchy?.frameContext;
          switch (this.device.platform) {
            case "android":
              await this.dispatchAndroidTapWithOneFreshRetry(
                options,
                resolved,
                observeResult,
                perf,
                signal,
              );
              break;
            case "ios":
              await this.iosCoordinateTap(
                this.iosClient,
                resolved.x,
                resolved.y,
                IOS_TAP_DURATION_MS,
                frameContext,
              );
              break;
            default:
              throw new ActionableError(`Unsupported platform: ${this.device.platform}`);
          }

          return { success: true, x: resolved.x, y: resolved.y };
        },
        {
          changeExpected: false,
          progress,
          perf,
          signal,
          // The authoritative pre-dispatch observation is the fresh observation
          // above; do not resolve a cached one first.
          skipPreviousObserve: true,
          predictionContext: {
            toolName: "tapAt",
            toolArgs: { x: options.x, y: options.y, platform: this.device.platform },
          },
        },
      );
    } catch (error) {
      return {
        success: false,
        x: this.device.platform === "android" ? Math.round(options.x) : options.x,
        y: this.device.platform === "android" ? Math.round(options.y) : options.y,
        error: `Failed to tap at coordinates: ${errorMessage(error)}`,
      };
    } finally {
      perf.end();
    }
  }

  private async dispatchAndroidTapWithOneFreshRetry(
    options: TapAtOptions,
    resolved: { x: number; y: number },
    observeResult: ObserveResult,
    perf: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<void> {
    const frameContext = observeResult.viewHierarchy?.frameContext;
    try {
      await this.androidCoordinateTap(
        this.androidClient,
        this.adb,
        resolved.x,
        resolved.y,
        ANDROID_TAP_DURATION_MS,
        frameContext,
        signal,
      );
      return;
    } catch (error) {
      const actionable = toActionableError(error, "Failed to dispatch Android coordinate tap");
      if (frameContext === undefined || !isStaleFrameContextRejection(actionable.message)) {
        throw actionable;
      }

      // One fresh capture distinguishes Android's benign generation churn from a layout-invalidating
      // advance. Any unprovable or changed targeting state preserves the original fail-closed error.
      throwIfAborted(signal);
      const refreshedObservation = await this.observeScreen.execute({ signal, perf });
      const refreshed = this.resolveCoordinates(options, refreshedObservation);
      const refreshedFrameContext = refreshedObservation.viewHierarchy?.frameContext;
      if (
        "error" in refreshed ||
        refreshed.x !== resolved.x ||
        refreshed.y !== resolved.y ||
        !hasSameTapTargetingLayout(observeResult, refreshedObservation) ||
        !refreshedFrameContext
      ) {
        throw actionable;
      }

      // Deliberately no loop: if this single retry also races a frame advance, its actionable stale
      // rejection escapes and the caller can choose a new point from another explicit observation.
      await this.androidCoordinateTap(
        this.androidClient,
        this.adb,
        refreshed.x,
        refreshed.y,
        ANDROID_TAP_DURATION_MS,
        refreshedFrameContext,
        signal,
      );
    }
  }

  private resolveCoordinates(
    options: TapAtOptions,
    observeResult: ObserveResult,
  ): { x: number; y: number } | { x: number; y: number; error: string } {
    const rawX = options.x;
    const rawY = options.y;
    if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) {
      return { x: rawX, y: rawY, error: "tapAt requires finite x and y coordinates" };
    }

    const screenSize = observeResult.screenSize;
    if (!hasPositiveScreenSize(screenSize)) {
      return {
        x: rawX,
        y: rawY,
        error: "tapAt requires a positive screenSize from a fresh observation",
      };
    }
    if (rawX < 0 || rawX >= screenSize.width || rawY < 0 || rawY >= screenSize.height) {
      return {
        x: rawX,
        y: rawY,
        error: `tapAt coordinates (${rawX}, ${rawY}) are outside screen bounds [0, ${screenSize.width}) x [0, ${screenSize.height})`,
      };
    }
    const x =
      this.device.platform === "android" ? Math.min(Math.round(rawX), screenSize.width - 1) : rawX;
    const y =
      this.device.platform === "android" ? Math.min(Math.round(rawY), screenSize.height - 1) : rawY;
    return { x, y };
  }
}

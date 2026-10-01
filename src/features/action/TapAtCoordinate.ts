import { ActionableError, unsupportedPlatformError } from "../../models/ActionableError";
import { isDeepStrictEqual } from "node:util";
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
import {
  createGlobalPerformanceTracker,
  type PerformanceTracker,
} from "../../utils/PerformanceTracker";
import type { Timer } from "../../utils/SystemTimer";
import { throwIfAborted } from "../../utils/toolUtils";
import { AndroidCtrlProxyClient } from "../observe/android";
import { IOSCtrlProxyClient } from "../observe/ios";
import { displayTransitions } from "../observe/DisplayTransition";
import { snapshotReferences, type SnapshotReferenceStore } from "../observe/SnapshotReferenceStore";
import { prepareTargetDisplayAction, type RenderedObservationReader } from "./TargetDisplayAction";
import { executeTouchscreenInput } from "./touchscreenInput";
import {
  BaseVisualChange,
  STALE_DISPLAY_COORDINATES_ERROR,
  type ProgressCallback,
  type RenderedDisplayRevisionReader,
} from "./BaseVisualChange";
import {
  type CoordinateTapClient,
  dispatchAndroidCoordinateTap,
  dispatchIosCoordinateTap,
  isStaleFrameContextRejection,
} from "./coordinateTapDispatch";

const ANDROID_TAP_DURATION_MS = 10;
const IOS_TAP_DURATION_MS = 50;
const DOUBLE_TAP_GAP_MS = 200;
const LONG_PRESS_DEFAULT_MS = 1000;
const LONG_PRESS_MIN_MS = 500;
const LONG_PRESS_MAX_MS = 10000;

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

function tapDurationMs(options: TapAtOptions, platform: BootedDevice["platform"]): number {
  if (options.action === "longPress") {
    return options.durationMs ?? LONG_PRESS_DEFAULT_MS;
  }
  return platform === "android" ? ANDROID_TAP_DURATION_MS : IOS_TAP_DURATION_MS;
}

function gestureOptionError(options: TapAtOptions): string | undefined {
  const { durationMs } = options;
  const action = options.action ?? "tap";
  if (action !== "tap" && action !== "longPress" && action !== "doubleTap") {
    return "tapAt action is unsupported";
  }
  if (
    durationMs !== undefined &&
    (action !== "longPress" ||
      !Number.isInteger(durationMs) ||
      durationMs < LONG_PRESS_MIN_MS ||
      durationMs > LONG_PRESS_MAX_MS)
  ) {
    return `tapAt durationMs requires longPress and must be ${LONG_PRESS_MIN_MS}–${LONG_PRESS_MAX_MS} ms`;
  }
  return undefined;
}

function coordinateOptionError(options: TapAtOptions): string | undefined {
  const { x, y } = options;
  const space = options.coordinateSpace ?? "absolute";
  if (space !== "absolute" && space !== "normalized" && space !== "percent") {
    return "tapAt coordinateSpace is unsupported";
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return "tapAt requires finite x and y coordinates";
  }
  const max = space === "normalized" ? 1 : space === "percent" ? 100 : undefined;
  if (max !== undefined && !axesWithinRange(x, y, max)) {
    return `tapAt ${space} coordinates must be between 0 and ${max}`;
  }
  return undefined;
}

function axesWithinRange(x: number, y: number, max: number): boolean {
  return x >= 0 && x <= max && y >= 0 && y <= max;
}

function resolveAxis(value: number, size: number, space: TapAtOptions["coordinateSpace"]): number {
  const max = space === "normalized" ? 1 : space === "percent" ? 100 : undefined;
  if (max === undefined) {
    return value;
  }
  return value === max ? size * (1 - Number.EPSILON) : (value / max) * size;
}

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

/** Shared native point resolution for coordinate dispatch and hierarchy preview. */
export function resolveTapAtCoordinates(
  options: TapAtOptions,
  observeResult: ObserveResult,
  platform: BootedDevice["platform"],
): { x: number; y: number } | { x: number; y: number; error: string } {
  const rawX = options.x;
  const rawY = options.y;
  const optionError = coordinateOptionError(options);
  if (optionError) {
    return { x: rawX, y: rawY, error: optionError };
  }
  const space = options.coordinateSpace ?? "absolute";

  const screenSize = observeResult.screenSize;
  if (!hasPositiveScreenSize(screenSize)) {
    return {
      x: rawX,
      y: rawY,
      error: "tapAt requires a positive screenSize from a fresh observation",
    };
  }
  const resolvedX = resolveAxis(rawX, screenSize.width, space);
  const resolvedY = resolveAxis(rawY, screenSize.height, space);
  if (
    resolvedX < 0 ||
    resolvedX >= screenSize.width ||
    resolvedY < 0 ||
    resolvedY >= screenSize.height
  ) {
    return {
      x: rawX,
      y: rawY,
      error: `tapAt coordinates (${rawX}, ${rawY}) are outside screen bounds [0, ${screenSize.width}) x [0, ${screenSize.height})`,
    };
  }
  const x =
    platform === "android"
      ? Math.min(Math.round(resolvedX), Math.ceil(screenSize.width) - 1)
      : resolvedX;
  const y =
    platform === "android"
      ? Math.min(Math.round(resolvedY), Math.ceil(screenSize.height) - 1)
      : resolvedY;
  return { x, y };
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

function hasTruncatedTapLayout(observation: ObserveResult): boolean {
  return Boolean(
    observation.truncationReasons?.length || observation.viewHierarchy?.truncationReasons?.length,
  );
}

function tapTargetingLayout(observation: ObserveResult): unknown | null {
  const rotation = observation.rotation ?? observation.viewHierarchy?.rotation;
  if (
    !Number.isInteger(rotation) ||
    !observation.viewHierarchy ||
    hasTruncatedTapLayout(observation)
  ) {
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
  renderedDisplayRevision?: RenderedDisplayRevisionReader;
  androidClient?: CoordinateTapClient;
  iosClient?: CoordinateTapClient;
  dispatchAndroidCoordinateTap?: AndroidCoordinateTapDispatch;
  dispatchIosCoordinateTap?: IosCoordinateTapDispatch;
  invalidateIosCache?: () => void;
  lastRenderedObservation?: RenderedObservationReader;
  snapshotReferences?: SnapshotReferenceStore;
}

/** Tap one absolute point in the native coordinate space reported by observe. */
export class TapAtCoordinate extends BaseVisualChange {
  private readonly androidClient: CoordinateTapClient;
  private readonly iosClient: CoordinateTapClient;
  private readonly androidCoordinateTap: AndroidCoordinateTapDispatch;
  private readonly iosCoordinateTap: IosCoordinateTapDispatch;
  private readonly invalidateIosCache: () => void;
  private readonly lastRenderedObservation?: RenderedObservationReader;
  private readonly snapshotReferences: SnapshotReferenceStore;

  constructor(
    device: BootedDevice,
    adb: AdbExecutor | null = null,
    dependencies: TapAtCoordinateDependencies = {},
  ) {
    super(device, adb, dependencies.timer, dependencies.renderedDisplayRevision);
    this.androidClient =
      dependencies.androidClient ?? AndroidCtrlProxyClient.getInstance(device, this.adbFactory);
    this.iosClient = dependencies.iosClient ?? IOSCtrlProxyClient.getInstance(device);
    this.androidCoordinateTap =
      dependencies.dispatchAndroidCoordinateTap ?? dispatchAndroidCoordinateTap;
    this.iosCoordinateTap = dependencies.dispatchIosCoordinateTap ?? dispatchIosCoordinateTap;
    this.invalidateIosCache =
      dependencies.invalidateIosCache ??
      (() => IOSCtrlProxyClient.getExistingInstance(this.device.deviceId)?.invalidateCache());
    this.lastRenderedObservation = dependencies.lastRenderedObservation;
    this.snapshotReferences = dependencies.snapshotReferences ?? snapshotReferences;
  }

  private async executeOnDisplay(
    options: TapAtOptions,
    display: string,
    signal?: AbortSignal,
  ): Promise<TapAtResult> {
    const { observation, displayId, assertCurrent } = await prepareTargetDisplayAction(
      this.device,
      display,
      this.observeScreen,
      this.adb,
      this.lastRenderedObservation,
      signal,
    );
    const stale = this.staleSnapshotReason(options, observation);
    if (stale) {
      return { success: false, x: options.x, y: options.y, error: stale };
    }
    const resolved = this.resolveCoordinates(options, observation);
    if ("error" in resolved) {
      return {
        success: false,
        x: resolved.x,
        y: resolved.y,
        action: options.action ?? "tap",
        error: resolved.error,
      };
    }
    assertCurrent();
    await this.dispatchGesture(options, resolved, observation, signal, displayId, assertCurrent);
    const after = await this.observeScreen.execute({
      display,
      freshness: "fresh",
      signal,
    });
    return {
      success: true,
      x: resolved.x,
      y: resolved.y,
      action: options.action ?? "tap",
      observation: after,
    };
  }

  async execute(
    options: TapAtOptions,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<TapAtResult> {
    const perf = createGlobalPerformanceTracker();
    perf.serial("tapAt");
    let dispatchedCoordinates: { x: number; y: number } | undefined;
    let iosDispatchTimestamp: number | undefined;
    const transitionRevision = displayTransitions.revision(this.device.deviceId);

    try {
      throwIfAborted(signal);
      if (options.display !== undefined) {
        return await this.executeOnDisplay(options, options.display, signal);
      }
      if (this.hasStaleCallerRevision(transitionRevision)) {
        return {
          success: false,
          x: options.x,
          y: options.y,
          error: STALE_DISPLAY_COORDINATES_ERROR,
        };
      }
      return await this.observedInteraction(
        async () => {
          // Validate against the latest available frame immediately before dispatch.
          // Observe defaults to skipWaitForFresh=true, so cache validity matters here.
          const observeResult = await this.observeScreen.execute({
            freshness: "cached-ok",
            signal,
            perf,
          });
          if (displayTransitions.revision(this.device.deviceId) !== transitionRevision) {
            return {
              success: false,
              x: options.x,
              y: options.y,
              error: STALE_DISPLAY_COORDINATES_ERROR,
            };
          }
          const stale = this.staleSnapshotReason(options, observeResult);
          if (stale) {
            return { success: false, x: options.x, y: options.y, error: stale };
          }
          const resolved = this.resolveCoordinates(options, observeResult);
          if ("error" in resolved) {
            return { success: false, x: resolved.x, y: resolved.y, error: resolved.error };
          }
          dispatchedCoordinates = resolved;

          const frameContext = observeResult.viewHierarchy?.frameContext;
          this.assertDisplayRevisionCurrent(transitionRevision);
          switch (this.device.platform) {
            case "android":
              if (options.snapshotId) {
                await this.androidCoordinateTap(
                  this.androidClient,
                  this.adb,
                  resolved.x,
                  resolved.y,
                  tapDurationMs(options, "android"),
                  frameContext,
                  signal,
                );
              } else {
                await this.dispatchAndroidTapWithOneFreshRetry(
                  options,
                  resolved,
                  observeResult,
                  transitionRevision,
                  perf,
                  signal,
                );
              }
              await this.dispatchSecondAndroidTap(
                options,
                resolved,
                frameContext,
                transitionRevision,
                signal,
              );
              break;
            case "ios":
              await this.iosCoordinateTap(
                this.iosClient,
                resolved.x,
                resolved.y,
                tapDurationMs(options, "ios"),
                frameContext,
              );
              await this.dispatchSecondIosTap(
                options,
                resolved,
                frameContext,
                transitionRevision,
                signal,
              );
              iosDispatchTimestamp = this.timer.now();
              this.invalidateIosCache();
              break;
            default:
              throw unsupportedPlatformError(this.device.platform, "tap at coordinates");
          }

          return { success: true, x: resolved.x, y: resolved.y, action: options.action ?? "tap" };
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
              x: options.x,
              y: options.y,
              action: options.action ?? "tap",
              platform: this.device.platform,
            },
          },
        },
      );
    } catch (error) {
      logger.warn(`tapAt dispatch failed: ${errorMessage(error)}`, error);
      return {
        success: false,
        x:
          dispatchedCoordinates?.x ??
          (this.device.platform === "android" ? Math.round(options.x) : options.x),
        y:
          dispatchedCoordinates?.y ??
          (this.device.platform === "android" ? Math.round(options.y) : options.y),
        error: `Failed to tap at coordinates: ${errorMessage(error)}`,
        action: options.action ?? "tap",
      };
    } finally {
      perf.end();
    }
  }

  private async dispatchAndroidTapWithOneFreshRetry(
    options: TapAtOptions,
    resolved: { x: number; y: number },
    observeResult: ObserveResult,
    transitionRevision: number,
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
        tapDurationMs(options, "android"),
        frameContext,
        signal,
      );
      return;
    } catch (error) {
      const actionable = toActionableError(error, "Failed to dispatch Android coordinate tap");
      if (frameContext === undefined || !isStaleFrameContextRejection(actionable.message)) {
        throw actionable;
      }

      // One re-observation distinguishes Android's benign generation churn from a layout-invalidating
      // advance. Any unprovable or changed targeting state preserves the original fail-closed error.
      throwIfAborted(signal);
      const refreshedObservation = await this.observeScreen.execute({
        freshness: "cached-ok",
        signal,
        perf,
      });
      this.assertDisplayRevisionCurrent(transitionRevision);
      const refreshed = this.resolveCoordinates(options, refreshedObservation);
      const refreshedFrameContext = refreshedObservation.viewHierarchy?.frameContext;
      if (
        "error" in refreshed ||
        refreshed.x !== resolved.x ||
        refreshed.y !== resolved.y ||
        !hasSameTapTargetingLayout(observeResult, refreshedObservation) ||
        !refreshedFrameContext ||
        refreshedFrameContext === frameContext
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
        tapDurationMs(options, "android"),
        refreshedFrameContext,
        signal,
      );
    }
  }

  private assertDisplayRevisionCurrent(revision: number): void {
    if (displayTransitions.revision(this.device.deviceId) !== revision) {
      throw new ActionableError(STALE_DISPLAY_COORDINATES_ERROR);
    }
  }

  private staleSnapshotReason(
    options: TapAtOptions,
    observation: ObserveResult,
  ): string | undefined {
    return options.snapshotId
      ? this.snapshotReferences.staleReason(options.snapshotId, this.device.deviceId, observation)
      : undefined;
  }

  private hasStaleCallerRevision(revision: number): boolean {
    const callerRevision = this.renderedDisplayRevision(this.device.deviceId);
    return callerRevision !== undefined && callerRevision !== revision;
  }

  private async dispatchSecondAndroidTap(
    options: TapAtOptions,
    point: { x: number; y: number },
    frameContext: string | undefined,
    revision: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (options.action !== "doubleTap") {
      return;
    }
    await this.timer.sleep(DOUBLE_TAP_GAP_MS);
    throwIfAborted(signal);
    this.assertDisplayRevisionCurrent(revision);
    await this.androidCoordinateTap(
      this.androidClient,
      this.adb,
      point.x,
      point.y,
      tapDurationMs(options, "android"),
      frameContext,
      signal,
    );
  }

  private async dispatchSecondIosTap(
    options: TapAtOptions,
    point: { x: number; y: number },
    frameContext: string | undefined,
    revision: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (options.action !== "doubleTap") {
      return;
    }
    await this.timer.sleep(DOUBLE_TAP_GAP_MS);
    throwIfAborted(signal);
    this.assertDisplayRevisionCurrent(revision);
    await this.iosCoordinateTap(
      this.iosClient,
      point.x,
      point.y,
      IOS_TAP_DURATION_MS,
      frameContext,
      "second tap",
    );
  }

  private resolveCoordinates(
    options: TapAtOptions,
    observeResult: ObserveResult,
  ): { x: number; y: number } | { x: number; y: number; error: string } {
    const gestureError = gestureOptionError(options);
    if (gestureError) {
      return { x: options.x, y: options.y, error: gestureError };
    }
    return resolveTapAtCoordinates(options, observeResult, this.device.platform);
  }

  private async dispatchGesture(
    options: TapAtOptions,
    point: { x: number; y: number },
    observation: ObserveResult,
    signal?: AbortSignal,
    displayId?: number,
    assertCurrent?: () => void,
  ): Promise<void> {
    const action = options.action ?? "tap";
    const duration = tapDurationMs(options, this.device.platform);
    const dispatch = async (second: boolean) => {
      throwIfAborted(signal);
      assertCurrent?.();
      if (this.device.platform === "android") {
        const command =
          action === "longPress"
            ? `swipe ${point.x} ${point.y} ${point.x} ${point.y} ${duration}`
            : `tap ${point.x} ${point.y}`;
        await executeTouchscreenInput(this.adb, command, displayId, signal);
      } else if (this.device.platform === "ios") {
        await this.iosCoordinateTap(
          this.iosClient,
          point.x,
          point.y,
          duration,
          observation.viewHierarchy?.frameContext,
          second ? "second tap" : "tap",
        );
      } else {
        throw unsupportedPlatformError(this.device.platform, "tapAt gesture");
      }
    };
    await dispatch(false);
    if (action === "doubleTap") {
      await this.timer.sleep(DOUBLE_TAP_GAP_MS);
      await dispatch(true);
    }
  }
}

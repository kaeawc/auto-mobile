import { normalizedAxis } from "./coordinateAxis";
import { resolveImageRelativePoint } from "./imageRelativePoint";
import {
  resolveCoordinateTapCtrlProxyTimeoutMs,
  resolveGestureCtrlProxyTimeoutMs,
} from "./gestureTransportTimeout";
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
import { awaitWhileRequestIsLive, throwIfAborted } from "../../utils/toolUtils";
import { AndroidCtrlProxyClient } from "../observe/android";
import { IOSCtrlProxyClient } from "../observe/ios";
import { withStaleDisplay } from "../../models/StaleDisplayError";
import { snapshotReferences, type SnapshotReferenceStore } from "../observe/SnapshotReferenceStore";
import { prepareTargetDisplayAction, type RenderedObservationReader } from "./TargetDisplayAction";
import { executeTouchscreenInput, supportsCtrlProxyGestureDisplay } from "./touchscreenInput";
import {
  BaseVisualChange,
  type DisplayFenceDependencies,
  type ProgressCallback,
} from "./BaseVisualChange";
import {
  type CoordinateTapClient,
  dispatchAndroidCoordinateTap,
  dispatchIosCoordinateTap,
  isStaleFrameContextRejection,
  indeterminateTapError,
} from "./coordinateTapDispatch";

import {
  DOUBLE_TAP_GAP_MS,
  LONG_PRESS_DEFAULT_MS,
  LONG_PRESS_MIN_MS,
  LONG_PRESS_MAX_MS,
} from "./tapAtGesture";

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

function partialDoubleTapNote(action: TapAtResult["action"], tapsDelivered: number): string {
  return action === "doubleTap" && tapsDelivered === 1
    ? " Double tap partially applied: one tap was delivered; the second tap was not confirmed. Do not retry automatically."
    : "";
}

function tapDeliveryReporter(onTapDelivered: () => void): () => void {
  let delivered = false;
  return () => {
    if (!delivered) {
      delivered = true;
      onTapDelivered();
    }
  };
}

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

function inputPoint(options: TapAtOptions): { x: number; y: number } {
  return options.image ?? { x: options.x, y: options.y };
}

function failurePoint(
  options: TapAtOptions,
  platform: BootedDevice["platform"],
): { x: number; y: number } {
  const point = inputPoint(options);
  return platform === "android" && !options.image
    ? { x: Math.round(point.x), y: Math.round(point.y) }
    : point;
}

function imageOptionError(options: TapAtOptions): string | undefined {
  return options.x !== undefined || options.y !== undefined || options.coordinateSpace !== undefined
    ? "tapAt image is mutually exclusive with x, y, and coordinateSpace"
    : undefined;
}

function coordinateOptionError(options: TapAtOptions): string | undefined {
  if (options.image !== undefined) {
    return imageOptionError(options);
  }
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
  return normalizedAxis(value / max, size);
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

/** Android rounds to integer raster pixels; keep crop endpoints on the final included pixel. */
function androidIntegerLimits(
  options: TapAtOptions,
  screenSize: ObserveResult["screenSize"],
): { width: number; height: number } {
  const source = options.image?.source;
  return source && "crop" in source
    ? { width: source.crop.rasterBounds.right, height: source.crop.rasterBounds.bottom }
    : screenSize;
}

/** Shared native point resolution for coordinate dispatch and hierarchy preview. */
export function resolveTapAtCoordinates(
  options: TapAtOptions,
  observeResult: ObserveResult,
  platform: BootedDevice["platform"],
): { x: number; y: number } | { x: number; y: number; error: string } {
  const { x: rawX, y: rawY } = inputPoint(options);
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
  const point = options.image
    ? resolveImageRelativePoint(options.image, platform === "ios" ? "ios" : "android", screenSize)
    : {
        x: resolveAxis(rawX, screenSize.width, space),
        y: resolveAxis(rawY, screenSize.height, space),
      };
  const { x: resolvedX, y: resolvedY } = point;
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
  const limits = androidIntegerLimits(options, screenSize);
  const x =
    platform === "android"
      ? Math.min(Math.round(resolvedX), Math.ceil(limits.width) - 1)
      : resolvedX;
  const y =
    platform === "android"
      ? Math.min(Math.round(resolvedY), Math.ceil(limits.height) - 1)
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

export interface TapAtCoordinateDependencies extends DisplayFenceDependencies {
  timer?: Timer;
  androidClient?: CoordinateTapClient & { supportsCommand?: (name: string) => Promise<boolean> };
  iosClient?: CoordinateTapClient;
  dispatchAndroidCoordinateTap?: AndroidCoordinateTapDispatch;
  dispatchIosCoordinateTap?: IosCoordinateTapDispatch;
  invalidateIosCache?: () => void;
  lastRenderedObservation?: RenderedObservationReader;
  snapshotReferences?: SnapshotReferenceStore;
}

/** Tap one absolute point in the native coordinate space reported by observe. */
export class TapAtCoordinate extends BaseVisualChange {
  private readonly androidClient: CoordinateTapClient<() => void> & {
    supportsCommand?: (name: string) => Promise<boolean>;
  };
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
    super(device, adb, dependencies.timer, dependencies.renderedDisplayRevision, dependencies);
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
    onTapDelivered: () => void,
    signal?: AbortSignal,
  ): Promise<TapAtResult> {
    const action = options.action ?? "tap";
    const { observation, displayId, assertCurrent } = await prepareTargetDisplayAction(
      this.device,
      display,
      this.observeScreen,
      this.adb,
      this.lastRenderedObservation,
      signal,
      this.displayTransitionReader,
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
    const resolved = this.resolveCoordinates(options, observation);
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
        await this.dispatchGesture(options, resolved, observation, signal, displayId, {
          assertCurrent,
          onTapDelivered,
        });
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

  async execute(
    options: TapAtOptions,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<TapAtResult> {
    const action = options.action ?? "tap";
    const perf = createGlobalPerformanceTracker();
    perf.serial("tapAt");
    let dispatchedCoordinates: { x: number; y: number } | undefined;
    let iosDispatchTimestamp: number | undefined;
    let tapsDelivered = 0;
    const onTapDelivered = () => {
      tapsDelivered++;
    };
    const transitionRevision = {
      revision: this.currentActionRevision(),
      // With no caller stamp, in-flight fences report the action-start identity generation.
      observedGeneration:
        this.renderedDisplayGeneration(this.device.deviceId) ??
        this.displayTransitionReader.identityRevision(this.device.deviceId),
    };

    try {
      throwIfAborted(signal);
      if (options.display !== undefined) {
        return await this.executeOnDisplay(options, options.display, onTapDelivered, signal);
      }
      if (
        this.hasStaleCallerRevision(this.displayTransitionReader.revision(this.device.deviceId))
      ) {
        return withStaleDisplay(
          { success: false, x: inputPoint(options).x, y: inputPoint(options).y, action },
          this.staleDisplay(transitionRevision.observedGeneration),
        );
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
          const resolved = this.resolveCoordinates(options, observeResult);
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

          const frameContext = observeResult.viewHierarchy?.frameContext;
          this.assertDisplayRevisionCurrent(transitionRevision);
          throwIfAborted(signal);
          switch (this.device.platform) {
            case "android":
              await this.dispatchAndroidTapWithOneFreshRetry(
                options,
                resolved,
                observeResult,
                transitionRevision,
                perf,
                { signal, onTapDelivered },
              );
              await this.dispatchSecondAndroidTap(options, resolved, transitionRevision, {
                signal,
                onTapDelivered,
              });
              break;
            case "ios":
              iosDispatchTimestamp = await this.dispatchIosTaps(
                options,
                resolved,
                frameContext,
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
    } catch (error) {
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
      result.error += partialDoubleTapNote(action, tapsDelivered);
      return result;
    } finally {
      perf.end();
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
    await this.iosCoordinateTap(
      this.iosClient,
      point.x,
      point.y,
      tapDurationMs(options, "ios"),
      frameContext,
    );
    onTapDelivered();
    try {
      throwIfAborted(signal);
      await this.dispatchSecondIosTap(options, point, transitionRevision, signal);
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

  private async dispatchAndroidTapWithOneFreshRetry(
    options: TapAtOptions,
    resolved: { x: number; y: number },
    observeResult: ObserveResult,
    transitionRevision: { revision: number; observedGeneration: number },
    perf: PerformanceTracker,
    context: { signal?: AbortSignal; onTapDelivered: () => void },
  ): Promise<void> {
    const { signal } = context;
    const frameContext = observeResult.viewHierarchy?.frameContext;
    try {
      await this.dispatchAndroidTap(
        resolved,
        tapDurationMs(options, "android"),
        frameContext,
        signal,
        {
          assertCurrent: () => this.assertDisplayRevisionCurrent(transitionRevision),
          onTapDelivered: context.onTapDelivered,
        },
      );
      return;
    } catch (error) {
      // Cancellation must escape before stale-frame classification or retry.
      throwIfAborted(signal);
      const actionable = toActionableError(error, "Failed to dispatch Android coordinate tap");
      if (frameContext === undefined || !isStaleFrameContextRejection(actionable.message)) {
        throw actionable;
      }

      // One re-observation distinguishes Android's benign generation churn from a layout-invalidating
      // advance. Any unprovable or changed targeting state preserves the original fail-closed error.
      throwIfAborted(signal);
      const refreshedObservation = await this.observeScreen.execute({
        freshness: this.retryFreshness(options),
        signal,
        perf,
      });
      this.assertDisplayRevisionCurrent(transitionRevision);
      this.assertSnapshotCurrent(options, refreshedObservation);
      const refreshed = this.resolveCoordinates(options, refreshedObservation);
      const refreshedFrameContext = refreshedObservation.viewHierarchy?.frameContext;
      if (
        "error" in refreshed ||
        refreshed.x !== resolved.x ||
        refreshed.y !== resolved.y ||
        !this.hasSafeRetryLayout(options, observeResult, refreshedObservation) ||
        !refreshedFrameContext ||
        refreshedFrameContext === frameContext
      ) {
        throw actionable;
      }

      // Deliberately no loop: if this single retry also races a frame advance, its actionable stale
      // rejection escapes and the caller can choose a new point from another explicit observation.
      await this.dispatchAndroidTap(
        refreshed,
        tapDurationMs(options, "android"),
        refreshedFrameContext,
        signal,
        {
          assertCurrent: () => this.assertDisplayRevisionCurrent(transitionRevision),
          onTapDelivered: context.onTapDelivered,
        },
      );
    }
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

  private hasSafeRetryLayout(
    options: TapAtOptions,
    initial: ObserveResult,
    refreshed: ObserveResult,
  ): boolean {
    return Boolean(options.snapshotId) || hasSameTapTargetingLayout(initial, refreshed);
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

  private async dispatchSecondAndroidTap(
    options: TapAtOptions,
    point: { x: number; y: number },
    revision: { revision: number; observedGeneration: number },
    context: { signal?: AbortSignal; onTapDelivered: () => void },
  ): Promise<void> {
    const { signal } = context;
    if (options.action !== "doubleTap") {
      return;
    }
    await awaitWhileRequestIsLive(this.timer.sleep(DOUBLE_TAP_GAP_MS), signal);
    throwIfAborted(signal);
    this.assertDisplayRevisionCurrent(revision);
    await this.dispatchAndroidTap(
      point,
      tapDurationMs(options, "android"),
      // The accepted first tap fixed the point for this gesture; it may have advanced the frame.
      undefined,
      signal,
      {
        assertCurrent: () => this.assertDisplayRevisionCurrent(revision),
        onTapDelivered: context.onTapDelivered,
      },
    );
  }

  private async dispatchAndroidTap(
    point: { x: number; y: number },
    duration: number,
    frameContext: string | undefined,
    signal: AbortSignal | undefined,
    context: { assertCurrent: () => void; onTapDelivered: () => void },
  ): Promise<void> {
    const reportDelivery = tapDeliveryReporter(context.onTapDelivered);
    await this.androidCoordinateTap(
      this.androidClient,
      this.adb,
      point.x,
      point.y,
      duration,
      frameContext,
      signal,
      context.assertCurrent,
      reportDelivery,
    );
    // Legacy injected dispatchers confirm delivery by returning, without invoking the new hook.
    reportDelivery();
    throwIfAborted(signal);
  }

  private async dispatchSecondIosTap(
    options: TapAtOptions,
    point: { x: number; y: number },
    revision: { revision: number; observedGeneration: number },
    signal?: AbortSignal,
  ): Promise<void> {
    if (options.action !== "doubleTap") {
      return;
    }
    await awaitWhileRequestIsLive(this.timer.sleep(DOUBLE_TAP_GAP_MS), signal);
    throwIfAborted(signal);
    this.assertDisplayRevisionCurrent(revision);
    await this.iosCoordinateTap(
      this.iosClient,
      point.x,
      point.y,
      IOS_TAP_DURATION_MS,
      undefined,
      "second tap",
    );
  }

  private resolveCoordinates(
    options: TapAtOptions,
    observeResult: ObserveResult,
  ): { x: number; y: number } | { x: number; y: number; error: string } {
    const gestureError = gestureOptionError(options);
    if (gestureError) {
      return { x: inputPoint(options).x, y: inputPoint(options).y, error: gestureError };
    }
    return resolveTapAtCoordinates(options, observeResult, this.device.platform);
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
      const result = await this.androidClient.requestTapCoordinates(
        point.x,
        point.y,
        duration,
        resolveCoordinateTapCtrlProxyTimeoutMs(duration),
        undefined,
        undefined,
        onDispatch,
        signal,
        displayId === 0 ? undefined : displayId,
        context.assertCurrent,
      );
      if (result.success) {
        context.onTapDelivered();
      }
      throwIfAborted(signal);
      if (!result.success) {
        if (dispatched) {
          throw indeterminateTapError(result.error);
        }
        throw new ActionableError(result.error ?? "Android tap failed");
      }
    } else {
      throwIfAborted(signal);
      context.assertCurrent();
      await executeTouchscreenInput(this.adb, command, displayId, signal, context.assertCurrent, {
        timeoutMs:
          duration >= LONG_PRESS_MIN_MS ? resolveGestureCtrlProxyTimeoutMs(duration) : undefined,
      });
      context.onTapDelivered();
      throwIfAborted(signal);
    }
  }

  private async dispatchGesture(
    options: TapAtOptions,
    point: { x: number; y: number },
    observation: ObserveResult,
    signal: AbortSignal | undefined,
    displayId: number | undefined,
    context: { assertCurrent: () => void; onTapDelivered: () => void },
  ): Promise<void> {
    const action = options.action ?? "tap";
    const duration = tapDurationMs(options, this.device.platform);
    const dispatch = async (second: boolean) => {
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
        await this.iosCoordinateTap(
          this.iosClient,
          point.x,
          point.y,
          duration,
          second ? undefined : observation.viewHierarchy?.frameContext,
          second ? "second tap" : "tap",
        );
        context.onTapDelivered();
      } else {
        throw unsupportedPlatformError(this.device.platform, "tapAt gesture");
      }
    };
    await dispatch(false);
    if (this.device.platform === "ios") {
      try {
        throwIfAborted(signal);
        if (action === "doubleTap") {
          await awaitWhileRequestIsLive(this.timer.sleep(DOUBLE_TAP_GAP_MS), signal);
          await dispatch(true);
        }
        throwIfAborted(signal);
      } finally {
        this.invalidateIosCacheSafely();
      }
      return;
    }
    if (action === "doubleTap") {
      await awaitWhileRequestIsLive(this.timer.sleep(DOUBLE_TAP_GAP_MS), signal);
      await dispatch(true);
    }
  }
}

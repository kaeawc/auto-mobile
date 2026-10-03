import { resolveGestureCtrlProxyTimeoutMs } from "./gestureTransportTimeout";
import { supportsCtrlProxyGestureDisplay } from "./touchscreenInput";
import { resolveIosObserveRotation } from "../observe/iosObserveRotation";
import type { Timer } from "../../utils/SystemTimer";
import { logger } from "../../utils/logger";
import type { DisplayFenceDependencies } from "./BaseVisualChange";
import { withStaleDisplay, StaleDisplayError } from "../../models/StaleDisplayError";
import { unsupportedPlatformError } from "../../models/ActionableError";
import { errorMessage } from "../../utils/describeUnknownError";
import { awaitWhileRequestIsLive, throwIfAborted } from "../../utils/toolUtils";
import { BaseVisualChange, ProgressCallback } from "./BaseVisualChange";
import { prepareTargetDisplayAction, type RenderedObservationReader } from "./TargetDisplayAction";
import {
  ActionableError,
  BootedDevice,
  Element,
  ObserveResult,
  PinchOnOptions,
  PinchOnResult,
} from "../../models";
import { AdbClient } from "../../utils/android-cmdline-tools/AdbClient";
import { ElementResolver } from "../utility/ElementResolver";
import {
  identifyObservedHierarchy,
  type HierarchyCapture,
  type HierarchySnapshot,
} from "../observe/HierarchyCapture";
import { extractHierarchyScreenSize } from "../observe/hierarchyScreenSize";
import { createDeviceHierarchyCapture } from "../observe/DeviceHierarchyCapture";
import { AndroidCtrlProxyClient } from "../observe/android";
import { IOSCtrlProxyClient } from "../observe/ios";
import { serverConfig } from "../../utils/ServerConfig";
import { AndroidCtrlProxyManager } from "../../ctrlProxy/CtrlProxyManager";
import { createGlobalPerformanceTracker } from "../../utils/PerformanceTracker";
import { boundsArea, clamp } from "../../utils/bounds";
import { buildContainerFromElement, isTruthyFlag } from "../utility/elementProperties";
import { getScreenBounds as getScreenBoundsFromSize } from "../../utils/screenBounds";
import {
  DEFAULT_VISION_CONFIG,
  getVisionEnrichedError,
  type VisionFallbackConfig,
  type VisionAnalyzer,
} from "../../vision/index";
import {
  TakeScreenshotCapturer,
  type ScreenshotCapturer,
} from "../navigation/SelectionStateTracker";

export const PINCH_DURATION_MIN_MS = 1;
export const PINCH_DURATION_MAX_MS = 10000;

export const PINCH_DISTANCE_EXCLUSIVE_MIN = 0;
export const PINCH_SCALE_EXCLUSIVE_MIN = 0;

type PinchTarget = {
  bounds: Element["bounds"];
  targetType: "screen" | "container";
  container?: PinchOnOptions["container"];
  warning?: string;
};

interface PinchOnDependencies extends DisplayFenceDependencies {
  timer?: Timer;
  lastRenderedObservation?: RenderedObservationReader;
  resolver?: Pick<ElementResolver, "resolve">;
  capture?: HierarchyCapture;
  visionConfig?: VisionFallbackConfig;
  screenshotCapturer?: ScreenshotCapturer;
  visionAnalyzer?: VisionAnalyzer;
}

export function scorePinchElement(element: Element, screenArea: number): number {
  const area = boundsArea(element.bounds);
  let score = area;
  if (isTruthyFlag(element.clickable)) {
    score *= 1.15;
  }
  if (isTruthyFlag(element.scrollable)) {
    score *= 0.9;
  }
  if (area / screenArea >= 0.5) {
    score *= 1.2;
  }
  return score;
}

export function isLikelyBottomSheet(element: Element, screenBounds: Element["bounds"]): boolean {
  const height = Math.max(0, element.bounds.bottom - element.bounds.top);
  const screenHeight = Math.max(1, screenBounds.bottom - screenBounds.top);
  const bottomAligned = element.bounds.bottom >= screenBounds.bottom - screenHeight * 0.05;
  const shorterThanScreen = height <= screenHeight * 0.65;
  const scrollable = isTruthyFlag(element.scrollable);
  const className = element["class"]?.toLowerCase() ?? "";
  const classSuggestsSheet = className.includes("bottomsheet") || className.includes("sheet");
  return (
    (scrollable && bottomAligned && shorterThanScreen) || (classSuggestsSheet && bottomAligned)
  );
}

export class PinchOn extends BaseVisualChange {
  private readonly lastRenderedObservation?: RenderedObservationReader;
  private readonly resolver: Pick<ElementResolver, "resolve">;
  private readonly capture: HierarchyCapture;
  private visionConfig: VisionFallbackConfig;
  private screenshotCapturer: ScreenshotCapturer;
  private visionAnalyzer: VisionAnalyzer | undefined;

  constructor(device: BootedDevice, adb: AdbClient | null = null, deps: PinchOnDependencies = {}) {
    super(device, adb, deps.timer, deps.renderedDisplayRevision, deps);
    this.lastRenderedObservation = deps.lastRenderedObservation;
    this.resolver = deps.resolver ?? new ElementResolver();
    this.capture =
      deps.capture ?? createDeviceHierarchyCapture(device, { adbFactory: this.adbFactory });
    this.visionConfig = deps.visionConfig ?? DEFAULT_VISION_CONFIG;
    this.screenshotCapturer =
      deps.screenshotCapturer ?? new TakeScreenshotCapturer(device, this.adbFactory);
    this.visionAnalyzer = deps.visionAnalyzer;
  }

  private createErrorResult(error: string, options: Partial<PinchOnOptions>): PinchOnResult {
    return {
      success: false,
      direction: options.direction ?? "in",
      distanceStart: options.distanceStart ?? 0,
      distanceEnd: options.distanceEnd ?? 0,
      duration: options.duration ?? 0,
      scale: options.scale,
      rotationDegrees: options.rotationDegrees,
      centerX: 0,
      centerY: 0,
      targetType: "screen",
      container: options.container,
      error,
    };
  }

  async execute(
    options: PinchOnOptions,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<PinchOnResult> {
    throwIfAborted(signal);
    if (
      options.duration !== undefined &&
      (!Number.isInteger(options.duration) ||
        options.duration < PINCH_DURATION_MIN_MS ||
        options.duration > PINCH_DURATION_MAX_MS)
    ) {
      throw new ActionableError(
        `pinchOn duration must be an integer from ${PINCH_DURATION_MIN_MS} to ${PINCH_DURATION_MAX_MS} ms`,
      );
    }
    let displayTarget: Awaited<ReturnType<typeof prepareTargetDisplayAction>> | undefined;
    if (options.display !== undefined) {
      try {
        displayTarget = await this.prepareDisplayTarget(options, signal);
      } catch (error) {
        logger.warn(`Pinch display routing failed: ${errorMessage(error)}`, error);
        throwIfAborted(signal);
        return withStaleDisplay(this.createErrorResult(errorMessage(error), options), error);
      }
    }
    const perf = createGlobalPerformanceTracker();
    perf.serial("pinchOn");

    if (!options.direction) {
      perf.end();
      return this.createErrorResult("Pinch direction is required ('in' or 'out')", options);
    }

    if (this.device.platform !== "android" && this.device.platform !== "ios") {
      perf.end();
      return this.createErrorResult(
        unsupportedPlatformError(this.device.platform, "pinch on elements").message,
        options,
      );
    }

    if (options.scale !== undefined && options.scale <= PINCH_SCALE_EXCLUSIVE_MIN) {
      perf.end();
      return this.createErrorResult("scale must be greater than 0", options);
    }

    if (
      options.distanceStart !== undefined &&
      options.distanceStart <= PINCH_DISTANCE_EXCLUSIVE_MIN
    ) {
      perf.end();
      return this.createErrorResult("distanceStart must be greater than 0", options);
    }

    if (options.distanceEnd !== undefined && options.distanceEnd <= PINCH_DISTANCE_EXCLUSIVE_MIN) {
      perf.end();
      return this.createErrorResult("distanceEnd must be greater than 0", options);
    }

    if (options.container) {
      const selectorCount = [options.container.elementId, options.container.text].filter(
        Boolean,
      ).length;
      if (selectorCount !== 1) {
        perf.end();
        return this.createErrorResult(
          "pinchOn container must specify exactly one of elementId or text",
          options,
        );
      }
    }

    if (this.device.platform === "android") {
      throwIfAborted(signal);
      const a11yManager = AndroidCtrlProxyManager.getInstance(this.device, this.adb);
      const available = await perf.track("a11yAvailable", () => a11yManager.isAvailable());
      throwIfAborted(signal);
      if (!available) {
        perf.end();
        return this.createErrorResult(
          "pinchOn requires the AutoMobile accessibility service to be installed and enabled.",
          options,
        );
      }
    }

    try {
      const fence = options.display === undefined ? this.captureDisplayFence() : undefined;
      const target = await perf.track("resolveTarget", () =>
        this.resolveTarget(options, signal, displayTarget?.observation),
      );
      const { centerX, centerY } = this.getCenter(target.bounds);
      let { distanceStart, distanceEnd, scale } = this.resolveDistances(options, target.bounds);
      if (this.device.platform === "ios") {
        distanceStart = Math.round(distanceStart);
        distanceEnd = Math.round(distanceEnd);
        scale = distanceStart > 0 ? distanceEnd / distanceStart : scale;
      }
      const duration = options.duration ?? 300;
      const rotationDegrees = options.rotationDegrees ?? 0;
      let iosDispatchTimestamp: number | undefined;

      const dispatchAndroidPinch = async () => {
        throwIfAborted(signal);
        displayTarget?.assertCurrent();
        // Once beforeSend lands, also pass this as the dispatch's beforeSend.
        fence?.assertCurrent();
        const result = await awaitWhileRequestIsLive(
          AndroidCtrlProxyClient.getInstance(this.device, this.adbFactory).requestPinch(
            centerX,
            centerY,
            distanceStart,
            distanceEnd,
            rotationDegrees,
            duration,
            resolveGestureCtrlProxyTimeoutMs(duration),
            perf,
            signal,
            displayTarget?.displayId === 0 ? undefined : displayTarget?.displayId,
            displayTarget?.assertCurrent,
          ),
          signal,
        );
        throwIfAborted(signal);
        displayTarget?.assertCurrent();
        return result;
      };
      const pinchResult = await this.observedInteraction(
        async () => {
          throwIfAborted(signal);
          if (this.device.platform === "ios") {
            // Once beforeSend lands, also pass this as the dispatch's beforeSend.
            fence?.assertCurrent();
            const result = await awaitWhileRequestIsLive(
              IOSCtrlProxyClient.getInstance(this.device).requestPinch(
                centerX,
                centerY,
                distanceStart,
                distanceEnd,
                rotationDegrees,
                duration,
                resolveGestureCtrlProxyTimeoutMs(duration),
                perf,
              ),
              signal,
            );
            throwIfAborted(signal);
            if (result.success) {
              iosDispatchTimestamp = this.timer.now();
              IOSCtrlProxyClient.getExistingInstance(this.device.deviceId)?.invalidateCache();
            }
            return result;
          }

          return dispatchAndroidPinch();
        },
        {
          changeExpected: false,
          display: options.display,
          timeoutMs: 8000,
          progress,
          perf,
          signal,
          observationTimestampProvider: () => iosDispatchTimestamp,
          predictionContext: {
            toolName: "pinchOn",
            toolArgs: {
              ...options,
              centerX,
              centerY,
              distanceStart,
              distanceEnd,
              rotationDegrees,
              duration,
            },
          },
        },
      );
      throwIfAborted(signal);

      perf.end();
      if (!pinchResult.success) {
        return {
          success: false,
          direction: options.direction,
          distanceStart,
          distanceEnd,
          scale,
          duration,
          rotationDegrees,
          centerX,
          centerY,
          targetType: target.targetType,
          container: target.container,
          warning: target.warning,
          observation: pinchResult.observation,
          // sendCommand's timeout result means dispatch completed without a confirmed reply.
          error: pinchResult.error?.startsWith("Pinch timed out after ")
            ? `Pinch outcome is indeterminate: the request was dispatched but no result was confirmed (${pinchResult.error}). Do not retry automatically.`
            : pinchResult.error,
        };
      }

      // iOS may fall back to the public element-anchored pinch when the private
      // XCTest event-synthesis symbols are unavailable; that path zooms from the
      // screen center and ignores the requested centerX/centerY (and rotation).
      // Surface it so callers know the center was not honored (#2910).
      const fallbackWarning =
        pinchResult.pinchPath === "element-anchored"
          ? "pinchOn used the iOS public element-anchored fallback; the gesture zoomed from the screen center and did not honor the requested center/rotation."
          : undefined;
      const warning = [target.warning, fallbackWarning].filter(Boolean).join(" ") || undefined;

      return {
        success: true,
        direction: options.direction,
        distanceStart,
        distanceEnd,
        scale,
        duration,
        rotationDegrees,
        centerX,
        centerY,
        targetType: target.targetType,
        container: target.container,
        warning,
        observation: pinchResult.observation,
        a11yTotalTimeMs: pinchResult.totalTimeMs,
        a11yGestureTimeMs: pinchResult.gestureTimeMs,
      };
    } catch (error) {
      perf.end();
      throwIfAborted(signal);
      logger.warn(`Pinch failed: ${errorMessage(error)}`, error);
      if (error instanceof StaleDisplayError) {
        return withStaleDisplay(this.createErrorResult(error.message, options), error);
      }
      const baseErrorMessage = errorMessage(error);
      let finalErrorMessage = `Failed to perform pinch: ${baseErrorMessage}`;

      if (this.visionConfig.enabled && options.container) {
        throwIfAborted(signal);
        const searchCriteria = {
          text: options.container.text,
          resourceId: options.container.elementId,
          description: "Container element for pinching",
        };
        const cachedObserve = await this.observeScreen.getMostRecentCachedObserveResult();
        const viewHierarchy = cachedObserve?.viewHierarchy ?? null;
        finalErrorMessage = await getVisionEnrichedError(
          this.screenshotCapturer,
          viewHierarchy,
          searchCriteria,
          this.visionConfig,
          finalErrorMessage,
          undefined,
          this.visionAnalyzer,
        );
      }

      return this.createErrorResult(finalErrorMessage, options);
    }
  }

  private async prepareDisplayTarget(options: PinchOnOptions, signal?: AbortSignal) {
    const prepared = await prepareTargetDisplayAction(
      this.device,
      options.display!,
      this.observeScreen,
      this.adb,
      this.lastRenderedObservation,
      signal,
      this.displayTransitionReader,
    );

    throwIfAborted(signal);
    if (this.device.platform !== "android") {
      return undefined;
    }
    const client = AndroidCtrlProxyClient.getInstance(this.device, this.adbFactory);
    const supported = await supportsCtrlProxyGestureDisplay(client, prepared.displayId);
    throwIfAborted(signal);
    prepared.assertCurrent();
    if (!supported) {
      throw new ActionableError(
        "Android CtrlProxy does not expose per-display pinch dispatch; a targeted two-finger gesture requires CtrlProxy displayId support.",
      );
    }
    return prepared;
  }

  private async resolveTarget(
    options: PinchOnOptions,
    signal?: AbortSignal,
    displayObservation?: ObserveResult,
  ): Promise<PinchTarget> {
    const { observeResult, snapshot } = await this.pinchTargetHierarchy(signal, displayObservation);

    const screenBounds = this.getScreenBounds(observeResult, options.includeSystemInsets);

    if (options.container) {
      const containerElement = this.findContainerElement(options.container, snapshot);
      if (!containerElement) {
        throw new ActionableError("Container element not found for pinchOn");
      }
      return {
        bounds: containerElement.bounds,
        targetType: "container",
        container: options.container,
      };
    }

    if (options.autoTarget !== false) {
      const autoTarget = this.selectAutoTargetElement(snapshot, screenBounds);
      if (autoTarget) {
        const container = buildContainerFromElement(autoTarget);
        return {
          bounds: autoTarget.bounds,
          targetType: "container",
          container: container ?? undefined,
          warning: container
            ? undefined
            : "Auto-targeted element lacks a usable identifier; pinching within its bounds without container metadata.",
        };
      }
    }

    return {
      bounds: screenBounds,
      targetType: "screen",
    };
  }

  private async pinchTargetHierarchy(signal?: AbortSignal, displayObservation?: ObserveResult) {
    throwIfAborted(signal);
    let observeResult =
      displayObservation ?? (await this.observeScreen.getMostRecentCachedObserveResult());
    if (!observeResult.viewHierarchy || observeResult.viewHierarchy.hierarchy?.error) {
      if (displayObservation) {
        throw new ActionableError("Selected display has no usable view hierarchy");
      }
      throwIfAborted(signal);
      observeResult = await this.observeScreen.execute({ freshness: "cached-ok", signal });
    }

    throwIfAborted(signal);
    const snapshot = displayObservation?.viewHierarchy
      ? identifyObservedHierarchy("android", displayObservation.viewHierarchy, "fresh", this.timer)
      : await this.capture.capture({
          freshness: "fresh",
          searchRaw: serverConfig.isRawElementSearchEnabled(),
          signal,
        });
    if (!displayObservation) {
      observeResult = this.withCaptureGeometry(observeResult, snapshot);
    }

    if (!observeResult.viewHierarchy || !observeResult.screenSize) {
      throw new ActionableError("Unable to resolve target without a view hierarchy");
    }

    return { observeResult, snapshot };
  }

  private withCaptureGeometry(
    observeResult: ObserveResult,
    snapshot: HierarchySnapshot,
  ): ObserveResult {
    const freshSize =
      extractHierarchyScreenSize(snapshot.hierarchy) ??
      (snapshot.hierarchy.screenWidth && snapshot.hierarchy.screenHeight
        ? { width: snapshot.hierarchy.screenWidth, height: snapshot.hierarchy.screenHeight }
        : observeResult.screenSize);
    const sameSize =
      freshSize?.width === observeResult.screenSize?.width &&
      freshSize?.height === observeResult.screenSize?.height;
    return {
      ...observeResult,
      viewHierarchy: snapshot.hierarchy,
      screenSize: freshSize,
      ...(this.device.platform === "ios"
        ? { rotation: resolveIosObserveRotation(snapshot.hierarchy.rotation, freshSize) }
        : {}),
      // Insets belong to a coordinate space: never apply portrait edges to a
      // fresh landscape capture when the runner did not supply rotated insets.
      systemInsets:
        snapshot.hierarchy.systemInsets ??
        (sameSize ? observeResult.systemInsets : { top: 0, bottom: 0, left: 0, right: 0 }),
    };
  }

  private findContainerElement(
    container: PinchOnOptions["container"],
    snapshot: HierarchySnapshot,
  ): Element | null {
    if (!container) {
      return null;
    }

    const resolution = this.resolver.resolve(
      { id: snapshot.captureId, nodes: snapshot.nodes },
      container,
      { action: "inspect" },
    );
    if (resolution.error) {
      throw new ActionableError(resolution.error);
    }
    const source = container.text
      ? resolution.matches.find(({ node }) => node === resolution.chosen)?.sourceNodes?.[0]
      : undefined;
    return (source ?? resolution.chosen)?.element ?? null;
  }

  private selectAutoTargetElement(
    snapshot: HierarchySnapshot,
    screenBounds: Element["bounds"],
  ): Element | null {
    const screenWidth = Math.max(1, screenBounds.right - screenBounds.left);
    const screenHeight = Math.max(1, screenBounds.bottom - screenBounds.top);
    const screenArea = screenWidth * screenHeight;

    const candidates = new Map<string, Element>();
    const windowRanks = new Map<Element, number>();
    const addCandidate = (element: Element, rank: number) => {
      if (!element.bounds) {
        return;
      }
      const area = boundsArea(element.bounds);
      if (area <= 0) {
        return;
      }
      const key = `${element.bounds.left},${element.bounds.top},${element.bounds.right},${element.bounds.bottom}|${element["resource-id"] ?? ""}|${element.text ?? ""}|${element["content-desc"] ?? ""}`;
      if (!candidates.has(key)) {
        candidates.set(key, element);
        windowRanks.set(element, rank);
      }
    };

    const entries = this.resolver.resolve(
      { id: snapshot.captureId, nodes: snapshot.nodes },
      {},
      { action: "inspect" },
    ).candidates;
    for (const entry of entries) {
      const element = entry.element;
      if (
        element &&
        (entry.affordances.includes("scroll") ||
          entry.affordances.includes("tap") ||
          boundsArea(element.bounds) / screenArea >= 0.15)
      ) {
        addCandidate(element, entry.windowRank);
      }
    }

    let best: { element: Element; score: number; windowRank: number } | null = null;
    for (const element of candidates.values()) {
      if (!this.boundsWithinScreen(element.bounds, screenBounds)) {
        continue;
      }
      const area = boundsArea(element.bounds);
      if (area <= 0) {
        continue;
      }
      let score = scorePinchElement(element, screenArea);
      if (isLikelyBottomSheet(element, screenBounds)) {
        score *= 0.2;
      }

      const windowRank = windowRanks.get(element) ?? 0;
      if (!best || score > best.score || (score === best.score && windowRank < best.windowRank)) {
        best = { element, score, windowRank };
      }
    }

    return best?.element ?? null;
  }

  private resolveDistances(
    options: PinchOnOptions,
    bounds: Element["bounds"],
  ): { distanceStart: number; distanceEnd: number; scale?: number } {
    const width = Math.max(1, bounds.right - bounds.left);
    const height = Math.max(1, bounds.bottom - bounds.top);
    const minDimension = Math.min(width, height);

    const maxDistance = minDimension * 0.9;
    const minDistance = Math.max(10, minDimension * 0.1);

    let distanceStart = options.distanceStart ?? null;
    let distanceEnd = options.distanceEnd ?? null;

    if (options.scale !== undefined && options.scale > 0) {
      if (distanceStart === null && distanceEnd !== null) {
        distanceStart = distanceEnd / options.scale;
      } else if (distanceEnd === null && distanceStart !== null) {
        distanceEnd = distanceStart * options.scale;
      } else if (distanceStart === null && distanceEnd === null) {
        distanceStart = minDimension * 0.25;
        distanceEnd = distanceStart * options.scale;
      }
    }

    if (distanceStart === null || distanceEnd === null) {
      if (options.direction === "out") {
        distanceStart = distanceStart ?? minDimension * 0.2;
        distanceEnd = distanceEnd ?? minDimension * 0.6;
      } else {
        distanceStart = distanceStart ?? minDimension * 0.6;
        distanceEnd = distanceEnd ?? minDimension * 0.2;
      }
    }

    if (options.direction === "out" && distanceEnd <= distanceStart) {
      distanceEnd = Math.min(maxDistance, distanceStart * 1.5);
    }

    if (options.direction === "in" && distanceStart <= distanceEnd) {
      distanceStart = Math.min(maxDistance, distanceEnd * 1.5);
    }

    distanceStart = clamp(distanceStart, minDistance, maxDistance);
    distanceEnd = clamp(distanceEnd, minDistance, maxDistance);

    const scale = distanceStart > 0 ? distanceEnd / distanceStart : undefined;
    return { distanceStart, distanceEnd, scale };
  }

  private getScreenBounds(
    observeResult: ObserveResult,
    includeSystemInsets?: boolean,
  ): Element["bounds"] {
    if (!observeResult.screenSize) {
      throw new ActionableError("Could not determine screen size");
    }

    return getScreenBoundsFromSize(
      observeResult.screenSize,
      observeResult.systemInsets,
      includeSystemInsets,
    );
  }

  private getCenter(bounds: Element["bounds"]): { centerX: number; centerY: number } {
    const centerX = Math.round((bounds.left + bounds.right) / 2);
    const centerY = Math.round((bounds.top + bounds.bottom) / 2);
    return { centerX, centerY };
  }

  private boundsWithinScreen(bounds: Element["bounds"], screenBounds: Element["bounds"]): boolean {
    return (
      bounds.right > screenBounds.left &&
      bounds.left < screenBounds.right &&
      bounds.bottom > screenBounds.top &&
      bounds.top < screenBounds.bottom
    );
  }
}

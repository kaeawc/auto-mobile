import { inputDurationArgument } from "./touchscreenInput";
import type { ScreenSizeForOffscreenCheckOptions } from "../../models/ScreenSize";
import type { DragAndDropTarget } from "../../models/DragAndDropOptions";
import type { DisplayFenceDependencies } from "./BaseVisualChange";
import { withStaleDisplay, StaleDisplayError } from "../../models/StaleDisplayError";
import { errorMessage } from "../../utils/describeUnknownError";
import { BaseVisualChange, ProgressCallback } from "./BaseVisualChange";
import {
  ActionableError,
  BootedDevice,
  DragAndDropOptions,
  DragAndDropResult,
  ObserveResult,
  ViewHierarchyResult,
} from "../../models";
import type { ElementSelector } from "../../utils/interfaces/ElementSelector";
import type { HierarchyCapture } from "../observe/HierarchyCapture";
import { createDeviceHierarchyCapture } from "../observe/DeviceHierarchyCapture";
import { ResolverElementSelector } from "../utility/ResolverElementSelector";
import type { ElementGeometry } from "../../utils/interfaces/ElementGeometry";
import { DefaultElementGeometry } from "../utility/ElementGeometry";
import { AndroidCtrlProxyClient } from "../observe/android";
import { IOSCtrlProxyClient } from "../observe/ios";
import {
  createGlobalPerformanceTracker,
  type PerformanceTracker,
} from "../../utils/PerformanceTracker";
import { awaitWhileRequestIsLive, throwIfAborted } from "../../utils/toolUtils";
import { combineWithAmbientAbort } from "../../utils/AbortContext";
import { DEFAULT_GESTURE_REQUEST_TIMEOUT_MS } from "../observe/shared/SharedGestureDelegate";
import { LONG_PRESS_TIMEOUT_HEADROOM_MS } from "./gestureTransportTimeout";
import { AndroidCtrlProxyManager } from "../../ctrlProxy/CtrlProxyManager";
import { AdbClient } from "../../utils/android-cmdline-tools/AdbClient";
import { Timer, defaultTimer } from "../../utils/SystemTimer";
import { prepareTargetDisplayAction, type RenderedObservationReader } from "./TargetDisplayAction";
import { executeTouchscreenInput, supportsCtrlProxyGestureDisplay } from "./touchscreenInput";
import { logger } from "../../utils/logger";
import { serverConfig } from "../../utils/ServerConfig";
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

// Minimums also match the documented defaults (press 600, drag 300, hold 100 ms)
// shared by default-display, explicit-display CtrlProxy/adb (drag only), and iOS paths.
export const PRESS_DURATION_MIN_MS = 600;
export const PRESS_DURATION_MAX_MS = 3000;
export const DRAG_DURATION_MIN_MS = 300;
export const DRAG_DURATION_MAX_MS = 2000;
export const HOLD_DURATION_MIN_MS = 100;
export const HOLD_DURATION_MAX_MS = 3000;
const DROP_DURATION_MS = 100;
export const IOS_DRAG_TIMEOUT_OVERHEAD_MS = LONG_PRESS_TIMEOUT_HEADROOM_MS;
export const IOS_DRAG_TIMEOUT_DURATION_RATIO = 0.5;

/** Shared drag budget: sibling gestures' 5s floor, headroom and longer-plan scaling. */
export function getIosDragTimeoutMs(
  pressDurationMs: number,
  dragDurationMs: number,
  holdDurationMs: number,
): number {
  const plannedDurationMs = pressDurationMs + dragDurationMs + holdDurationMs;
  return Math.max(
    DEFAULT_GESTURE_REQUEST_TIMEOUT_MS,
    plannedDurationMs +
      IOS_DRAG_TIMEOUT_OVERHEAD_MS +
      plannedDurationMs * IOS_DRAG_TIMEOUT_DURATION_RATIO,
  );
}
function indeterminateResult(reason: string) {
  return {
    success: false,
    error: `Drag outcome is indeterminate: the request was dispatched but no result was confirmed (${reason}). The gesture may have run. Do not retry automatically. Verify state first with observe.`,
  };
}

/**
 * Android drag replies have no reason code or stroke index. Recognize only fixed runner
 * messages proving no input occurred; all other replies can follow a partial gesture.
 * In particular, first- and later-stroke rejection share the same message, so neither
 * timings nor "Failed to dispatch streamed gesture stroke" can prove a no-op.
 */
export function isAndroidDragFailureIndeterminate(error: string | undefined): boolean {
  if (error === undefined || error.trim() !== error) {
    return true;
  }
  // GestureDisplayRouting, CtrlProxyMessageHandler, CtrlProxy and GestureDispatchLifecycle.
  const noOpReplies = [
    "Gesture display routing requires Android 11 (API 30)",
    "Stale frame context for input/drag; observe a fresh frame before retrying",
    "Stale frame context; observe a fresh frame before retrying",
    "Failed to dispatch gesture",
  ];
  return !(
    noOpReplies.includes(error) ||
    /^displayId must be non-negative: -[1-9]\d*$/.test(error) ||
    /^Non-finite gesture coordinate: (x1|y1|x2|y2)=(NaN|-?Infinity)\. Coordinates must be finite \(not NaN or Infinity\)\.$/.test(
      error,
    )
  );
}

const HIERARCHY_REFRESH_TIMEOUT_MS = 5000;
// XCUITest hierarchy extraction is slow (can take 5-15s), so the iOS refresh uses the same
// 15s budget as CtrlProxyHierarchy.getAccessibilityHierarchy rather than the 5s Android value.
// A shorter timeout would fall back to the (possibly stale) observe cache on slow screens.
const IOS_HIERARCHY_REFRESH_TIMEOUT_MS = 15000;

interface DragAndDropDeps extends DisplayFenceDependencies {
  lastRenderedObservation?: RenderedObservationReader;
  hierarchyCapture?: HierarchyCapture;
  selector?: ElementSelector;
  visionConfig?: VisionFallbackConfig;
  screenshotCapturer?: ScreenshotCapturer;
  visionAnalyzer?: VisionAnalyzer;
}

export class DragAndDrop extends BaseVisualChange {
  private readonly lastRenderedObservation?: RenderedObservationReader;
  private selector: ElementSelector;
  private hierarchyCapture: HierarchyCapture;
  private geometry: ElementGeometry;
  private accessibilityService: AndroidCtrlProxyClient;
  private visionConfig: VisionFallbackConfig;
  private screenshotCapturer: ScreenshotCapturer;
  private visionAnalyzer: VisionAnalyzer | undefined;

  constructor(
    device: BootedDevice,
    adb: AdbClient | null = null,
    timer: Timer = defaultTimer,
    deps: DragAndDropDeps = {},
  ) {
    super(device, adb, timer, deps.renderedDisplayRevision, deps);
    this.lastRenderedObservation = deps.lastRenderedObservation;
    this.selector =
      deps.selector ??
      new ResolverElementSelector(undefined, undefined, {
        platform: device.platform,
        iosMultiPanel: device.platform === "ios" && (device.displays?.panels.length ?? 0) > 1,
      });
    this.hierarchyCapture =
      deps.hierarchyCapture ??
      createDeviceHierarchyCapture(device, { timer, adbFactory: this.adbFactory });
    this.geometry = new DefaultElementGeometry();
    this.accessibilityService = AndroidCtrlProxyClient.getInstance(device, this.adbFactory);
    this.visionConfig = deps.visionConfig ?? DEFAULT_VISION_CONFIG;
    this.screenshotCapturer =
      deps.screenshotCapturer ?? new TakeScreenshotCapturer(device, this.adbFactory);
    this.visionAnalyzer = deps.visionAnalyzer;
  }

  private async executeOnAndroidDisplay(
    options: DragAndDropOptions,
    target: Awaited<ReturnType<typeof prepareTargetDisplayAction>>,
    signal?: AbortSignal,
  ): Promise<DragAndDropResult> {
    const hierarchy = target.observation.viewHierarchy;
    if (!hierarchy) {
      throw new ActionableError("Selected display has no view hierarchy");
    }
    const { sourcePoint: start, targetPoint: end } = this.resolveTargetPoints(hierarchy, {
      ...options,
      observation: target.observation,
    });
    const duration = this.getDragDurationMs(options);
    const useCtrlProxy = await supportsCtrlProxyGestureDisplay(
      this.accessibilityService,
      target.displayId,
    );
    target.assertCurrent();
    throwIfAborted(signal);
    if (useCtrlProxy) {
      const pressDurationMs = this.getPressDurationMs(options);
      const holdDurationMs = this.getHoldDurationMs(options);
      let dispatched = false;
      let result;
      try {
        // Attach the cancellation waiter before the client can abort synchronously.
        result = await awaitWhileRequestIsLive(
          Promise.resolve().then(() => {
            throwIfAborted(signal);
            return this.accessibilityService.requestDrag(
              start.x,
              start.y,
              end.x,
              end.y,
              pressDurationMs,
              duration,
              holdDurationMs,
              getIosDragTimeoutMs(pressDurationMs, duration, holdDurationMs),
              undefined,
              signal,
              target.displayId === 0 ? undefined : target.displayId,
              target.assertCurrent,
              () => {
                dispatched = true;
              },
            );
          }),
          signal,
        );
        throwIfAborted(signal);
      } catch (error) {
        throwIfAborted(signal);
        if (!dispatched) {
          throw error;
        }
        logger.warn(`Drag outcome indeterminate: ${errorMessage(error)}`, error);
        throw new ActionableError(indeterminateResult(errorMessage(error)).error);
      }
      if (!result.success) {
        throw new ActionableError(
          dispatched && isAndroidDragFailureIndeterminate(result.error)
            ? indeterminateResult(result.error ?? "unknown error").error
            : (result.error ?? "Android drag failed"),
        );
      }
    } else {
      if (options.pressDurationMs !== undefined || options.holdDurationMs !== undefined) {
        throw new ActionableError(
          `pressDurationMs and holdDurationMs require the CtrlProxy gesture route on display ${target.displayId} (capability gesture_display_id_v1); adb draganddrop cannot express press or hold durations`,
        );
      }
      await executeTouchscreenInput(
        this.adb,
        `draganddrop ${start.x} ${start.y} ${end.x} ${end.y} ${inputDurationArgument(duration)}`,
        target.displayId,
        signal,
        target.assertCurrent,
      );
    }
    return {
      success: true,
      duration,
      distance: Math.hypot(end.x - start.x, end.y - start.y),
    };
  }

  private async executeExplicitDisplay(
    options: DragAndDropOptions,
    signal?: AbortSignal,
  ): Promise<DragAndDropResult | undefined> {
    if (options.display !== undefined) {
      try {
        const target = await prepareTargetDisplayAction(
          this.device,
          options.display,
          this.observeScreen,
          this.adb,
          this.lastRenderedObservation,
          signal,
          this.displayTransitionReader,
        );
        if (this.device.platform === "android") {
          return await this.observedInteraction(
            () => this.executeOnAndroidDisplay(options, target, signal),
            {
              changeExpected: false,
              display: target.observation.display.key,
              previousObservation: target.observation,
              signal,
            },
          );
        }
      } catch (error) {
        throwIfAborted(signal);
        if (error instanceof Error && error.name === "AbortError") {
          throw error;
        }
        logger.warn(`dragAndDrop display routing failed: ${errorMessage(error)}`, error);
        return withStaleDisplay(
          { success: false, duration: 0, distance: 0, error: errorMessage(error) },
          error,
        );
      }
    }
    return undefined;
  }

  async execute(
    options: DragAndDropOptions,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<DragAndDropResult> {
    signal = this.device.platform === "ios" ? combineWithAmbientAbort(signal) : signal;
    const targeted = await this.executeExplicitDisplay(options, signal);
    if (targeted) {
      return targeted;
    }
    const perf = createGlobalPerformanceTracker();
    perf.serial("dragAndDrop");

    if (this.device.platform !== "android" && this.device.platform !== "ios") {
      perf.end();
      return {
        success: false,
        duration: 0,
        distance: 0,
        error: `dragAndDrop is not supported on ${this.device.platform}`,
      };
    }

    // The Android accessibility service is only required for the Android gesture path.
    // iOS dispatches the drag through the XCUITest CtrlProxy runner (no a11y service).
    if (this.device.platform === "android") {
      const a11yManager = AndroidCtrlProxyManager.getInstance(this.device, this.adb);
      const isAvailable = await perf.track("a11yAvailable", () => a11yManager.isAvailable());
      if (!isAvailable) {
        perf.end();
        return {
          success: false,
          duration: 0,
          distance: 0,
          error:
            "dragAndDrop requires the Android accessibility service to be installed and enabled.",
        };
      }
    }

    const validationError = this.validateOptions(options);
    if (validationError) {
      perf.end();
      return { success: false, duration: 0, distance: 0, error: validationError };
    }

    return this.executeObservedDrag(options, perf, progress, signal);
  }

  private async executeObservedDrag(
    options: DragAndDropOptions,
    perf: PerformanceTracker,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<DragAndDropResult> {
    try {
      const pressDurationMs = this.getPressDurationMs(options);
      const dragDurationMs = this.getDragDurationMs(options);
      const holdDurationMs = this.getHoldDurationMs(options);
      let iosDispatchTimestamp: number | undefined;

      const result = await this.observedInteraction(
        async (observeResult: ObserveResult, fence) => {
          throwIfAborted(signal);
          const viewHierarchy = await this.resolveViewHierarchy(signal);
          if (!viewHierarchy) {
            return { success: false, error: "Unable to get view hierarchy, cannot drag and drop" };
          }

          const { sourcePoint, targetPoint } = this.resolveTargetPoints(viewHierarchy, {
            ...options,
            observation: observeResult,
          });

          // Once beforeSend lands, also pass this as the dispatch's beforeSend.
          fence?.assertCurrent();
          const dragResult = await this.executeDrag(
            sourcePoint.x,
            sourcePoint.y,
            targetPoint.x,
            targetPoint.y,
            pressDurationMs,
            dragDurationMs,
            holdDurationMs,
            signal,
          );

          if (this.device.platform === "ios" && dragResult.success) {
            iosDispatchTimestamp = this.timer.now();
            IOSCtrlProxyClient.getExistingInstance(this.device.deviceId)?.invalidateCache();
          }

          await this.timer.sleep(DROP_DURATION_MS);

          const distance = Math.hypot(targetPoint.x - sourcePoint.x, targetPoint.y - sourcePoint.y);

          return {
            success: dragResult.success,
            duration: dragDurationMs,
            distance,
            a11yTotalTimeMs: dragResult.a11yTotalTimeMs,
            a11yGestureTimeMs: dragResult.a11yGestureTimeMs,
            error: dragResult.error,
          };
        },
        {
          changeExpected: false,
          display: options.display,
          progress,
          perf,
          signal,
          observationTimestampProvider: () => iosDispatchTimestamp,
          predictionContext: {
            toolName: "dragAndDrop",
            toolArgs: {
              source: options.source,
              target: options.target,
              pressDurationMs,
              dragDurationMs,
              holdDurationMs,
              platform: this.device.platform,
            },
          },
        },
      );

      perf.end();
      throwIfAborted(signal);

      return {
        ...result,
        duration: result.duration ?? this.getDragDurationMs(options),
        distance: result.distance ?? 0,
      } as DragAndDropResult;
    } catch (error) {
      perf.end();

      logger.warn(`Drag and drop failed: ${errorMessage(error)}`, error);
      throwIfAborted(signal);
      if (error instanceof StaleDisplayError) {
        return withStaleDisplay({ success: false, duration: 0, distance: 0 }, error);
      }
      const baseErrorMessage = errorMessage(error);
      let finalErrorMessage = `Failed to perform drag and drop: ${baseErrorMessage}`;

      if (this.visionConfig.enabled) {
        // Infer which element failed from the error message
        const isSourceError = this.isSourceResolutionError(baseErrorMessage);
        const failedTarget = isSourceError ? options.source : options.target;
        if (failedTarget) {
          const searchCriteria = {
            text: failedTarget.text,
            resourceId: failedTarget.elementId,
            description: isSourceError ? "Source element for drag" : "Target element for drop",
          };
          const cachedObserve = await this.observeScreen.getMostRecentCachedObserveResult();
          const viewHierarchy = cachedObserve?.viewHierarchy ?? null;
          finalErrorMessage = await getVisionEnrichedError(
            this.screenshotCapturer,
            viewHierarchy,
            searchCriteria,
            this.visionConfig,
            finalErrorMessage,
            signal,
            this.visionAnalyzer,
          );
        }
      }

      throwIfAborted(signal);
      return { success: false, duration: 0, distance: 0, error: finalErrorMessage };
    }
  }

  private isSourceResolutionError(message: string): boolean {
    return (
      message.startsWith("dragAndDrop source") ||
      (!message.startsWith("dragAndDrop target") && message.toLowerCase().includes("source"))
    );
  }

  private validateOptions(options: DragAndDropOptions): string | null {
    if (!options?.source || !options?.target) {
      return "dragAndDrop requires source and target";
    }
    const sourceSelectorCount = [options.source.text, options.source.elementId].filter(
      Boolean,
    ).length;
    if (sourceSelectorCount !== 1) {
      return "dragAndDrop source must specify exactly one of text or elementId";
    }
    const targetSelectorCount = [options.target.text, options.target.elementId].filter(
      Boolean,
    ).length;
    if (targetSelectorCount !== 1) {
      return "dragAndDrop target must specify exactly one of text or elementId";
    }
    if (
      !this.isDurationInRange(options.pressDurationMs, PRESS_DURATION_MIN_MS, PRESS_DURATION_MAX_MS)
    ) {
      return `dragAndDrop pressDurationMs must be between ${PRESS_DURATION_MIN_MS}ms and ${PRESS_DURATION_MAX_MS}ms`;
    }
    if (
      !this.isDurationInRange(options.dragDurationMs, DRAG_DURATION_MIN_MS, DRAG_DURATION_MAX_MS)
    ) {
      return `dragAndDrop dragDurationMs must be between ${DRAG_DURATION_MIN_MS}ms and ${DRAG_DURATION_MAX_MS}ms`;
    }
    if (
      !this.isDurationInRange(options.holdDurationMs, HOLD_DURATION_MIN_MS, HOLD_DURATION_MAX_MS)
    ) {
      return `dragAndDrop holdDurationMs must be between ${HOLD_DURATION_MIN_MS}ms and ${HOLD_DURATION_MAX_MS}ms`;
    }
    return null;
  }

  private resolveTargetPoints(
    hierarchy: ViewHierarchyResult,
    options: DragAndDropOptions & { observation: ObserveResult },
  ) {
    const screenSizeOptions = {
      observationScreenSize: options.observation.screenSize,
      display: options.observation.viewHierarchy,
    };
    const source = this.resolveTarget(
      hierarchy,
      { ...options.source, screenSizeOptions },
      "source",
    );
    const target = this.resolveTarget(
      hierarchy,
      { ...options.target, screenSizeOptions },
      "target",
    );
    return {
      sourcePoint: this.geometry.getElementCenter(source),
      targetPoint: this.geometry.getElementCenter(target),
    };
  }

  private resolveTarget(
    viewHierarchy: ViewHierarchyResult,
    target: DragAndDropTarget & {
      screenSizeOptions?: ScreenSizeForOffscreenCheckOptions;
    },
    label: "source" | "target",
  ) {
    const selectorCount = [target.elementId, target.text].filter(Boolean).length;
    if (selectorCount !== 1) {
      throw new ActionableError(
        `dragAndDrop ${label} must specify exactly one of text or elementId`,
      );
    }
    let element;
    try {
      element = this.selectTargetElement(viewHierarchy, target);
      if (!element && target.container) {
        throw new ActionableError("Target not found within container");
      }
    } catch (error) {
      const prefix =
        target.container || target.selectionStrategy === "unique" ? `dragAndDrop ${label}: ` : "";
      throw new ActionableError(`${prefix}${errorMessage(error)}`, { cause: error });
    }
    if (!element) {
      const field = target.elementId ? "elementId" : "text";
      throw new ActionableError(
        `dragAndDrop ${label} not found with ${field} '${target.elementId ?? target.text}'`,
      );
    }
    return element;
  }

  private selectTargetElement(
    viewHierarchy: ViewHierarchyResult,
    target: DragAndDropTarget & { screenSizeOptions?: ScreenSizeForOffscreenCheckOptions },
  ) {
    const selectionOptions = {
      intentAction: "drag" as const,
      screenSizeOptions: target.screenSizeOptions,
      container: target.container,
      strategy: target.selectionStrategy,
    };
    // The adapter preserves legacy one-level missing-container null results.
    // Preflight that scope via the shared resolver so drag errors remain distinct.
    if (
      target.container &&
      !target.container.container &&
      target.selectionStrategy !== "unique" &&
      this.selector.resolveContainer &&
      !this.selector.resolveContainer(viewHierarchy, target.container, target.selectionStrategy)
    ) {
      throw new ActionableError(
        `Container level 1 not found: ${target.container.elementId ?? target.container.text}`,
      );
    }
    if (target.elementId) {
      return this.selector.selectByResourceId(viewHierarchy, target.elementId, selectionOptions)
        .element;
    }
    const selection = this.selector.selectByText(
      viewHierarchy,
      target.text ?? "",
      selectionOptions,
    );
    return selection.matchedElement ?? selection.element;
  }

  private async resolveViewHierarchy(signal?: AbortSignal): Promise<ViewHierarchyResult | null> {
    const snapshot = await this.hierarchyCapture.capture({
      freshness: "fresh",
      searchRaw: this.device.platform === "android" && serverConfig.isRawElementSearchEnabled(),
      signal,
      timeoutMs:
        this.device.platform === "ios"
          ? IOS_HIERARCHY_REFRESH_TIMEOUT_MS
          : HIERARCHY_REFRESH_TIMEOUT_MS,
    });
    if (this.device.platform === "ios") {
      throwIfAborted(signal);
    }
    return snapshot.hierarchy;
  }

  private getPressDurationMs(options: DragAndDropOptions): number {
    if (typeof options.pressDurationMs === "number") {
      return options.pressDurationMs;
    }
    return PRESS_DURATION_MIN_MS;
  }

  private getDragDurationMs(options: DragAndDropOptions): number {
    if (typeof options.dragDurationMs === "number") {
      return options.dragDurationMs;
    }
    return DRAG_DURATION_MIN_MS;
  }

  private getHoldDurationMs(options: DragAndDropOptions): number {
    if (typeof options.holdDurationMs === "number") {
      return options.holdDurationMs;
    }
    return HOLD_DURATION_MIN_MS;
  }

  private isDurationInRange(value: number | undefined, min: number, max: number): boolean {
    if (typeof value !== "number") {
      return true;
    }
    return value >= min && value <= max;
  }

  private async executeDrag(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    pressDurationMs: number,
    dragDurationMs: number,
    holdDurationMs: number,
    signal?: AbortSignal,
  ): Promise<{
    success: boolean;
    error?: string;
    a11yTotalTimeMs?: number;
    a11yGestureTimeMs?: number;
  }> {
    throwIfAborted(signal);

    const timeoutMs = getIosDragTimeoutMs(pressDurationMs, dragDurationMs, holdDurationMs);
    let dispatched = false;
    const onDispatch = () => {
      dispatched = true;
    };
    let result;
    try {
      // Attach cancellation before calling the client, which can abort synchronously.
      // iOS preserves exact coordinates; Android rounds in its shared gesture delegate.
      const request = Promise.resolve().then(() => {
        throwIfAborted(signal);
        return this.device.platform === "ios"
          ? IOSCtrlProxyClient.getInstance(this.device).requestDrag(
              startX,
              startY,
              endX,
              endY,
              pressDurationMs,
              dragDurationMs,
              holdDurationMs,
              timeoutMs,
              undefined,
              signal,
              onDispatch,
            )
          : this.accessibilityService.requestDrag(
              startX,
              startY,
              endX,
              endY,
              pressDurationMs,
              dragDurationMs,
              holdDurationMs,
              timeoutMs,
              undefined,
              signal,
              undefined,
              undefined,
              onDispatch,
            );
      });
      result = await awaitWhileRequestIsLive(request, signal);
      throwIfAborted(signal);
      if (
        !result.success &&
        dispatched &&
        (this.device.platform === "ios" || isAndroidDragFailureIndeterminate(result.error))
      ) {
        return indeterminateResult(result.error ?? "unknown error");
      }
    } catch (error) {
      throwIfAborted(signal);
      if (!dispatched) {
        throw error;
      }
      logger.warn(`Drag outcome indeterminate: ${errorMessage(error)}`, error);
      return indeterminateResult(errorMessage(error));
    }

    if (result.success) {
      return {
        success: true,
        a11yTotalTimeMs: result.totalTimeMs,
        a11yGestureTimeMs: result.gestureTimeMs,
      };
    }

    return {
      success: false,
      error: result.error ?? "Drag failed via CtrlProxy",
    };
  }
}

import {
  AndroidCtrlProxy,
  ScreenshotResult,
  A11yDragResult,
  A11yTapCoordinatesResult,
  A11yPinchResult,
  A11ySwipeResult,
  A11ySetTextResult,
  A11yImeActionResult,
  A11ySelectAllResult,
  A11yActionResult,
  AccessibilityHierarchyResponse,
  AndroidPerfTiming,
  AccessibilityHierarchy,
  AccessibilityNodeSelector,
} from "../../src/features/observe/android";
import type { OverlaySpec } from "../../src/features/overlay/overlaySpec";
import type { OverlayAssetUpload } from "../../src/features/overlay/overlayAssets";
import type { OverlayAssetRequestOptions } from "../../src/features/observe/android/CtrlProxyOverlays";
import type {
  OverlayAssetResult,
  OverlayDismiss,
  OverlayEvent,
  OverlayResult,
  OverlayUpdate,
} from "../../src/features/observe/android/ctrlProxyProtocol";
import type { SetTextOptions } from "../../src/features/observe/DeviceService";
import { HighlightOperationResult, HighlightShape, ViewHierarchyResult } from "../../src/models";
import { ViewHierarchyQueryOptions } from "../../src/models/ViewHierarchyQueryOptions";
import { PerformanceTracker } from "../../src/utils/PerformanceTracker";
import { defaultTimer, Timer } from "../../src/utils/SystemTimer";

/**
 * Fake implementation of CtrlProxy for testing
 * Allows configuring responses for hierarchy, screenshots, and gesture operations
 * Tracks method calls for test assertions
 */
export class FakeCtrlProxy implements AndroidCtrlProxy {
  constructor(private readonly timer: Timer = defaultTimer) {}

  private nodeActionSelectorsSupported = true;
  private nodeActionHistory: Array<{
    action: string;
    selector: AccessibilityNodeSelector;
    timeoutMs: number;
    perf?: PerformanceTracker;
    signal?: AbortSignal;
  }> = [];

  setSupportsNodeActionSelectors(supported: boolean): void {
    this.nodeActionSelectorsSupported = supported;
  }

  getNodeActionHistory() {
    return this.nodeActionHistory.map((entry) => ({ ...entry, selector: { ...entry.selector } }));
  }

  private readonly supportedCommands = new Set<string>();
  setSupportedCommands(commands: readonly string[]): void {
    this.supportedCommands.clear();
    for (const command of commands) {
      this.supportedCommands.add(command);
    }
  }
  async supportsCommand(name: string): Promise<boolean> {
    return this.supportedCommands.has(name);
  }
  private tapHistory: Array<{
    x: number;
    y: number;
    duration: number;
    signal?: AbortSignal;
    displayId?: number;
  }> = [];
  getTapHistory() {
    return [...this.tapHistory];
  }
  async requestTapCoordinates(
    x: number,
    y: number,
    duration = 10,
    _timeoutMs?: number,
    _perf?: PerformanceTracker,
    _frameContext?: string,
    onDispatch?: () => void,
    signal?: AbortSignal,
    displayId?: number,
    beforeSend?: () => void,
  ): Promise<A11yTapCoordinatesResult> {
    beforeSend?.();
    this.checkFailure("tap");
    this.tapHistory.push({
      x,
      y,
      duration,
      ...(signal ? { signal } : {}),
      ...(displayId === undefined ? {} : { displayId }),
    });
    onDispatch?.();
    return { success: true, totalTimeMs: duration };
  }

  private overlayResult: OverlayResult = { success: true };
  private readonly overlayHistory: Array<
    | { method: "show"; spec: OverlaySpec; timeoutMs: number; perf?: PerformanceTracker }
    | { method: "update"; update: OverlayUpdate; timeoutMs: number; perf?: PerformanceTracker }
    | { method: "dismiss"; target: OverlayDismiss; timeoutMs: number; perf?: PerformanceTracker }
  > = [];
  private readonly overlayListeners = new Set<(event: OverlayEvent) => void>();

  setOverlayResult(result: OverlayResult): void {
    this.overlayResult = result;
  }

  getOverlayHistory() {
    return [...this.overlayHistory];
  }

  async requestShowOverlay(
    spec: OverlaySpec,
    timeoutMs = 5000,
    perf?: PerformanceTracker,
  ): Promise<OverlayResult> {
    this.checkFailure("requestShowOverlay");
    this.overlayHistory.push({ method: "show", spec, timeoutMs, perf });
    return this.overlayResult;
  }

  async requestUpdateOverlay(
    update: OverlayUpdate,
    timeoutMs = 5000,
    perf?: PerformanceTracker,
  ): Promise<OverlayResult> {
    this.checkFailure("requestUpdateOverlay");
    this.overlayHistory.push({ method: "update", update, timeoutMs, perf });
    return this.overlayResult;
  }

  async requestDismissOverlay(
    target: OverlayDismiss,
    timeoutMs = 5000,
    perf?: PerformanceTracker,
  ): Promise<OverlayResult> {
    this.checkFailure("requestDismissOverlay");
    this.overlayHistory.push({ method: "dismiss", target, timeoutMs, perf });
    return this.overlayResult;
  }

  private overlayAssetResult: OverlayAssetResult = {
    success: true,
    dispatched: true,
    acknowledged: true,
  };
  private readonly overlayAssetHistory: Array<
    | { method: "put"; asset: OverlayAssetUpload; options?: OverlayAssetRequestOptions }
    | { method: "remove"; id: string; options?: OverlayAssetRequestOptions }
  > = [];

  setOverlayAssetResult(result: OverlayAssetResult): void {
    this.overlayAssetResult = result;
  }

  getOverlayAssetHistory() {
    return [...this.overlayAssetHistory];
  }

  async requestPutOverlayAsset(
    asset: OverlayAssetUpload,
    options?: OverlayAssetRequestOptions,
  ): Promise<OverlayAssetResult> {
    this.checkFailure("requestPutOverlayAsset");
    this.overlayAssetHistory.push({ method: "put", asset, options });
    return this.overlayAssetResult;
  }

  async requestRemoveOverlayAsset(
    id: string,
    options?: OverlayAssetRequestOptions,
  ): Promise<OverlayAssetResult> {
    this.checkFailure("requestRemoveOverlayAsset");
    this.overlayAssetHistory.push({ method: "remove", id, options });
    return this.overlayAssetResult;
  }

  onOverlayEvent(listener: (event: OverlayEvent) => void): () => void {
    this.overlayListeners.add(listener);
    return () => {
      this.overlayListeners.delete(listener);
    };
  }

  getOverlayListenerCount(): number {
    return this.overlayListeners.size;
  }

  emitOverlayEvent(event: OverlayEvent): void {
    for (const listener of this.overlayListeners) {
      listener(event);
    }
  }

  // Session binding (matches CtrlProxyClient.bindSession for test compatibility)
  private boundSessionId: string | null = null;

  bindSession(sessionId: string): void {
    this.boundSessionId = sessionId;
  }

  getBoundSessionId(): string | null {
    return this.boundSessionId;
  }

  // Configurable response data
  private hierarchyData: AccessibilityHierarchy | null = null;
  private screenshotData: string | null = null;
  private screenshotFormat: string = "jpeg";
  private performanceTiming: AndroidPerfTiming[] | null = null;
  private isConnectedState: boolean = true;
  private hasCachedHierarchyState: boolean = false;

  // Failure modes
  private failureMap: Map<string, Error> = new Map();

  // Operation delays
  private operationDelays: Map<string, number> = new Map();

  // Call history
  private swipeHistory: Array<{
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    duration: number;
    signal?: AbortSignal;
    displayId?: number;
  }> = [];

  private dragHistory: Array<{
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    pressDurationMs: number;
    dragDurationMs: number;
    holdDurationMs: number;
    timeoutMs: number;
    signal?: AbortSignal;
    displayId?: number;
  }> = [];

  private pinchHistory: Array<{
    centerX: number;
    centerY: number;
    distanceStart: number;
    distanceEnd: number;
    rotationDegrees: number;
    duration?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    displayId?: number;
  }> = [];

  private twoFingerSwipeHistory: Array<{
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    duration: number;
    offset: number;
    timeoutMs: number;
    displayId?: number;
  }> = [];

  private actionHistory: Array<{
    action: string;
    resourceId?: string;
    timeoutMs?: number;
  }> = [];

  private actionResult: A11yActionResult | null = null;
  private twoFingerSwipeResult: A11ySwipeResult | null = null;
  private swipeResult: A11ySwipeResult | null = null;
  private swipeDispatchesBeforeResult: boolean = false;
  private clearTextResult: A11ySetTextResult | null = null;

  private setTextHistory: Array<{
    text: string;
    resourceId?: string;
  }> = [];

  private imeActionHistory: Array<{
    action: "done" | "next" | "search" | "send" | "go" | "previous";
  }> = [];

  private screenshotRequestCount: number = 0;
  private hierarchyRequestCount: number = 0;
  private dragResult: A11yDragResult | null = null;
  private pinchResult: A11yPinchResult | null = null;
  private viewHierarchyResultOverride: ViewHierarchyResult | null = null;
  private lastRequestHierarchySyncArgs: {
    disableAllFiltering?: boolean;
    timeoutMs?: number;
  } | null = null;

  /**
   * Configure hierarchy data to be returned by getAccessibilityHierarchy
   * @param hierarchy - The accessibility hierarchy to return
   */
  setHierarchyData(hierarchy: AccessibilityHierarchy | null): void {
    this.hierarchyData = hierarchy;
  }

  /**
   * Override the ViewHierarchyResult produced by convertToViewHierarchyResult
   * (and therefore returned by getAccessibilityHierarchy / getLatestHierarchy).
   * Lets tests assert against a realistic node tree instead of the default stub.
   * @param result - The view hierarchy result to return, or null to restore default behavior
   */
  setViewHierarchyResult(result: ViewHierarchyResult | null): void {
    this.viewHierarchyResultOverride = result;
  }

  /**
   * Configure screenshot data to be returned by requestScreenshot
   * @param base64Data - Base64 encoded screenshot data
   * @param format - Screenshot format (default: "jpeg")
   */
  setScreenshotData(base64Data: string | null, format: string = "jpeg"): void {
    this.screenshotData = base64Data;
    this.screenshotFormat = format;
  }

  /**
   * Configure a failure mode for a specific operation
   * @param operation - The operation name (e.g., "swipe", "setText", "screenshot", "getHierarchy")
   * @param error - The error to throw for this operation
   */
  setFailureMode(operation: string, error: Error | null): void {
    if (error === null) {
      this.failureMap.delete(operation);
    } else {
      this.failureMap.set(operation, error);
    }
  }

  /**
   * Configure a delay for a specific operation (for simulating slow operations)
   * @param operation - The operation name
   * @param delayMs - Delay in milliseconds
   */
  setOperationDelay(operation: string, delayMs: number): void {
    this.operationDelays.set(operation, delayMs);
  }

  /**
   * Set connection state
   * @param connected - Whether the service is connected
   */
  setConnected(connected: boolean): void {
    this.isConnectedState = connected;
  }

  /**
   * Set cached hierarchy state
   * @param hasCached - Whether there is cached hierarchy data
   */
  setCachedHierarchy(hasCached: boolean): void {
    this.hasCachedHierarchyState = hasCached;
  }

  /**
   * Configure Android-side performance timing data
   * @param perfTiming - Performance timing data from Android
   */
  setPerformanceTiming(perfTiming: AndroidPerfTiming[] | null): void {
    this.performanceTiming = perfTiming;
  }

  /**
   * Configure drag results returned by requestDrag
   * @param result - The drag result to return (or null to reset to default success response)
   */
  setDragResult(result: A11yDragResult | null): void {
    this.dragResult = result;
  }

  /**
   * Configure pinch results returned by requestPinch
   * @param result - The pinch result to return (or null to reset to default success response)
   */
  setPinchResult(result: A11yPinchResult | null): void {
    this.pinchResult = result;
  }

  /**
   * Configure the result returned by requestAction and requestNodeAction
   * @param result - The action result to return (or null for default success)
   */
  setActionResult(result: A11yActionResult | null): void {
    this.actionResult = result;
  }

  /**
   * Configure the result returned by requestTwoFingerSwipe
   * @param result - The swipe result to return (or null for default success)
   */
  setTwoFingerSwipeResult(result: A11ySwipeResult | null): void {
    this.twoFingerSwipeResult = result;
  }

  /**
   * Configure the result returned by requestSwipe. Unlike setFailureMode("swipe"),
   * which makes requestSwipe throw, this returns a structured non-throwing result
   * so tests can exercise the a11y-swipe-failed-but-did-not-throw fallback branch.
   * @param result - The swipe result to return (or null for the default success)
   */
  setSwipeResult(result: A11ySwipeResult | null): void {
    this.swipeResult = result;
  }

  /** Simulate a swipe reaching the device before its response or exception. */
  setSwipeDispatchesBeforeResult(value: boolean): void {
    this.swipeDispatchesBeforeResult = value;
  }

  /**
   * Configure the result returned by requestClearText. The a11y clear-text path
   * treats a `{ success: false }` return (not a throw) as the trigger for the ADB
   * delete-key fallback; setFailureMode("clearText") throws instead, which the
   * production code does not catch. This seam is required to reach that fallback.
   * @param result - The clear-text result to return (or null for the default success)
   */
  setClearTextResult(result: A11ySetTextResult | null): void {
    this.clearTextResult = result;
  }

  // Assertion methods

  /**
   * Get the history of swipe requests
   * @returns Array of swipe requests with coordinates and duration
   */
  getSwipeHistory(): Array<{
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    duration: number;
    signal?: AbortSignal;
    displayId?: number;
  }> {
    return [...this.swipeHistory];
  }

  /**
   * Get the history of drag requests
   * @returns Array of drag requests with coordinates and durations
   */
  getDragHistory(): Array<{
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    pressDurationMs: number;
    dragDurationMs: number;
    holdDurationMs: number;
    timeoutMs: number;
    signal?: AbortSignal;
    displayId?: number;
  }> {
    return [...this.dragHistory];
  }

  /**
   * Get the history of pinch requests
   * @returns Array of pinch requests with parameters
   */
  getPinchHistory(): Array<{
    centerX: number;
    centerY: number;
    distanceStart: number;
    distanceEnd: number;
    rotationDegrees: number;
    duration?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    displayId?: number;
  }> {
    return [...this.pinchHistory];
  }

  /**
   * Get the history of text input requests
   * @returns Array of setText requests with text and optional resourceId
   */
  getTextInputHistory(): Array<{
    text: string;
    resourceId?: string;
  }> {
    return [...this.setTextHistory];
  }

  /**
   * Get the history of IME action requests
   * @returns Array of IME action requests with action type
   */
  getImeActionHistory(): Array<{
    action: "done" | "next" | "search" | "send" | "go" | "previous";
  }> {
    return [...this.imeActionHistory];
  }

  /**
   * Check if a specific IME action was called
   * @param action - The IME action to check for
   * @returns true if the action was called at least once
   */
  wasImeActionCalled(action: "done" | "next" | "search" | "send" | "go" | "previous"): boolean {
    return this.imeActionHistory.some((entry) => entry.action === action);
  }

  /**
   * Get the history of requestAction calls
   */
  getActionHistory(): Array<{ action: string; resourceId?: string; timeoutMs?: number }> {
    return [...this.actionHistory];
  }

  /**
   * Get the history of requestTwoFingerSwipe calls
   */
  getTwoFingerSwipeHistory(): Array<{
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    duration: number;
    offset: number;
    timeoutMs: number;
  }> {
    return [...this.twoFingerSwipeHistory];
  }

  /**
   * Get the number of screenshot requests made
   * @returns Number of screenshot requests
   */
  getScreenshotRequestCount(): number {
    return this.screenshotRequestCount;
  }

  /**
   * Get the number of hierarchy requests made
   * @returns Number of hierarchy requests (both getAccessibilityHierarchy and getLatestHierarchy)
   */
  getHierarchyRequestCount(): number {
    return this.hierarchyRequestCount;
  }

  /**
   * Args the most recent `requestHierarchySync` call was invoked with — lets
   * tests verify positional arguments (e.g. `timeoutMs`) were actually
   * forwarded to the right parameter rather than only checking the return
   * value, which callers can get "right" for the wrong reason (issue #6252).
   */
  getLastRequestHierarchySyncArgs(): {
    disableAllFiltering?: boolean;
    timeoutMs?: number;
  } | null {
    return this.lastRequestHierarchySyncArgs;
  }

  /**
   * Clear all call history
   */
  clearHistory(): void {
    this.tapHistory = [];
    this.swipeHistory = [];
    this.dragHistory = [];
    this.setTextHistory = [];
    this.imeActionHistory = [];
    this.actionHistory = [];
    this.nodeActionHistory = [];
    this.twoFingerSwipeHistory = [];
    this.screenshotRequestCount = 0;
    this.hierarchyRequestCount = 0;
  }

  // Helper method to apply operation delay
  private async applyDelay(operation: string): Promise<void> {
    const delay = this.operationDelays.get(operation);
    if (delay && delay > 0) {
      await this.timer.sleep(delay);
    }
  }

  // Helper method to check for failures
  private checkFailure(operation: string): void {
    const error = this.failureMap.get(operation);
    if (error) {
      throw error;
    }
  }

  // CtrlProxy implementation

  async getAccessibilityHierarchy(
    queryOptions?: ViewHierarchyQueryOptions,
    perf?: PerformanceTracker,
    skipWaitForFresh?: boolean,
    minTimestamp?: number,
  ): Promise<ViewHierarchyResult | null> {
    this.hierarchyRequestCount++;
    await this.applyDelay("getHierarchy");
    this.checkFailure("getHierarchy");

    if (!this.hierarchyData) {
      return null;
    }

    return this.convertToViewHierarchyResult(this.hierarchyData);
  }

  async getLatestHierarchy(
    waitForFresh: boolean = false,
    timeout: number = 100,
    perf?: PerformanceTracker,
    skipWaitForFresh: boolean = false,
    minTimestamp: number = 0,
  ): Promise<AccessibilityHierarchyResponse> {
    this.hierarchyRequestCount++;
    await this.applyDelay("getLatestHierarchy");
    this.checkFailure("getLatestHierarchy");

    if (!this.hierarchyData) {
      return {
        hierarchy: null,
        fresh: false,
      };
    }

    return {
      hierarchy: this.hierarchyData,
      fresh: true,
      updatedAt: this.hierarchyData.updatedAt,
      perfTiming: this.performanceTiming || undefined,
    };
  }

  async requestHierarchySync(
    perf?: PerformanceTracker,
    disableAllFiltering?: boolean,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<{ hierarchy: AccessibilityHierarchy; perfTiming?: AndroidPerfTiming[] } | null> {
    this.hierarchyRequestCount++;
    this.lastRequestHierarchySyncArgs = { disableAllFiltering, timeoutMs };
    await this.applyDelay("requestHierarchySync");
    this.checkFailure("requestHierarchySync");

    if (!this.hierarchyData) {
      return null;
    }

    return {
      hierarchy: this.hierarchyData,
      perfTiming: this.performanceTiming || undefined,
    };
  }

  convertToViewHierarchyResult(
    accessibilityHierarchy: AccessibilityHierarchy,
  ): ViewHierarchyResult {
    if (this.viewHierarchyResultOverride) {
      return this.viewHierarchyResultOverride;
    }
    // Simple conversion - just wrap the hierarchy
    return {
      hierarchy: {
        node: {
          $: {
            text: "Fake Hierarchy",
          },
        },
      },
      packageName: accessibilityHierarchy.packageName,
      updatedAt: accessibilityHierarchy.updatedAt,
      intentChooserDetected: accessibilityHierarchy.intentChooserDetected,
      notificationPermissionDetected: accessibilityHierarchy.notificationPermissionDetected,
    };
  }

  async requestSwipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    duration: number = 300,
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
    frameContext?: string,
    onDispatch?: () => void,
    signal?: AbortSignal,
    displayId?: number,
    beforeSend?: () => void,
  ): Promise<A11ySwipeResult> {
    await this.applyDelay("swipe");
    beforeSend?.();
    if (this.swipeDispatchesBeforeResult) {
      onDispatch?.();
    }
    this.checkFailure("swipe");

    this.swipeHistory.push({
      x1,
      y1,
      x2,
      y2,
      duration,
      ...(signal ? { signal } : {}),
      ...(displayId === undefined ? {} : { displayId }),
    });

    if (this.swipeResult) {
      return this.swipeResult;
    }

    return {
      success: true,
      totalTimeMs: duration,
      gestureTimeMs: duration,
      perfTiming: this.performanceTiming || undefined,
    };
  }

  async requestDrag(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    pressDurationMs: number,
    dragDurationMs: number,
    holdDurationMs: number,
    timeoutMs: number,
    frameContext?: string,
    signal?: AbortSignal,
    displayId?: number,
    beforeSend?: () => void,
    onDispatch?: () => void,
  ): Promise<A11yDragResult> {
    await this.applyDelay("drag");
    beforeSend?.();
    this.checkFailure("drag");

    this.dragHistory.push({
      x1,
      y1,
      x2,
      y2,
      pressDurationMs,
      dragDurationMs,
      holdDurationMs,
      timeoutMs,
      ...(signal ? { signal } : {}),
      ...(displayId === undefined ? {} : { displayId }),
    });

    onDispatch?.();

    if (this.dragResult) {
      const perfTiming = this.dragResult.perfTiming ?? this.performanceTiming ?? undefined;
      return {
        ...this.dragResult,
        perfTiming,
      };
    }

    return {
      success: true,
      totalTimeMs: pressDurationMs + dragDurationMs + holdDurationMs,
      gestureTimeMs: dragDurationMs,
      perfTiming: this.performanceTiming || undefined,
    };
  }

  async requestPinch(
    centerX: number,
    centerY: number,
    distanceStart: number,
    distanceEnd: number,
    rotationDegrees: number,
    duration?: number,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
    displayId?: number,
    beforeSend?: () => void,
  ): Promise<A11yPinchResult> {
    await this.applyDelay("pinch");
    beforeSend?.();
    this.checkFailure("pinch");

    this.pinchHistory.push({
      centerX,
      centerY,
      distanceStart,
      distanceEnd,
      rotationDegrees,
      duration,
      timeoutMs,
      ...(signal ? { signal } : {}),
      ...(displayId === undefined ? {} : { displayId }),
    });

    if (this.pinchResult) {
      const perfTiming = this.pinchResult.perfTiming ?? this.performanceTiming ?? undefined;
      return {
        ...this.pinchResult,
        perfTiming,
      };
    }

    const resolvedDuration = duration ?? 300;

    return {
      success: true,
      totalTimeMs: resolvedDuration,
      gestureTimeMs: resolvedDuration,
      perfTiming: this.performanceTiming || undefined,
    };
  }

  async requestSetText(text: string, options?: SetTextOptions): Promise<A11ySetTextResult> {
    await this.applyDelay("setText");
    this.checkFailure("setText");

    this.setTextHistory.push({ text, resourceId: options?.resourceId });

    return {
      success: true,
      totalTimeMs: 100,
      perfTiming: this.performanceTiming || undefined,
    };
  }

  async requestInsertText(
    text: string,
    _timeoutMs?: number,
    _perf?: PerformanceTracker,
    _options?: Parameters<AndroidCtrlProxy["requestInsertText"]>[3],
    _transport?: Pick<SetTextOptions, "abortSignal" | "onDispatch" | "deadlineMs">,
  ): Promise<A11ySetTextResult> {
    return this.requestSetText(text);
  }

  async requestClearText(
    resourceId?: string,
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
  ): Promise<A11ySetTextResult> {
    await this.applyDelay("clearText");
    this.checkFailure("clearText");

    // Clear text is essentially setText with empty string
    this.setTextHistory.push({ text: "", resourceId });

    if (this.clearTextResult) {
      return this.clearTextResult;
    }

    return {
      success: true,
      totalTimeMs: 100,
      perfTiming: this.performanceTiming || undefined,
    };
  }

  async requestImeAction(
    action: "done" | "next" | "search" | "send" | "go" | "previous",
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
    _abortSignal?: AbortSignal,
    _onDispatch?: () => void,
  ): Promise<A11yImeActionResult> {
    await this.applyDelay("imeAction");

    // Check for failure and return error result instead of throwing
    const error = this.failureMap.get("imeAction");
    if (error) {
      return {
        success: false,
        action,
        totalTimeMs: 100,
        error: error.message,
        perfTiming: this.performanceTiming || undefined,
      };
    }

    this.imeActionHistory.push({ action });

    return {
      success: true,
      action,
      totalTimeMs: 100,
      perfTiming: this.performanceTiming || undefined,
    };
  }

  async requestSelectAll(
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
  ): Promise<A11ySelectAllResult> {
    await this.applyDelay("selectAll");
    this.checkFailure("selectAll");

    return {
      success: true,
      totalTimeMs: 100,
      perfTiming: this.performanceTiming || undefined,
    };
  }

  async requestAddHighlight(
    id: string,
    shape: HighlightShape,
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
  ): Promise<HighlightOperationResult> {
    await this.applyDelay("addHighlight");
    this.checkFailure("addHighlight");
    return {
      success: true,
    };
  }

  async requestScreenshot(
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
  ): Promise<ScreenshotResult> {
    this.screenshotRequestCount++;
    await this.applyDelay("screenshot");
    this.checkFailure("screenshot");

    if (!this.screenshotData) {
      return {
        success: false,
        error: "No screenshot data configured",
      };
    }

    return {
      success: true,
      data: this.screenshotData,
      format: this.screenshotFormat,
      timestamp: Date.now(),
    };
  }

  async requestAction(
    action: string,
    resourceId?: string,
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
  ): Promise<A11yActionResult> {
    await this.applyDelay("requestAction");
    this.checkFailure("requestAction");

    this.actionHistory.push({ action, resourceId, timeoutMs });

    if (this.actionResult) {
      return this.actionResult;
    }

    return {
      success: true,
      action,
      totalTimeMs: 100,
      perfTiming: this.performanceTiming || undefined,
    };
  }

  async requestNodeAction(
    action: string,
    selector: AccessibilityNodeSelector,
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<A11yActionResult> {
    await this.applyDelay("requestNodeAction");
    this.checkFailure("requestNodeAction");
    this.nodeActionHistory.push({ action, selector: { ...selector }, timeoutMs, perf, signal });
    return (
      this.actionResult ?? {
        success: true,
        action,
        totalTimeMs: 100,
        perfTiming: this.performanceTiming || undefined,
      }
    );
  }

  async supportsNodeActionSelectors(
    _perf?: PerformanceTracker,
    _signal?: AbortSignal,
  ): Promise<boolean> {
    return this.nodeActionSelectorsSupported;
  }

  async supportsAccessibilityLinkActivation(): Promise<boolean> {
    return true;
  }

  async requestActivateAccessibilityLink(
    text: string,
    occurrence: number,
    selector?: AccessibilityNodeSelector,
    timeoutMs: number = 5000,
    _perf?: PerformanceTracker,
    signal?: AbortSignal,
    onDispatch?: () => void,
  ): Promise<A11yActionResult> {
    signal?.throwIfAborted();
    await this.applyDelay("requestActivateAccessibilityLink");
    this.checkFailure("requestActivateAccessibilityLink");
    signal?.throwIfAborted();
    onDispatch?.();
    this.actionHistory.push({
      action: "activate_accessibility_link",
      resourceId: selector?.resourceId,
      timeoutMs,
    });
    return {
      success: true,
      action: "activate_accessibility_link",
      totalTimeMs: 100,
    };
  }

  async requestTwoFingerSwipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    duration: number = 300,
    offset: number = 100,
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
    displayId?: number,
    beforeSend?: () => void,
  ): Promise<A11ySwipeResult> {
    await this.applyDelay("requestTwoFingerSwipe");
    beforeSend?.();
    this.checkFailure("requestTwoFingerSwipe");

    this.twoFingerSwipeHistory.push({
      x1,
      y1,
      x2,
      y2,
      duration,
      offset,
      timeoutMs,
      ...(displayId === undefined ? {} : { displayId }),
    });

    if (this.twoFingerSwipeResult) {
      return this.twoFingerSwipeResult;
    }

    return {
      success: true,
      totalTimeMs: duration,
      gestureTimeMs: duration,
      perfTiming: this.performanceTiming || undefined,
    };
  }

  isConnected(): boolean {
    return this.isConnectedState;
  }

  async ensureConnected(): Promise<boolean> {
    this.isConnectedState = true;
    return this.isConnectedState;
  }

  resetConnectionBudget(): void {
    // Fake never gates on a connection-attempt cooldown; nothing to reset.
  }

  terminateStaleConnection(): void {
    // Fake has no real socket to terminate; model it as an ordinary
    // disconnect so callers exercising issue #7554's fallback see the same
    // isConnected() transition a real client would.
    this.isConnectedState = false;
  }

  hasCachedHierarchy(): boolean {
    return this.hasCachedHierarchyState;
  }

  invalidateCache(): void {
    this.hasCachedHierarchyState = false;
  }

  clearCache(): void {
    this.hasCachedHierarchyState = false;
  }

  async close(): Promise<void> {
    this.isConnectedState = false;
  }
}

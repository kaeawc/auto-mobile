import type { PinchRequest } from "../../src/features/observe/shared/SharedGestureDelegate";
import type { TwoFingerSwipeRequest } from "../../src/features/observe/android/types";
import type { TapCoordinatesRequest } from "../../src/features/observe/shared/SharedGestureDelegate";
import type {
  AndroidAccessibilityActionRequest,
  AndroidActivateAccessibilityLinkRequest,
} from "../../src/features/observe/android/AndroidActionDispatcher";
import type { PrototypeShowOverrides } from "../../src/features/prototype/PrototypeTransport";
import type {
  PrototypePatchReply,
  PrototypePatchRequest,
} from "../../src/features/prototype/prototypePatchWire";
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
import type { PrototypeSpec } from "../../src/features/prototype/prototypeSpec";
import type { PrototypeChannelHost } from "../../src/features/prototype/prototypeChannelHost";
import type { PrototypeRequestHost } from "../../src/features/prototype/prototypeRequestHandler";
import type { PrototypeAssetUpload } from "../../src/features/prototype/prototypeAssets";
import type { PrototypeAssetRequestOptions } from "../../src/features/observe/android/CtrlProxyPrototypes";
import type {
  PrototypeAppearanceOverride,
  PrototypeAssetResult,
  PrototypeDismiss,
  PrototypeEvent,
  PrototypeResult,
} from "../../src/features/observe/android/ctrlProxyProtocol";
import type { SetTextOptions } from "../../src/features/observe/DeviceService";
import { HighlightOperationResult, HighlightShape, ViewHierarchyResult } from "../../src/models";
import { ViewHierarchyQueryOptions } from "../../src/models/ViewHierarchyQueryOptions";
import type { AccessibilityHierarchyRequest } from "../../src/utils/interfaces/DeviceService";
import { PerformanceTracker } from "../../src/utils/PerformanceTracker";
import type { DragRequest } from "../../src/utils/interfaces/DragRequest";
import type { SwipeRequest } from "../../src/utils/interfaces/SwipeRequest";
import { defaultTimer, Timer } from "../../src/utils/SystemTimer";

/**
 * Fake implementation of CtrlProxy for testing
 * Allows configuring responses for hierarchy, screenshots, and gesture operations
 * Tracks method calls for test assertions
 */
export class FakeCtrlProxy implements AndroidCtrlProxy {
  constructor(private readonly timer: Timer = defaultTimer) {}

  private prototypeRequestHost: PrototypeRequestHost | undefined;
  private prototypeChannelHost: PrototypeChannelHost | undefined;
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
  private probeEvents: PrototypeEvent[] = [];
  /** Events a capability probe delivers, as a device draining its offline ring on connect. */
  setProbeEvents(events: PrototypeEvent[]): void {
    this.probeEvents = events;
  }
  async supportsCommand(name: string): Promise<boolean> {
    const events = this.probeEvents;
    this.probeEvents = [];
    for (const event of events) {
      this.emitPrototypeEvent(event);
    }
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

  private tapResult: A11yTapCoordinatesResult | null = null;
  /**
   * Configure the result requestTapCoordinates returns, e.g. a device refusal
   * (`{ success: false, error }`), which the real client reports as a result, not a throw.
   * @param result - The tap result to return (or null for the default success)
   */
  setTapResult(result: A11yTapCoordinatesResult | null): void {
    this.tapResult = result;
  }

  private readonly gestureRequestLog: Array<Record<string, unknown> & { type: string }> = [];
  /** Gesture requests (tap, swipe, drag) in the order they arrived, shaped like the wire frames. */
  getGestureRequestLog(): Array<Record<string, unknown> & { type: string }> {
    return this.gestureRequestLog.map((request) => ({ ...request }));
  }
  async requestTapCoordinates(request: TapCoordinatesRequest): Promise<A11yTapCoordinatesResult> {
    const { x, y, duration = 10, onDispatch, signal, displayId, beforeSend } = request;

    beforeSend?.();
    this.checkFailure("tap");
    this.tapHistory.push({
      x,
      y,
      duration,
      ...(signal ? { signal } : {}),
      ...(displayId === undefined ? {} : { displayId }),
    });
    this.gestureRequestLog.push({ type: "request_tap_coordinates", x, y, duration });
    onDispatch?.();
    return this.tapResult ?? { success: true, totalTimeMs: duration };
  }

  readonly saveRequests: { spec: PrototypeSpec; label: string; icon?: string }[] = [];
  readonly pinRequests: { id: string; icon?: string }[] = [];
  private pinResult: PrototypeResult = { success: true };
  setPinResult(result: PrototypeResult): void {
    this.pinResult = result;
  }
  async requestPinSavedPrototype(
    id: string,
    icon?: string,
    _timeoutMs?: number,
    _perf?: PerformanceTracker,
  ): Promise<PrototypeResult> {
    this.pinRequests.push({ id, ...(icon === undefined ? {} : { icon }) });
    this.checkFailure("requestPinSavedPrototype");
    return this.pinResult;
  }
  readonly deleteRequests: string[] = [];
  listCalls = 0;
  private saveResult: PrototypeResult = { success: true };
  private listSavedResult: PrototypeResult = { success: true };
  private deleteResult: PrototypeResult = { success: true };
  setSaveResult(result: PrototypeResult): void {
    this.saveResult = result;
  }
  setListSavedResult(result: PrototypeResult): void {
    this.listSavedResult = result;
  }
  setDeleteResult(result: PrototypeResult): void {
    this.deleteResult = result;
  }
  async requestSavePrototype(
    save: { spec: PrototypeSpec; label: string; icon?: string },
    _timeoutMs?: number,
    _perf?: PerformanceTracker,
  ): Promise<PrototypeResult> {
    this.saveRequests.push(structuredClone(save));
    this.checkFailure("requestSavePrototype");
    return this.saveResult;
  }
  async requestListSavedPrototypes(
    _timeoutMs?: number,
    _perf?: PerformanceTracker,
  ): Promise<PrototypeResult> {
    this.listCalls++;
    this.checkFailure("requestListSavedPrototypes");
    return this.listSavedResult;
  }
  async requestDeleteSavedPrototype(
    id: string,
    _timeoutMs?: number,
    _perf?: PerformanceTracker,
  ): Promise<PrototypeResult> {
    this.deleteRequests.push(id);
    this.checkFailure("requestDeleteSavedPrototype");
    return this.deleteResult;
  }

  readonly advanceClockRequests: { id: string; advanceTimeMs: number }[] = [];
  private advanceClockResult: PrototypeResult = { success: true, fired: 0 };
  setAdvanceClockResult(result: PrototypeResult): void {
    this.advanceClockResult = result;
  }
  async requestAdvancePrototypeClock(
    id: string,
    advanceTimeMs: number,
    _timeoutMs?: number,
    _perf?: PerformanceTracker,
  ): Promise<PrototypeResult> {
    this.advanceClockRequests.push({ id, advanceTimeMs });
    this.checkFailure("requestAdvancePrototypeClock");
    return this.advanceClockResult;
  }
  readonly clearStorageRequests: string[] = [];
  private clearStorageResult: PrototypeResult = { success: true, cleared: 0 };
  setClearStorageResult(result: PrototypeResult): void {
    this.clearStorageResult = result;
  }
  async requestClearPrototypeStorage(
    id: string,
    _timeoutMs?: number,
    _perf?: PerformanceTracker,
  ): Promise<PrototypeResult> {
    this.clearStorageRequests.push(id);
    this.checkFailure("requestClearPrototypeStorage");
    return this.clearStorageResult;
  }

  readonly patchRequests: PrototypePatchRequest[] = [];
  private patchResult: PrototypePatchReply = { success: true, delivery: "answered" };
  private patchHold?: Promise<PrototypeResult>;
  private showHold?: Promise<PrototypeResult>;

  setPatchResult(result: PrototypeResult & Partial<Pick<PrototypePatchReply, "delivery">>): void {
    this.patchResult = { delivery: "answered", ...result };
  }
  holdPatchReply(reply: Promise<PrototypeResult>): void {
    this.patchHold = reply;
  }
  holdShowReply(reply: Promise<PrototypeResult>): void {
    this.showHold = reply;
  }

  async requestPatchPrototype(
    patch: PrototypePatchRequest,
    _timeoutMs?: number,
    _perf?: PerformanceTracker,
  ): Promise<PrototypePatchReply> {
    this.patchRequests.push(structuredClone(patch));
    this.checkFailure("requestPatchPrototype");
    const hold = this.patchHold;
    this.patchHold = undefined;
    return hold ? { delivery: "answered", ...(await hold) } : this.patchResult;
  }

  private prototypeResult: PrototypeResult = { success: true };
  private readonly prototypeHistory: Array<
    | {
        method: "show";
        spec: PrototypeSpec;
        timeoutMs: number;
        perf?: PerformanceTracker;
        displayId?: number;
        reset?: boolean;
        replaceOthers?: boolean;
        appearance?: PrototypeAppearanceOverride;
        locale?: string;
      }
    | { method: "dismiss"; target: PrototypeDismiss; timeoutMs: number; perf?: PerformanceTracker }
  > = [];
  private readonly prototypeListeners = new Set<(event: PrototypeEvent) => void>();

  private readonly queuedPrototypeResults: PrototypeResult[] = [];

  setPrototypeResult(result: PrototypeResult): void {
    this.prototypeResult = result;
  }

  /** Results returned, in order, by the next show requests before the default. */
  queuePrototypeResults(...results: PrototypeResult[]): void {
    this.queuedPrototypeResults.push(...results);
  }

  private nextPrototypeResult(): PrototypeResult {
    return this.queuedPrototypeResults.shift() ?? this.prototypeResult;
  }

  getPrototypeHistory() {
    return [...this.prototypeHistory];
  }

  async requestShowPrototype(
    spec: PrototypeSpec,
    timeoutMs = 5000,
    perf?: PerformanceTracker,
    displayId?: number,
    reset?: boolean,
    appearance?: PrototypeAppearanceOverride | PrototypeShowOverrides,
  ): Promise<PrototypeResult> {
    this.checkFailure("requestShowPrototype");
    const overrides = typeof appearance === "string" ? { appearance } : appearance;
    this.prototypeHistory.push({
      method: "show",
      spec,
      timeoutMs,
      perf,
      ...(displayId === undefined ? {} : { displayId }),
      ...(reset === undefined ? {} : { reset }),
      ...(overrides?.locale === undefined ? {} : { locale: overrides.locale }),
      ...(overrides?.appearance === undefined ? {} : { appearance: overrides.appearance }),
      ...(overrides?.replaceOthers === false ? { replaceOthers: false } : {}),
    });
    const hold = this.showHold;
    this.showHold = undefined;
    return hold ?? this.nextPrototypeResult();
  }

  async requestDismissPrototype(
    target: PrototypeDismiss,
    timeoutMs = 5000,
    perf?: PerformanceTracker,
  ): Promise<PrototypeResult> {
    this.checkFailure("requestDismissPrototype");
    this.prototypeHistory.push({ method: "dismiss", target, timeoutMs, perf });
    return this.prototypeResult;
  }

  private inspectReply: { events: PrototypeEvent[]; result: PrototypeResult } = {
    events: [],
    result: { success: true, prototypes: [], droppedEvents: 0 },
  };
  private inspectCount = 0;

  /** What the next inspect delivers: `events` first (as the device replays), then `result`. */
  setInspectReply(result: PrototypeResult, events: PrototypeEvent[] = []): void {
    this.inspectReply = { events, result };
  }

  getInspectCount(): number {
    return this.inspectCount;
  }

  async requestInspectPrototypes(
    _timeoutMs = 5000,
    _perf?: PerformanceTracker,
  ): Promise<PrototypeResult> {
    this.checkFailure("requestInspectPrototypes");
    this.inspectCount++;
    for (const event of this.inspectReply.events) {
      this.emitPrototypeEvent(event);
    }
    return this.inspectReply.result;
  }

  private prototypeAssetResult: PrototypeAssetResult = {
    success: true,
    dispatched: true,
    acknowledged: true,
  };
  private readonly prototypeAssetHistory: Array<
    | { method: "put"; asset: PrototypeAssetUpload; options?: PrototypeAssetRequestOptions }
    | { method: "remove"; id: string; options?: PrototypeAssetRequestOptions }
  > = [];

  setPrototypeAssetResult(result: PrototypeAssetResult): void {
    this.prototypeAssetResult = result;
  }

  getPrototypeAssetHistory() {
    return [...this.prototypeAssetHistory];
  }

  async requestPutPrototypeAsset(
    asset: PrototypeAssetUpload,
    options?: PrototypeAssetRequestOptions,
  ): Promise<PrototypeAssetResult> {
    this.checkFailure("requestPutPrototypeAsset");
    this.prototypeAssetHistory.push({ method: "put", asset, options });
    return this.prototypeAssetResult;
  }

  async requestRemovePrototypeAsset(
    id: string,
    options?: PrototypeAssetRequestOptions,
  ): Promise<PrototypeAssetResult> {
    this.checkFailure("requestRemovePrototypeAsset");
    this.prototypeAssetHistory.push({ method: "remove", id, options });
    return this.prototypeAssetResult;
  }

  onPrototypeEvent(listener: (event: PrototypeEvent) => void): () => void {
    this.prototypeListeners.add(listener);
    return () => {
      this.prototypeListeners.delete(listener);
    };
  }

  getPrototypeListenerCount(): number {
    return this.prototypeListeners.size;
  }

  emitPrototypeEvent(event: PrototypeEvent): void {
    for (const listener of this.prototypeListeners) {
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
  private waitForConnectionResult: boolean | undefined;
  private lastConnectionFailure: { forwardingLeaseConflict: boolean; message?: string } | undefined;

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
    request?: AccessibilityHierarchyRequest,
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

  async requestSwipe(request: SwipeRequest): Promise<A11ySwipeResult> {
    const { x1, y1, x2, y2, onDispatch, beforeSend, signal, displayId } = request;
    const { duration = 300 } = request;
    await this.applyDelay("swipe");
    beforeSend?.();
    if (this.swipeDispatchesBeforeResult) {
      onDispatch?.();
    }
    this.checkFailure("swipe");

    this.gestureRequestLog.push({ type: "request_swipe", x1, y1, x2, y2, duration });
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

  async requestDrag(request: DragRequest): Promise<A11yDragResult> {
    const { x1, y1, x2, y2, pressDurationMs, dragDurationMs, holdDurationMs, timeoutMs } = request;
    const { signal, displayId, beforeSend, onDispatch } = request;
    await this.applyDelay("drag");
    beforeSend?.();
    this.checkFailure("drag");

    this.gestureRequestLog.push({
      type: "request_drag",
      x1,
      y1,
      x2,
      y2,
      pressDurationMs,
      dragDurationMs,
      holdDurationMs,
    });
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

  async requestPinch(request: PinchRequest): Promise<A11yPinchResult> {
    const {
      centerX,
      centerY,
      distanceStart,
      distanceEnd,
      rotationDegrees,
      duration,
      timeoutMs,
      signal,
      displayId,
      beforeSend,
    } = request;

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

  async requestClickFocusedInput(
    _timeoutMs: number = 5000,
    _perf?: PerformanceTracker,
    _signal?: AbortSignal,
  ): Promise<A11yActionResult> {
    await this.applyDelay("requestClickFocusedInput");
    this.checkFailure("requestClickFocusedInput");
    return this.actionResult ?? { success: true, action: "click", totalTimeMs: 100 };
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
    request: AndroidActivateAccessibilityLinkRequest,
  ): Promise<A11yActionResult> {
    const { selector, timeoutMs = 5000, signal, onDispatch } = request;

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

  async requestAccessibilityAction(
    request: AndroidAccessibilityActionRequest,
  ): Promise<A11yActionResult> {
    request.signal?.throwIfAborted();
    await this.applyDelay("requestAccessibilityAction");
    this.checkFailure("requestAccessibilityAction");
    this.actionHistory.push({
      action: request.action,
      resourceId: request.resourceId,
      timeoutMs: request.timeoutMs ?? 5000,
    });
    return { success: true, action: request.action, totalTimeMs: 100 };
  }

  async requestTwoFingerSwipe(request: TwoFingerSwipeRequest): Promise<A11ySwipeResult> {
    const {
      x1,
      y1,
      x2,
      y2,
      duration = 300,
      offset = 100,
      timeoutMs = 5000,
      displayId,
      beforeSend,
    } = request;

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

  setRecompositionTrackingEnabled(
    ..._args: Parameters<AndroidCtrlProxy["setRecompositionTrackingEnabled"]>
  ): ReturnType<AndroidCtrlProxy["setRecompositionTrackingEnabled"]> {
    throw new Error("FakeCtrlProxy.setRecompositionTrackingEnabled is not scripted");
  }

  requestHierarchySyncWithoutObservationStreamPush(): never {
    throw new Error(
      "FakeCtrlProxy.requestHierarchySyncWithoutObservationStreamPush is not scripted",
    );
  }

  requestInsertTextState(
    ..._args: Parameters<AndroidCtrlProxy["requestInsertTextState"]>
  ): ReturnType<AndroidCtrlProxy["requestInsertTextState"]> {
    throw new Error("FakeCtrlProxy.requestInsertTextState is not scripted");
  }

  commitViaIme(
    ..._args: Parameters<AndroidCtrlProxy["commitViaIme"]>
  ): ReturnType<AndroidCtrlProxy["commitViaIme"]> {
    throw new Error("FakeCtrlProxy.commitViaIme is not scripted");
  }

  setKeyboardProfile(
    ..._args: Parameters<AndroidCtrlProxy["setKeyboardProfile"]>
  ): ReturnType<AndroidCtrlProxy["setKeyboardProfile"]> {
    throw new Error("FakeCtrlProxy.setKeyboardProfile is not scripted");
  }

  listKeyboardProfiles(
    ..._args: Parameters<AndroidCtrlProxy["listKeyboardProfiles"]>
  ): ReturnType<AndroidCtrlProxy["listKeyboardProfiles"]> {
    throw new Error("FakeCtrlProxy.listKeyboardProfiles is not scripted");
  }

  requestClipboard(
    ..._args: Parameters<AndroidCtrlProxy["requestClipboard"]>
  ): ReturnType<AndroidCtrlProxy["requestClipboard"]> {
    throw new Error("FakeCtrlProxy.requestClipboard is not scripted");
  }

  requestSettingsGet(
    ..._args: Parameters<AndroidCtrlProxy["requestSettingsGet"]>
  ): ReturnType<AndroidCtrlProxy["requestSettingsGet"]> {
    throw new Error("FakeCtrlProxy.requestSettingsGet is not scripted");
  }

  requestSettingsPut(
    ..._args: Parameters<AndroidCtrlProxy["requestSettingsPut"]>
  ): ReturnType<AndroidCtrlProxy["requestSettingsPut"]> {
    throw new Error("FakeCtrlProxy.requestSettingsPut is not scripted");
  }

  requestSettingsList(
    ..._args: Parameters<AndroidCtrlProxy["requestSettingsList"]>
  ): ReturnType<AndroidCtrlProxy["requestSettingsList"]> {
    throw new Error("FakeCtrlProxy.requestSettingsList is not scripted");
  }

  requestInstallCaCertificate(
    ..._args: Parameters<AndroidCtrlProxy["requestInstallCaCertificate"]>
  ): ReturnType<AndroidCtrlProxy["requestInstallCaCertificate"]> {
    throw new Error("FakeCtrlProxy.requestInstallCaCertificate is not scripted");
  }

  requestInstallCaCertificateFromFile(
    ..._args: Parameters<AndroidCtrlProxy["requestInstallCaCertificateFromFile"]>
  ): ReturnType<AndroidCtrlProxy["requestInstallCaCertificateFromFile"]> {
    throw new Error("FakeCtrlProxy.requestInstallCaCertificateFromFile is not scripted");
  }

  requestRemoveCaCertificate(
    ..._args: Parameters<AndroidCtrlProxy["requestRemoveCaCertificate"]>
  ): ReturnType<AndroidCtrlProxy["requestRemoveCaCertificate"]> {
    throw new Error("FakeCtrlProxy.requestRemoveCaCertificate is not scripted");
  }

  requestDeviceOwnerStatus(
    ..._args: Parameters<AndroidCtrlProxy["requestDeviceOwnerStatus"]>
  ): ReturnType<AndroidCtrlProxy["requestDeviceOwnerStatus"]> {
    throw new Error("FakeCtrlProxy.requestDeviceOwnerStatus is not scripted");
  }

  requestPermission(
    ..._args: Parameters<AndroidCtrlProxy["requestPermission"]>
  ): ReturnType<AndroidCtrlProxy["requestPermission"]> {
    throw new Error("FakeCtrlProxy.requestPermission is not scripted");
  }

  requestScreenshotWithoutObservationStreamPush(
    ..._args: Parameters<AndroidCtrlProxy["requestScreenshotWithoutObservationStreamPush"]>
  ): ReturnType<AndroidCtrlProxy["requestScreenshotWithoutObservationStreamPush"]> {
    throw new Error("FakeCtrlProxy.requestScreenshotWithoutObservationStreamPush is not scripted");
  }

  requestInstalledPackages(
    ..._args: Parameters<AndroidCtrlProxy["requestInstalledPackages"]>
  ): ReturnType<AndroidCtrlProxy["requestInstalledPackages"]> {
    throw new Error("FakeCtrlProxy.requestInstalledPackages is not scripted");
  }

  requestPackageInfo(
    ..._args: Parameters<AndroidCtrlProxy["requestPackageInfo"]>
  ): ReturnType<AndroidCtrlProxy["requestPackageInfo"]> {
    throw new Error("FakeCtrlProxy.requestPackageInfo is not scripted");
  }

  requestLaunchIntent(
    ..._args: Parameters<AndroidCtrlProxy["requestLaunchIntent"]>
  ): ReturnType<AndroidCtrlProxy["requestLaunchIntent"]> {
    throw new Error("FakeCtrlProxy.requestLaunchIntent is not scripted");
  }

  sendMessage(
    ..._args: Parameters<AndroidCtrlProxy["sendMessage"]>
  ): ReturnType<AndroidCtrlProxy["sendMessage"]> {
    throw new Error("FakeCtrlProxy.sendMessage is not scripted");
  }

  getSupportedCommands(
    ..._args: Parameters<AndroidCtrlProxy["getSupportedCommands"]>
  ): ReturnType<AndroidCtrlProxy["getSupportedCommands"]> {
    throw new Error("FakeCtrlProxy.getSupportedCommands is not scripted");
  }

  /** Result {@link waitForConnection} reports; defaults to the {@link setConnected} state. */
  setWaitForConnectionResult(connected: boolean): void {
    this.waitForConnectionResult = connected;
  }

  async waitForConnection(
    ..._args: Parameters<AndroidCtrlProxy["waitForConnection"]>
  ): ReturnType<AndroidCtrlProxy["waitForConnection"]> {
    return this.waitForConnectionResult ?? this.isConnectedState;
  }

  /** Record the most recent connect failure a real client would report. */
  setLastConnectionFailure(failure: { forwardingLeaseConflict: boolean; message?: string }): void {
    this.lastConnectionFailure = failure;
  }

  isLastConnectionFailureForwardingLeaseConflict(): boolean {
    return this.lastConnectionFailure?.forwardingLeaseConflict ?? false;
  }

  getLastConnectionFailureMessage(): string | undefined {
    return this.lastConnectionFailure?.message;
  }

  async verifyServiceReady(): Promise<boolean> {
    return this.isConnectedState;
  }

  /** Like a runner without the atomic double-tap command: nothing is sent, callers fall back to two taps. */
  async requestDoubleTapCoordinates(): Promise<A11yTapCoordinatesResult> {
    return { success: false, totalTimeMs: 0, error: "double-tap command unsupported by the fake" };
  }

  requestMultiFingerSwipe(
    ..._args: Parameters<AndroidCtrlProxy["requestMultiFingerSwipe"]>
  ): ReturnType<AndroidCtrlProxy["requestMultiFingerSwipe"]> {
    throw new Error("FakeCtrlProxy.requestMultiFingerSwipe is not scripted");
  }

  requestGestureStart(
    ..._args: Parameters<AndroidCtrlProxy["requestGestureStart"]>
  ): ReturnType<AndroidCtrlProxy["requestGestureStart"]> {
    throw new Error("FakeCtrlProxy.requestGestureStart is not scripted");
  }

  requestGestureMove(
    ..._args: Parameters<AndroidCtrlProxy["requestGestureMove"]>
  ): ReturnType<AndroidCtrlProxy["requestGestureMove"]> {
    throw new Error("FakeCtrlProxy.requestGestureMove is not scripted");
  }

  requestGestureEnd(
    ..._args: Parameters<AndroidCtrlProxy["requestGestureEnd"]>
  ): ReturnType<AndroidCtrlProxy["requestGestureEnd"]> {
    throw new Error("FakeCtrlProxy.requestGestureEnd is not scripted");
  }

  listPreferenceFiles(
    ..._args: Parameters<AndroidCtrlProxy["listPreferenceFiles"]>
  ): ReturnType<AndroidCtrlProxy["listPreferenceFiles"]> {
    throw new Error("FakeCtrlProxy.listPreferenceFiles is not scripted");
  }

  getPreferenceEntries(
    ..._args: Parameters<AndroidCtrlProxy["getPreferenceEntries"]>
  ): ReturnType<AndroidCtrlProxy["getPreferenceEntries"]> {
    throw new Error("FakeCtrlProxy.getPreferenceEntries is not scripted");
  }

  discoverKeystore(
    ..._args: Parameters<AndroidCtrlProxy["discoverKeystore"]>
  ): ReturnType<AndroidCtrlProxy["discoverKeystore"]> {
    throw new Error("FakeCtrlProxy.discoverKeystore is not scripted");
  }

  getSdkCapabilities(
    ..._args: Parameters<AndroidCtrlProxy["getSdkCapabilities"]>
  ): ReturnType<AndroidCtrlProxy["getSdkCapabilities"]> {
    throw new Error("FakeCtrlProxy.getSdkCapabilities is not scripted");
  }

  listDataStores(
    ..._args: Parameters<AndroidCtrlProxy["listDataStores"]>
  ): ReturnType<AndroidCtrlProxy["listDataStores"]> {
    throw new Error("FakeCtrlProxy.listDataStores is not scripted");
  }

  getDataStore(
    ..._args: Parameters<AndroidCtrlProxy["getDataStore"]>
  ): ReturnType<AndroidCtrlProxy["getDataStore"]> {
    throw new Error("FakeCtrlProxy.getDataStore is not scripted");
  }

  setPreference(
    ..._args: Parameters<AndroidCtrlProxy["setPreference"]>
  ): ReturnType<AndroidCtrlProxy["setPreference"]> {
    throw new Error("FakeCtrlProxy.setPreference is not scripted");
  }

  removePreference(
    ..._args: Parameters<AndroidCtrlProxy["removePreference"]>
  ): ReturnType<AndroidCtrlProxy["removePreference"]> {
    throw new Error("FakeCtrlProxy.removePreference is not scripted");
  }

  deleteKeychainItemForIos(
    ..._args: Parameters<
      import("../../src/features/observe/ios/CtrlProxyStorage").CtrlProxyStorage["deleteKeychainItemForIos"]
    >
  ): ReturnType<
    import("../../src/features/observe/ios/CtrlProxyStorage").CtrlProxyStorage["deleteKeychainItemForIos"]
  > {
    throw new Error("FakeCtrlProxy.deleteKeychainItemForIos is not scripted");
  }

  clearPreferenceStore(
    ..._args: Parameters<AndroidCtrlProxy["clearPreferenceStore"]>
  ): ReturnType<AndroidCtrlProxy["clearPreferenceStore"]> {
    throw new Error("FakeCtrlProxy.clearPreferenceStore is not scripted");
  }

  clearAccessibilityFocus(
    ..._args: Parameters<AndroidCtrlProxy["clearAccessibilityFocus"]>
  ): ReturnType<AndroidCtrlProxy["clearAccessibilityFocus"]> {
    throw new Error("FakeCtrlProxy.clearAccessibilityFocus is not scripted");
  }

  setAccessibilityFocus(
    ..._args: Parameters<AndroidCtrlProxy["setAccessibilityFocus"]>
  ): ReturnType<AndroidCtrlProxy["setAccessibilityFocus"]> {
    throw new Error("FakeCtrlProxy.setAccessibilityFocus is not scripted");
  }

  requestCurrentFocus(
    ..._args: Parameters<AndroidCtrlProxy["requestCurrentFocus"]>
  ): ReturnType<AndroidCtrlProxy["requestCurrentFocus"]> {
    throw new Error("FakeCtrlProxy.requestCurrentFocus is not scripted");
  }

  requestTraversalOrder(
    ..._args: Parameters<AndroidCtrlProxy["requestTraversalOrder"]>
  ): ReturnType<AndroidCtrlProxy["requestTraversalOrder"]> {
    throw new Error("FakeCtrlProxy.requestTraversalOrder is not scripted");
  }

  attachPrototypeRequestHost(host: PrototypeRequestHost | undefined): void {
    this.prototypeRequestHost = host;
  }

  attachPrototypeChannelHost(host: PrototypeChannelHost | undefined): void {
    this.prototypeChannelHost = host;
  }

  getPrototypeChannelHost(): PrototypeChannelHost | undefined {
    return this.prototypeChannelHost;
  }

  getPrototypeRequestHost(): PrototypeRequestHost | undefined {
    return this.prototypeRequestHost;
  }

  invalidateForShutdownRecovery(
    ..._args: Parameters<AndroidCtrlProxy["invalidateForShutdownRecovery"]>
  ): ReturnType<AndroidCtrlProxy["invalidateForShutdownRecovery"]> {
    throw new Error("FakeCtrlProxy.invalidateForShutdownRecovery is not scripted");
  }

  getSdkScreenIdentity(
    ..._args: Parameters<AndroidCtrlProxy["getSdkScreenIdentity"]>
  ): ReturnType<AndroidCtrlProxy["getSdkScreenIdentity"]> {
    throw new Error("FakeCtrlProxy.getSdkScreenIdentity is not scripted");
  }

  getSdkScreenIdentityReceivedAtMs(
    ..._args: Parameters<AndroidCtrlProxy["getSdkScreenIdentityReceivedAtMs"]>
  ): ReturnType<AndroidCtrlProxy["getSdkScreenIdentityReceivedAtMs"]> {
    throw new Error("FakeCtrlProxy.getSdkScreenIdentityReceivedAtMs is not scripted");
  }

  awaitSdkScreenIdentityAfter(
    ..._args: Parameters<AndroidCtrlProxy["awaitSdkScreenIdentityAfter"]>
  ): ReturnType<AndroidCtrlProxy["awaitSdkScreenIdentityAfter"]> {
    throw new Error("FakeCtrlProxy.awaitSdkScreenIdentityAfter is not scripted");
  }

  pushNetworkMockRules(
    ..._args: Parameters<AndroidCtrlProxy["pushNetworkMockRules"]>
  ): ReturnType<AndroidCtrlProxy["pushNetworkMockRules"]> {
    throw new Error("FakeCtrlProxy.pushNetworkMockRules is not scripted");
  }

  requestGlobalAction(
    ..._args: Parameters<AndroidCtrlProxy["requestGlobalAction"]>
  ): ReturnType<AndroidCtrlProxy["requestGlobalAction"]> {
    throw new Error("FakeCtrlProxy.requestGlobalAction is not scripted");
  }

  validateFrameContext(
    ..._args: Parameters<AndroidCtrlProxy["validateFrameContext"]>
  ): ReturnType<AndroidCtrlProxy["validateFrameContext"]> {
    throw new Error("FakeCtrlProxy.validateFrameContext is not scripted");
  }

  requestDeviceInfo(
    ..._args: Parameters<AndroidCtrlProxy["requestDeviceInfo"]>
  ): ReturnType<AndroidCtrlProxy["requestDeviceInfo"]> {
    throw new Error("FakeCtrlProxy.requestDeviceInfo is not scripted");
  }

  onInteraction(
    ..._args: Parameters<AndroidCtrlProxy["onInteraction"]>
  ): ReturnType<AndroidCtrlProxy["onInteraction"]> {
    throw new Error("FakeCtrlProxy.onInteraction is not scripted");
  }

  notifyRecordingStarted(
    ..._args: Parameters<AndroidCtrlProxy["notifyRecordingStarted"]>
  ): ReturnType<AndroidCtrlProxy["notifyRecordingStarted"]> {
    throw new Error("FakeCtrlProxy.notifyRecordingStarted is not scripted");
  }

  notifyRecordingStopped(
    ..._args: Parameters<AndroidCtrlProxy["notifyRecordingStopped"]>
  ): ReturnType<AndroidCtrlProxy["notifyRecordingStopped"]> {
    throw new Error("FakeCtrlProxy.notifyRecordingStopped is not scripted");
  }

  recordInitialObservationStreamHierarchy(
    ..._args: Parameters<AndroidCtrlProxy["recordInitialObservationStreamHierarchy"]>
  ): ReturnType<AndroidCtrlProxy["recordInitialObservationStreamHierarchy"]> {
    throw new Error("FakeCtrlProxy.recordInitialObservationStreamHierarchy is not scripted");
  }

  getScreenScaleMetadata(
    ..._args: Parameters<AndroidCtrlProxy["getScreenScaleMetadata"]>
  ): ReturnType<AndroidCtrlProxy["getScreenScaleMetadata"]> {
    throw new Error("FakeCtrlProxy.getScreenScaleMetadata is not scripted");
  }

  captureScreenshotForObservationStream(
    ..._args: Parameters<AndroidCtrlProxy["captureScreenshotForObservationStream"]>
  ): ReturnType<AndroidCtrlProxy["captureScreenshotForObservationStream"]> {
    throw new Error("FakeCtrlProxy.captureScreenshotForObservationStream is not scripted");
  }
}

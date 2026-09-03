import { IOSCtrlProxy } from "../../src/features/observe/ios";
import {
  CtrlProxyScreenshotResult,
  CtrlProxyDragResult,
  CtrlProxyPinchResult,
  CtrlProxySwipeResult,
  CtrlProxyTapResult,
  CtrlProxySetTextResult,
  CtrlProxyImeActionResult,
  CtrlProxySelectAllResult,
  CtrlProxyKeyboardResult,
  CtrlProxyPressKeyResult,
  CtrlProxyPressHomeResult,
  CtrlProxyPressBackResult,
  CtrlProxyShakeResult,
  CtrlProxyPressButtonResult,
  CtrlProxyRecentAppsResult,
  CtrlProxyRotateResult,
  CtrlProxyLaunchAppResult,
  CtrlProxyClipboardResult,
  CtrlProxyHierarchyResponse,
  CtrlProxyPerfTiming,
  CtrlProxyHierarchy,
} from "../../src/features/observe/ios";
import type {
  CtrlProxyVoiceOverResult,
  CtrlProxyActionResult,
} from "../../src/features/observe/ios/types";
import type { SetTextOptions } from "../../src/features/observe/DeviceService";
import { ViewHierarchyResult } from "../../src/models";
import { ViewHierarchyQueryOptions } from "../../src/models/ViewHierarchyQueryOptions";
import { PerformanceTracker } from "../../src/utils/PerformanceTracker";
import { defaultTimer } from "../../src/utils/SystemTimer";
import type {
  InputKeyModifier,
  InputKeyName,
} from "../../src/features/action/InputKey";

/**
 * Fake implementation of IOSCtrlProxy for testing
 * Allows configuring responses for hierarchy, screenshots, and gesture operations
 * Tracks method calls for test assertions
 */
export class FakeIOSCtrlProxy implements IOSCtrlProxy {
  // Configurable response data
  private hierarchyData: CtrlProxyHierarchy | null = null;
  private screenshotData: string | null = null;
  private screenshotFormat: string = "png";
  private performanceTiming: CtrlProxyPerfTiming | null = null;
  private isConnectedState: boolean = true;
  private hasCachedHierarchyState: boolean = false;
  public clearCacheCallCount: number = 0;

  // Failure modes
  private failureMap: Map<string, Error> = new Map();

  // Operation delays
  private operationDelays: Map<string, number> = new Map();

  // Call history
  private tapHistory: Array<{
    x: number;
    y: number;
    duration: number;
  }> = [];

  private swipeHistory: Array<{
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    duration: number;
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
  }> = [];

  private pinchHistory: Array<{
    centerX: number;
    centerY: number;
    distanceStart: number;
    distanceEnd: number;
    rotationDegrees: number;
    duration?: number;
    timeoutMs?: number;
  }> = [];

  private setTextHistory: Array<{
    text: string;
    resourceId?: string;
  }> = [];

  private imeActionHistory: Array<{
    action: "done" | "next" | "search" | "send" | "go" | "previous";
  }> = [];

  private pressKeyHistory: Array<{ key: InputKeyName; modifiers: InputKeyModifier[] }> = [];

  private screenshotRequestCount: number = 0;
  private hierarchyRequestCount: number = 0;
  private keyboardOpen: boolean = false;
  private keyboardHistory: Array<{ action: "open" | "close" | "detect" }> = [];
  private pressHomeRequestCount: number = 0;
  private pressBackRequestCount: number = 0;
  private shakeRequestCount: number = 0;
  private shakeTimeoutHistory: number[] = [];
  private recentAppsRequestCount: number = 0;
  private rotateHistory: Array<{ orientation: string }> = [];
  private currentOrientation: string = "portrait";
  private launchAppHistory: string[] = [];
  private dragResult: CtrlProxyDragResult | null = null;
  private pinchResult: CtrlProxyPinchResult | null = null;
  private tapResult: CtrlProxyTapResult | null = null;
  private swipeResult: CtrlProxySwipeResult | null = null;
  private recentAppsResult: CtrlProxyRecentAppsResult | null = null;
  private voiceOverState: boolean = false;
  private voiceOverActivateResult: CtrlProxyActionResult | null = null;
  private setVoiceOverEnabledResult: CtrlProxyActionResult | null = null;
  private multiFingerSwipeResult: CtrlProxySwipeResult | null = null;
  private actionResult: CtrlProxyActionResult | null = null;
  private clipboardResult: CtrlProxyClipboardResult | null = null;

  // Clipboard call history
  private clipboardHistory: Array<{
    action: "copy" | "paste" | "clear" | "get";
    text?: string;
  }> = [];

  // VoiceOver call history
  private voiceOverActivateHistory: Array<{
    label: string;
    action: "activate" | "long_press";
  }> = [];

  // requestSetVoiceOverEnabled call history
  private setVoiceOverEnabledHistory: boolean[] = [];

  private actionHistory: Array<{
    action: string;
    resourceId?: string;
    label?: string;
  }> = [];

  private multiFingerSwipeHistory: Array<{
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    fingerCount: number;
    duration: number;
    fingerSpacing?: number;
  }> = [];

  // MARK: - Configuration Methods

  /**
   * Configure hierarchy data to be returned by getAccessibilityHierarchy
   */
  setHierarchyData(hierarchy: CtrlProxyHierarchy | null): void {
    this.hierarchyData = hierarchy;
  }

  /**
   * Configure screenshot data to be returned by requestScreenshot
   */
  setScreenshotData(base64Data: string | null, format: string = "png"): void {
    this.screenshotData = base64Data;
    this.screenshotFormat = format;
  }

  /**
   * Configure a failure mode for a specific operation
   */
  setFailureMode(operation: string, error: Error | null): void {
    if (error === null) {
      this.failureMap.delete(operation);
    } else {
      this.failureMap.set(operation, error);
    }
  }

  /**
   * Configure a delay for a specific operation
   */
  setOperationDelay(operation: string, delayMs: number): void {
    this.operationDelays.set(operation, delayMs);
  }

  /**
   * Set connection state
   */
  setConnected(connected: boolean): void {
    this.isConnectedState = connected;
  }

  /**
   * Set cached hierarchy state
   */
  setCachedHierarchy(hasCached: boolean): void {
    this.hasCachedHierarchyState = hasCached;
  }

  /**
   * Configure iOS-side performance timing data
   */
  setPerformanceTiming(perfTiming: CtrlProxyPerfTiming | null): void {
    this.performanceTiming = perfTiming;
  }

  /**
   * Configure tap result
   */
  setTapResult(result: CtrlProxyTapResult | null): void {
    this.tapResult = result;
  }

  /**
   * Configure swipe result
   */
  setSwipeResult(result: CtrlProxySwipeResult | null): void {
    this.swipeResult = result;
  }

  setRecentAppsResult(result: CtrlProxyRecentAppsResult | null): void {
    this.recentAppsResult = result;
  }

  /**
   * Configure drag result
   */
  setDragResult(result: CtrlProxyDragResult | null): void {
    this.dragResult = result;
  }

  /**
   * Configure pinch result
   */
  setPinchResult(result: CtrlProxyPinchResult | null): void {
    this.pinchResult = result;
  }

  /**
   * Configure VoiceOver enabled state
   */
  setVoiceOverState(enabled: boolean): void {
    this.voiceOverState = enabled;
  }

  /**
   * Configure VoiceOver activate result (null = default success)
   */
  setVoiceOverActivateResult(result: CtrlProxyActionResult | null): void {
    this.voiceOverActivateResult = result;
  }

  /**
   * Configure the result of requestSetVoiceOverEnabled (null = default success)
   */
  setSetVoiceOverEnabledResult(result: CtrlProxyActionResult | null): void {
    this.setVoiceOverEnabledResult = result;
  }

  /**
   * Get requestSetVoiceOverEnabled call history (the requested enabled values)
   */
  getSetVoiceOverEnabledHistory(): boolean[] {
    return [...this.setVoiceOverEnabledHistory];
  }

  /**
   * Configure multi-finger swipe result (null = default success)
   */
  setMultiFingerSwipeResult(result: CtrlProxySwipeResult | null): void {
    this.multiFingerSwipeResult = result;
  }

  /**
   * Configure requestAction result (null = default success)
   */
  setActionResult(result: CtrlProxyActionResult | null): void {
    this.actionResult = result;
  }

  setClipboardResult(result: CtrlProxyClipboardResult | null): void {
    this.clipboardResult = result;
  }

  getClipboardHistory(): Array<{ action: "copy" | "paste" | "clear" | "get"; text?: string }> {
    return [...this.clipboardHistory];
  }

  // MARK: - Assertion Methods

  /**
   * Get the history of tap requests
   */
  getTapHistory(): Array<{ x: number; y: number; duration: number }> {
    return [...this.tapHistory];
  }

  /**
   * Get the history of swipe requests
   */
  getSwipeHistory(): Array<{
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    duration: number;
  }> {
    return [...this.swipeHistory];
  }

  /**
   * Get the number of press home requests
   */
  getPressHomeRequestCount(): number {
    return this.pressHomeRequestCount;
  }

  getKeyboardHistory(): Array<{ action: "open" | "close" | "detect" }> {
    return [...this.keyboardHistory];
  }

  getPressKeyHistory(): Array<{ key: InputKeyName; modifiers: InputKeyModifier[] }> {
    return [...this.pressKeyHistory];
  }

  getPressBackRequestCount(): number {
    return this.pressBackRequestCount;
  }

  getShakeRequestCount(): number {
    return this.shakeRequestCount;
  }

  getShakeTimeoutHistory(): number[] {
    return [...this.shakeTimeoutHistory];
  }

  getRecentAppsRequestCount(): number {
    return this.recentAppsRequestCount;
  }

  /**
   * Get the history of rotate requests
   */
  getRotateHistory(): Array<{ orientation: string }> {
    return [...this.rotateHistory];
  }

  /**
   * Get the history of launch app requests
   */
  getLaunchAppHistory(): string[] {
    return [...this.launchAppHistory];
  }

  /**
   * Get the history of drag requests
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
  }> {
    return [...this.dragHistory];
  }

  /**
   * Get the history of pinch requests
   */
  getPinchHistory(): Array<{
    centerX: number;
    centerY: number;
    distanceStart: number;
    distanceEnd: number;
    rotationDegrees: number;
    duration?: number;
    timeoutMs?: number;
  }> {
    return [...this.pinchHistory];
  }

  /**
   * Get the history of text input requests
   */
  getTextInputHistory(): Array<{ text: string; resourceId?: string }> {
    return [...this.setTextHistory];
  }

  /**
   * Get the history of IME action requests
   */
  getImeActionHistory(): Array<{
    action: "done" | "next" | "search" | "send" | "go" | "previous";
  }> {
    return [...this.imeActionHistory];
  }

  /**
   * Check if a specific IME action was called
   */
  wasImeActionCalled(action: "done" | "next" | "search" | "send" | "go" | "previous"): boolean {
    return this.imeActionHistory.some((entry) => entry.action === action);
  }

  /**
   * Get the number of screenshot requests made
   */
  getScreenshotRequestCount(): number {
    return this.screenshotRequestCount;
  }

  /**
   * Get the number of hierarchy requests made
   */
  getHierarchyRequestCount(): number {
    return this.hierarchyRequestCount;
  }

  /**
   * Get VoiceOver activate call history
   */
  getVoiceOverActivateHistory(): Array<{ label: string; action: "activate" | "long_press" }> {
    return [...this.voiceOverActivateHistory];
  }

  /**
   * Get requestAction call history
   */
  getActionHistory(): Array<{ action: string; resourceId?: string; label?: string }> {
    return [...this.actionHistory];
  }

  /**
   * Get multi-finger swipe call history
   */
  getMultiFingerSwipeHistory(): Array<{
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    fingerCount: number;
    duration: number;
    fingerSpacing?: number;
  }> {
    return [...this.multiFingerSwipeHistory];
  }

  /**
   * Clear all call history
   */
  clearHistory(): void {
    this.tapHistory = [];
    this.swipeHistory = [];
    this.dragHistory = [];
    this.pinchHistory = [];
    this.setTextHistory = [];
    this.imeActionHistory = [];
    this.screenshotRequestCount = 0;
    this.hierarchyRequestCount = 0;
    this.keyboardOpen = false;
    this.keyboardHistory = [];
    this.pressKeyHistory = [];
    this.pressHomeRequestCount = 0;
    this.pressBackRequestCount = 0;
    this.recentAppsRequestCount = 0;
    this.launchAppHistory = [];
    this.rotateHistory = [];
    this.currentOrientation = "portrait";
    this.voiceOverActivateHistory = [];
    this.setVoiceOverEnabledHistory = [];
    this.actionHistory = [];
    this.multiFingerSwipeHistory = [];
    this.clipboardHistory = [];
  }

  // MARK: - Private Helpers

  private async applyDelay(operation: string): Promise<void> {
    const delay = this.operationDelays.get(operation);
    if (delay && delay > 0) {
      await defaultTimer.sleep(delay);
    }
  }

  private checkFailure(operation: string): void {
    const error = this.failureMap.get(operation);
    if (error) {
      throw error;
    }
  }

  // MARK: - IOSCtrlProxy Implementation

  async getAccessibilityHierarchy(
    queryOptions?: ViewHierarchyQueryOptions,
    perf?: PerformanceTracker,
    skipWaitForFresh?: boolean,
    minTimestamp?: number,
    disableAllFiltering?: boolean,
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
  ): Promise<CtrlProxyHierarchyResponse> {
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
  ): Promise<{ hierarchy: CtrlProxyHierarchy; perfTiming?: CtrlProxyPerfTiming } | null> {
    this.hierarchyRequestCount++;
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

  convertToViewHierarchyResult(hierarchy: CtrlProxyHierarchy): ViewHierarchyResult {
    return {
      hierarchy: {
        node: {
          $: {
            text: "Fake Hierarchy",
          },
        },
      },
      packageName: hierarchy.packageName,
      updatedAt: hierarchy.updatedAt,
    };
  }

  async requestTapCoordinates(
    x: number,
    y: number,
    duration: number = 0,
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
  ): Promise<CtrlProxyTapResult> {
    await this.applyDelay("tap");
    this.checkFailure("tap");

    this.tapHistory.push({ x, y, duration });

    if (this.tapResult) {
      return {
        ...this.tapResult,
        perfTiming: this.tapResult.perfTiming ?? this.performanceTiming ?? undefined,
      };
    }

    return {
      success: true,
      totalTimeMs: 50,
      perfTiming: this.performanceTiming || undefined,
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
  ): Promise<CtrlProxySwipeResult> {
    await this.applyDelay("swipe");
    this.checkFailure("swipe");

    this.swipeHistory.push({ x1, y1, x2, y2, duration });

    if (this.swipeResult) {
      return {
        ...this.swipeResult,
        perfTiming: this.swipeResult.perfTiming ?? this.performanceTiming ?? undefined,
      };
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
  ): Promise<CtrlProxyDragResult> {
    await this.applyDelay("drag");
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
    });

    if (this.dragResult) {
      return {
        ...this.dragResult,
        perfTiming: this.dragResult.perfTiming ?? this.performanceTiming ?? undefined,
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
  ): Promise<CtrlProxyPinchResult> {
    await this.applyDelay("pinch");
    this.checkFailure("pinch");

    this.pinchHistory.push({
      centerX,
      centerY,
      distanceStart,
      distanceEnd,
      rotationDegrees,
      duration,
      timeoutMs,
    });

    if (this.pinchResult) {
      return {
        ...this.pinchResult,
        perfTiming: this.pinchResult.perfTiming ?? this.performanceTiming ?? undefined,
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

  async requestSetText(text: string, options?: SetTextOptions): Promise<CtrlProxySetTextResult> {
    await this.applyDelay("setText");
    this.checkFailure("setText");

    this.setTextHistory.push({ text, resourceId: options?.resourceId });

    return {
      success: true,
      totalTimeMs: 100,
      perfTiming: this.performanceTiming || undefined,
    };
  }

  async requestClearText(
    resourceId?: string,
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
  ): Promise<CtrlProxySetTextResult> {
    await this.applyDelay("clearText");
    this.checkFailure("clearText");

    this.setTextHistory.push({ text: "", resourceId });

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
  ): Promise<CtrlProxyImeActionResult> {
    await this.applyDelay("imeAction");

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
  ): Promise<CtrlProxySelectAllResult> {
    await this.applyDelay("selectAll");
    this.checkFailure("selectAll");

    return {
      success: true,
      totalTimeMs: 100,
      perfTiming: this.performanceTiming || undefined,
    };
  }

  async requestKeyboard(
    action: "open" | "close" | "detect",
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
  ): Promise<CtrlProxyKeyboardResult> {
    await this.applyDelay("keyboard");
    this.checkFailure("keyboard");

    this.keyboardHistory.push({ action });
    if (action === "open") {
      this.keyboardOpen = true;
    } else if (action === "close") {
      this.keyboardOpen = false;
    }

    return {
      success: true,
      open: this.keyboardOpen,
      totalTimeMs: 100,
      perfTiming: this.performanceTiming || undefined,
    };
  }

  async requestPressKey(
    key: InputKeyName,
    modifiers: InputKeyModifier[],
    timeoutMs: number = 5000,
    _perf?: PerformanceTracker,
  ): Promise<CtrlProxyPressKeyResult> {
    await this.applyDelay("pressKey");
    this.checkFailure("pressKey");
    this.pressKeyHistory.push({ key, modifiers });
    return {
      success: true,
      totalTimeMs: timeoutMs > 0 ? 1 : 0,
      perfTiming: this.performanceTiming || undefined,
    };
  }

  async requestPressHome(
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
  ): Promise<CtrlProxyPressHomeResult> {
    this.pressHomeRequestCount++;
    await this.applyDelay("pressHome");
    this.checkFailure("pressHome");

    return {
      success: true,
      totalTimeMs: 100,
      perfTiming: this.performanceTiming || undefined,
    };
  }

  async requestPressBack(
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
  ): Promise<CtrlProxyPressBackResult> {
    this.pressBackRequestCount++;
    await this.applyDelay("pressBack");
    this.checkFailure("pressBack");

    return {
      success: true,
      totalTimeMs: 100,
      perfTiming: this.performanceTiming || undefined,
    };
  }

  async requestShake(
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
  ): Promise<CtrlProxyShakeResult> {
    this.shakeRequestCount++;
    this.shakeTimeoutHistory.push(timeoutMs);
    await this.applyDelay("shake");
    this.checkFailure("shake");

    return {
      success: true,
      totalTimeMs: 100,
      perfTiming: this.performanceTiming || undefined,
    };
  }

  async requestPressButton(
    button: string,
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
  ): Promise<CtrlProxyPressButtonResult> {
    await this.applyDelay("pressButton");
    this.checkFailure("pressButton");

    return {
      success: true,
      totalTimeMs: 100,
      perfTiming: this.performanceTiming || undefined,
    };
  }

  async requestRecentApps(
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
  ): Promise<CtrlProxyRecentAppsResult> {
    this.recentAppsRequestCount++;
    await this.applyDelay("recentApps");
    this.checkFailure("recentApps");

    if (this.recentAppsResult) {
      return {
        ...this.recentAppsResult,
        perfTiming: this.recentAppsResult.perfTiming ?? this.performanceTiming ?? undefined,
      };
    }

    return {
      success: true,
      totalTimeMs: 100,
      perfTiming: this.performanceTiming || undefined,
    };
  }

  async requestRotate(
    orientation: string,
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
  ): Promise<CtrlProxyRotateResult> {
    this.rotateHistory.push({ orientation });
    await this.applyDelay("rotate");
    this.checkFailure("rotate");

    const previousOrientation = this.currentOrientation;
    const rotationPerformed = previousOrientation !== orientation;
    if (rotationPerformed) {
      this.currentOrientation = orientation;
    }

    return {
      success: true,
      totalTimeMs: 100,
      previousOrientation,
      currentOrientation: this.currentOrientation,
      value: orientation === "portrait" ? 0 : 1,
      rotationPerformed,
      perfTiming: this.performanceTiming || undefined,
    };
  }

  async requestLaunchApp(
    bundleId: string,
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
  ): Promise<CtrlProxyLaunchAppResult> {
    await this.applyDelay("launchApp");
    this.checkFailure("launchApp");
    this.launchAppHistory.push(bundleId);

    return {
      success: true,
      totalTimeMs: 100,
      perfTiming: this.performanceTiming || undefined,
    };
  }

  async requestScreenshot(
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
  ): Promise<CtrlProxyScreenshotResult> {
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

  async requestVoiceOverState(
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
  ): Promise<CtrlProxyVoiceOverResult> {
    await this.applyDelay("voiceOverState");
    this.checkFailure("voiceOverState");

    return {
      success: true,
      enabled: this.voiceOverState,
      totalTimeMs: 10,
    };
  }

  async requestVoiceOverActivate(
    label: string,
    action: "activate" | "long_press",
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
  ): Promise<CtrlProxyActionResult> {
    await this.applyDelay("voiceOverActivate");
    this.checkFailure("voiceOverActivate");

    this.voiceOverActivateHistory.push({ label, action });

    if (this.voiceOverActivateResult) {
      return this.voiceOverActivateResult;
    }

    return {
      success: true,
      action,
      totalTimeMs: 50,
    };
  }

  async requestSetVoiceOverEnabled(
    enabled: boolean,
    timeoutMs: number = 30000,
    perf?: PerformanceTracker,
  ): Promise<CtrlProxyActionResult> {
    await this.applyDelay("setVoiceOverEnabled");
    this.checkFailure("setVoiceOverEnabled");

    this.setVoiceOverEnabledHistory.push(enabled);

    if (this.setVoiceOverEnabledResult) {
      return this.setVoiceOverEnabledResult;
    }

    return {
      success: true,
      totalTimeMs: 50,
    };
  }

  async requestMultiFingerSwipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    fingerCount: number,
    duration: number = 300,
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
    fingerSpacing?: number,
  ): Promise<CtrlProxySwipeResult> {
    await this.applyDelay("multiFingerSwipe");
    this.checkFailure("multiFingerSwipe");

    this.multiFingerSwipeHistory.push({ x1, y1, x2, y2, fingerCount, duration, fingerSpacing });

    if (this.multiFingerSwipeResult) {
      return this.multiFingerSwipeResult;
    }

    return {
      success: true,
      totalTimeMs: duration,
      gestureTimeMs: duration,
      perfTiming: this.performanceTiming || undefined,
    };
  }

  async requestAction(
    action: string,
    resourceId?: string,
    label?: string,
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
  ): Promise<CtrlProxyActionResult> {
    await this.applyDelay("action");
    this.checkFailure("action");

    this.actionHistory.push({ action, resourceId, label });

    if (this.actionResult) {
      return this.actionResult;
    }

    return {
      success: true,
      action,
      totalTimeMs: 50,
    };
  }

  async requestActivateAccessibilityLink(
    text: string,
    occurrence: number,
    ownerResourceId?: string,
  ): Promise<CtrlProxyActionResult> {
    await this.applyDelay("accessibilityLink");
    this.checkFailure("accessibilityLink");
    this.actionHistory.push({
      action: "activate_accessibility_link",
      resourceId: ownerResourceId,
      label: `${text}#${occurrence}`,
    });
    return (
      this.actionResult ?? {
        success: true,
        action: "activate_accessibility_link",
        totalTimeMs: 50,
      }
    );
  }

  async requestClipboard(
    action: "copy" | "paste" | "clear" | "get",
    text?: string,
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
  ): Promise<CtrlProxyClipboardResult> {
    await this.applyDelay("clipboard");
    this.checkFailure("clipboard");

    this.clipboardHistory.push({ action, text });

    if (this.clipboardResult) {
      return this.clipboardResult;
    }

    return {
      success: true,
      action,
      text: action === "get" ? "fake clipboard text" : undefined,
      totalTimeMs: 50,
    };
  }

  isConnected(): boolean {
    return this.isConnectedState;
  }

  async ensureConnected(): Promise<boolean> {
    this.isConnectedState = true;
    return this.isConnectedState;
  }

  async waitForConnection(maxAttempts?: number, delayMs?: number): Promise<boolean> {
    return this.isConnectedState;
  }

  async verifyServiceReady(
    maxAttempts?: number,
    delayMs?: number,
    timeoutMs?: number,
  ): Promise<boolean> {
    return this.isConnectedState;
  }

  hasCachedHierarchy(): boolean {
    return this.hasCachedHierarchyState;
  }

  invalidateCache(): void {
    this.hasCachedHierarchyState = false;
  }

  clearCache(): void {
    this.hasCachedHierarchyState = false;
    this.clearCacheCallCount++;
  }

  async close(): Promise<void> {
    this.isConnectedState = false;
  }

  onPushUpdate(callback: (hierarchy: CtrlProxyHierarchy) => void): () => void {
    // No-op in fake - return unsubscribe function
    return () => {};
  }
}

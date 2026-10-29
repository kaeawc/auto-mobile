import { SdkCapabilityProbeSupersededError } from "./SdkCapabilityProbeSupersededError";
import { errorMessage } from "../../../utils/describeUnknownError";
import { readScreenScaleMetadata } from "../../../models/ScreenScaleMetadata";
import type { ScreenScaleMetadata } from "../../../models";
import { CtrlProxyInboundMessages } from "./CtrlProxyInboundMessages";

import { CtrlProxySdkCapabilities, sdkCapabilityQueryOptions } from "./CtrlProxySdkCapabilities";

import type { PinchRequest, TapCoordinatesRequest } from "../shared/SharedGestureDelegate";
import type { IosActivateAccessibilityLinkRequest } from "./CtrlProxyVoiceOver";

import { iosWireDeadlineParams, type IOSDispatchResult } from "./CtrlProxyDispatch";

import type { CtrlProxySdkTriggerResult } from "./types";
import { requestSdkTrigger, type SdkTriggerRequest } from "./CtrlProxySdkTrigger";
import {
  requestAccessibilityAudit,
  type CtrlProxyAccessibilityAuditResult,
  type IosAccessibilityAuditRequest,
} from "./CtrlProxyAccessibilityAudit";

import type { IosHierarchyUnavailableReason } from "../../../models/ViewHierarchyResult";
import { logger } from "../../../utils/logger";

import { SimCtlClient } from "../../../utils/ios-cmdline-tools/SimCtlClient";
import { captureIosPanelScreenshot } from "./CtrlProxyScreenshot";
import { displayTransitions } from "../DisplayTransition";

import { HighlightShape, ViewHierarchyResult } from "../../../models";

import { PerformanceTracker, NoOpPerformanceTracker } from "../../../utils/PerformanceTracker";

import { ObserverPendingRequestTimeoutError } from "../ObserverPendingRequestTimeoutError";

import { TrackedScreenGeometry } from "../TrackedScreenGeometry";

import { serializeIosRequest } from "./serializeIosRequest";
import { iosMutationTokens } from "../../storage/IosMutationTokens";
import { CtrlProxyGestures } from "./CtrlProxyGestures";
import { CtrlProxyText } from "./CtrlProxyText";
import { CtrlProxyHierarchy as CtrlProxyHierarchyDelegate } from "./CtrlProxyHierarchy";
import { CtrlProxyScreenshot } from "./CtrlProxyScreenshot";
import { CtrlProxyNavigation } from "./CtrlProxyNavigation";
import { CtrlProxyClipboard } from "./CtrlProxyClipboard";
import { CtrlProxyStorage } from "./CtrlProxyStorage";
import { CtrlProxyVoiceOver } from "./CtrlProxyVoiceOver";
import { CtrlProxyKeyboard } from "./CtrlProxyKeyboard";

import { CtrlProxyHighlights } from "./CtrlProxyHighlights";
import { CtrlProxyDatabase } from "./CtrlProxyDatabase";
import { CtrlProxyPermissions } from "./CtrlProxyPermissions";

import type {
  DelegateContext,
  HierarchyDelegateContext,
  XCTestHierarchy,
  CtrlProxyHierarchyResponse,
  CtrlProxySyncedHierarchy,
  CtrlProxyScreenshotResult,
  CtrlProxySwipeResult,
  CtrlProxyTapResult,
  CtrlProxyPinchResult,
  CtrlProxyPressHomeResult,
  CtrlProxyPressButtonResult,
  CtrlProxyRecentAppsResult,
  CtrlProxyLaunchAppResult,
  CtrlProxyCachedHierarchy,
  CtrlProxyActionResult,
  CtrlProxyHighlightResult,
} from "./types";

import { IosCtrlProxyDiagnosticsFacade } from "./IosCtrlProxyDiagnosticsFacade";
import type { IOSCtrlProxyClient, IosCtrlProxy } from "./IOSCtrlProxyClient";
/** Public forwarding API and lazy delegates, retaining the delegates' defaults and dispatch paths. */
export abstract class IosCtrlProxyDelegatingFacade extends IosCtrlProxyDiagnosticsFacade {
  protected abstract readonly cacheFreshTtlMs: number;
  protected abstract get inbound(): CtrlProxyInboundMessages;
  protected abstract readonly sdkCapability: CtrlProxySdkCapabilities;
  protected abstract readonly supportedFeatures: Set<string> | null;
  protected abstract readonly lastConnectFailure?:
    | { reason: IosHierarchyUnavailableReason; detail?: string }
    | undefined;
  protected abstract suppressHierarchyObservationStreamPush(
    requestId: string,
    timeoutMs: number,
  ): void;
  protected abstract isCommandSupported(messageType: string): boolean;
  protected abstract buildUnsupportedCommandError(messageType: string): string;

  protected readonly streamedCaptureSequences = new WeakMap<XCTestHierarchy, number>();

  /**
   * NOT using TTLCache: "fresh" state managed by push updates + minTimestamp
   * validation, not simple TTL expiration. The cache is invalidated based on
   * WebSocket push events and explicit invalidateCache() calls after actions.
   */
  protected cachedHierarchy: CtrlProxyCachedHierarchy | null = null;

  protected cachedHierarchyDisplayRevision = -1;

  protected readonly observerHierarchyRequestIds = new Set<string>();

  // Delegate instances (lazy initialized)
  private _gestures: CtrlProxyGestures | null = null;

  private _text: CtrlProxyText | null = null;

  protected _hierarchy: CtrlProxyHierarchyDelegate | null = null;

  private _screenshot: CtrlProxyScreenshot | null = null;

  private _navigation: CtrlProxyNavigation | null = null;

  private _clipboard: CtrlProxyClipboard | null = null;

  private _voiceOver: CtrlProxyVoiceOver | null = null;

  private _storage: CtrlProxyStorage | null = null;

  private _keyboard: CtrlProxyKeyboard | null = null;

  private _highlights: CtrlProxyHighlights | null = null;

  private _database: CtrlProxyDatabase | null = null;

  private _permissions: CtrlProxyPermissions | null = null;

  // Screen geometry derived from hierarchies, carrying whether the daemon has actually seen a
  // hierarchy with that geometry (issue #3348). See TrackedScreenGeometry.
  protected readonly screenGeometry = new TrackedScreenGeometry();

  // ===========================================================================
  // Delegate Context Factories
  // ===========================================================================

  protected override extraDelegateContextFields(): Partial<DelegateContext> {
    return {
      serializeRequest: serializeIosRequest,
      wireDeadlineParams: iosWireDeadlineParams,
      getReconnectStatus: () => this.getReconnectStatus(),
      isCommandSupported: (messageType) => this.isCommandSupported(messageType),
      getSupportedCommands: () => this.getSupportedCommands(),
      unsupportedCommandError: (messageType) => this.buildUnsupportedCommandError(messageType),
    };
  }

  protected createHierarchyDelegateContext(): HierarchyDelegateContext {
    return {
      ...this.createDelegateContext(),
      getLastConnectFailure: () => this.lastConnectFailure,
      getDeviceId: () => this.device.deviceId,
      cacheFreshTtlMs: this.cacheFreshTtlMs,
      getCachedHierarchy: () => this.cachedHierarchy,
      setCachedHierarchy: (h) => {
        const sameCapture =
          h !== null &&
          this.cachedHierarchy !== null &&
          h.hierarchy.updatedAt === this.cachedHierarchy.hierarchy.updatedAt;
        const previousRevision = this.cachedHierarchyDisplayRevision;
        this.cachedHierarchy = h;
        if (h === null || h.fresh) {
          this.inbound.resetOlderHierarchyPushRun();
        }
        this.cachedHierarchyDisplayRevision = sameCapture
          ? previousRevision
          : displayTransitions.revision(this.device.deviceId);
      },
      suppressHierarchyObservationStreamPush: (requestId, timeoutMs) =>
        this.suppressHierarchyObservationStreamPush(requestId, timeoutMs),
      markObserverHierarchyRequest: (requestId) => {
        this.observerHierarchyRequestIds.add(requestId);
      },
      unmarkObserverHierarchyRequest: (requestId) => {
        this.observerHierarchyRequestIds.delete(requestId);
      },
    };
  }

  // ===========================================================================
  // Delegate Getters (lazy initialization)
  // ===========================================================================

  protected get gestures(): CtrlProxyGestures {
    return (this._gestures ??= new CtrlProxyGestures(
      this.createDelegateContext(),
      undefined,
      async (signal) => {
        if (this.supportedFeatures === null) {
          await this.waitForHandshake(undefined, signal);
        }
        // Legacy handshakes omit features; never assume they understand doubleTap.
        return this.getCachedSupportedFeatures() ?? [];
      },
    ));
  }

  protected get text(): CtrlProxyText {
    return (this._text ??= new CtrlProxyText(this.createDelegateContext()));
  }

  protected get hierarchy(): CtrlProxyHierarchyDelegate {
    return (this._hierarchy ??= new CtrlProxyHierarchyDelegate(
      this.createHierarchyDelegateContext(),
    ));
  }

  protected get screenshot(): CtrlProxyScreenshot {
    return (this._screenshot ??= new CtrlProxyScreenshot(this.createDelegateContext()));
  }

  protected get navigation(): CtrlProxyNavigation {
    return (this._navigation ??= new CtrlProxyNavigation(this.createDelegateContext()));
  }

  protected get clipboard(): CtrlProxyClipboard {
    return (this._clipboard ??= new CtrlProxyClipboard(this.createDelegateContext()));
  }

  protected get voiceOver(): CtrlProxyVoiceOver {
    return (this._voiceOver ??= new CtrlProxyVoiceOver(this.createDelegateContext()));
  }

  protected get storage(): CtrlProxyStorage {
    return (this._storage ??= new CtrlProxyStorage(
      this.createDelegateContext(),
      () => this.boundSessionId,
      (appId) => iosMutationTokens.get(this.device.deviceId, appId),
    ));
  }

  protected get keyboard(): CtrlProxyKeyboard {
    return (this._keyboard ??= new CtrlProxyKeyboard(this.createDelegateContext()));
  }

  protected get highlights(): CtrlProxyHighlights {
    return (this._highlights ??= new CtrlProxyHighlights(this.createDelegateContext()));
  }

  protected get database(): CtrlProxyDatabase {
    return (this._database ??= new CtrlProxyDatabase(this.createDelegateContext()));
  }

  protected get permissions(): CtrlProxyPermissions {
    return (this._permissions ??= new CtrlProxyPermissions(this.createDelegateContext()));
  }

  // ===========================================================================
  // Delegated Public Methods - Hierarchy
  // ===========================================================================

  async getAccessibilityHierarchy(
    ...args: Parameters<CtrlProxyHierarchyDelegate["getAccessibilityHierarchy"]>
  ): Promise<ViewHierarchyResult | null> {
    return this.hierarchy.getAccessibilityHierarchy(...args);
  }

  // Thin pass-throughs: like the delegated methods below, these do NOT restate the
  // delegate's default parameter values. Omitted args forward as `undefined`, so
  // CtrlProxyHierarchy (the single source of truth) applies its own defaults —
  // keeping the two-copies drift class from issue #3505 unrepresentable.
  async getLatestHierarchy(
    ...args: Parameters<CtrlProxyHierarchyDelegate["getLatestHierarchy"]>
  ): Promise<CtrlProxyHierarchyResponse> {
    return this.hierarchy.getLatestHierarchy(...args);
  }

  async requestHierarchySync(
    perf?: PerformanceTracker,
    disableAllFiltering?: boolean,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<CtrlProxySyncedHierarchy | null> {
    return this.hierarchy.requestHierarchySync(perf, disableAllFiltering, signal, timeoutMs);
  }

  async requestHierarchySyncForTapRevalidation(
    perf?: PerformanceTracker,
    disableAllFiltering?: boolean,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): ReturnType<IosCtrlProxy["requestHierarchySync"]> {
    return this.hierarchy.requestHierarchySync(
      perf,
      disableAllFiltering,
      signal,
      timeoutMs,
      false,
      {
        forceCapture: true,
      },
    );
  }

  async requestHierarchySyncWithoutObservationStreamPush(
    perf?: PerformanceTracker,
    disableAllFiltering?: boolean,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<CtrlProxySyncedHierarchy | null> {
    return this.hierarchy.requestHierarchySync(perf, disableAllFiltering, signal, timeoutMs, true);
  }

  async requestHierarchySyncForObserver(
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    disableAllFiltering = false,
    signal?: AbortSignal,
    timeoutMs = 10000,
  ): Promise<CtrlProxySyncedHierarchy | null> {
    const deadline = this.timer.now() + timeoutMs;
    await this.waitForPendingRequests(timeoutMs, signal);
    const remaining = deadline - this.timer.now();
    if (remaining <= 0) {
      throw new ObserverPendingRequestTimeoutError();
    }
    return this.hierarchy.requestHierarchySync(perf, disableAllFiltering, signal, remaining, true, {
      forceCapture: true,
      observerMode: true,
    });
  }

  convertToViewHierarchyResult(hierarchy: XCTestHierarchy): ViewHierarchyResult {
    this.hierarchy.observeReceivedHierarchy(hierarchy);
    const result = this.hierarchy.convertToViewHierarchyResult(hierarchy);
    const captureSequence = this.streamedCaptureSequences.get(hierarchy);
    if (captureSequence !== undefined) {
      result.captureSequence = captureSequence;
    }
    return result;
  }

  hasCachedHierarchy(
    ...args: Parameters<CtrlProxyHierarchyDelegate["hasCachedHierarchy"]>
  ): ReturnType<CtrlProxyHierarchyDelegate["hasCachedHierarchy"]> {
    return this.hierarchy.hasCachedHierarchy(...args);
  }

  invalidateCache(
    ...args: Parameters<CtrlProxyHierarchyDelegate["invalidateCache"]>
  ): ReturnType<CtrlProxyHierarchyDelegate["invalidateCache"]> {
    return this.hierarchy.invalidateCache(...args);
  }

  clearCache(): void {
    this._hierarchy?.resetState();
    this.cachedHierarchy = null;
    this.inbound.resetOlderHierarchyPushRun();
  }

  /** Discard hierarchy and screenshot provenance when the physical panel changes. */
  clearDisplayProvenance(): void {
    this.clearCache();
    this.screenGeometry.clear();
  }

  // ===========================================================================
  // Delegated Public Methods - Highlights
  // ===========================================================================

  // Thin pass-throughs below deliberately DO NOT restate the delegate's default
  // parameter values: omitted args forward as `undefined` so the delegate (the
  // single source of truth) applies its own defaults, making the two-copies drift
  // class from issue #3505 unrepresentable.
  async requestAddHighlight(
    id: string,
    shape: HighlightShape,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<CtrlProxyHighlightResult> {
    const options = sdkCapabilityQueryOptions(this.timer, timeoutMs ?? 5000);
    const gate = await this.sdkCapability.sdkCapabilityGate("highlight", options);
    if (gate !== null) {
      return gate;
    }
    return this.highlights.requestAddHighlight(id, shape, timeoutMs, perf, options);
  }

  // ===========================================================================
  // Delegated Public Methods - Gestures
  // ===========================================================================

  async requestTapCoordinates(
    request: TapCoordinatesRequest,
  ): Promise<IOSDispatchResult<CtrlProxyTapResult>> {
    const { x, y, duration, timeoutMs, perf, frameContext, signal, onDispatch } = request;

    return this.gestures.requestTapCoordinates({
      x,
      y,
      duration,
      timeoutMs,
      perf,
      frameContext,
      signal,
      onDispatch,
    });
  }

  async requestDoubleTapCoordinates(
    ...args: Parameters<CtrlProxyGestures["requestDoubleTapCoordinates"]>
  ): ReturnType<CtrlProxyGestures["requestDoubleTapCoordinates"]> {
    return this.gestures.requestDoubleTapCoordinates(...args);
  }

  async requestSwipe(
    ...args: Parameters<CtrlProxyGestures["requestSwipe"]>
  ): ReturnType<CtrlProxyGestures["requestSwipe"]> {
    return this.gestures.requestSwipe(...args);
  }

  async requestDrag(
    ...args: Parameters<CtrlProxyGestures["requestDrag"]>
  ): ReturnType<CtrlProxyGestures["requestDrag"]> {
    return this.gestures.requestDrag(...args);
  }

  async requestPathGesture(
    ...args: Parameters<CtrlProxyGestures["requestPathGesture"]>
  ): ReturnType<CtrlProxyGestures["requestPathGesture"]> {
    return this.gestures.requestPathGesture(...args);
  }

  async requestPinch(
    request: PinchRequest,
    onDispatch?: () => void,
  ): Promise<IOSDispatchResult<CtrlProxyPinchResult>> {
    const {
      centerX,
      centerY,
      distanceStart,
      distanceEnd,
      rotationDegrees,
      duration,
      timeoutMs,
      perf,
      signal,
    } = request;
    return this.gestures.requestPinchWithDispatch(
      {
        centerX,
        centerY,
        distanceStart,
        distanceEnd,
        rotationDegrees,
        duration,
        timeoutMs,
        perf,
        signal,
      },
      onDispatch,
    );
  }

  // ===========================================================================
  // Delegated Public Methods - Text
  // ===========================================================================

  async requestSetText(
    ...args: Parameters<CtrlProxyText["requestSetText"]>
  ): ReturnType<CtrlProxyText["requestSetText"]> {
    return this.text.requestSetText(...args);
  }

  async requestAppendText(
    ...args: Parameters<CtrlProxyText["requestAppendText"]>
  ): ReturnType<CtrlProxyText["requestAppendText"]> {
    return this.text.requestAppendText(...args);
  }

  async requestClearText(
    ...args: Parameters<CtrlProxyText["requestClearText"]>
  ): ReturnType<CtrlProxyText["requestClearText"]> {
    return this.text.requestClearText(...args);
  }

  async requestImeAction(
    ...args: Parameters<CtrlProxyText["requestImeAction"]>
  ): ReturnType<CtrlProxyText["requestImeAction"]> {
    return this.text.requestImeAction(...args);
  }

  async requestSelectAll(
    ...args: Parameters<CtrlProxyText["requestSelectAll"]>
  ): ReturnType<CtrlProxyText["requestSelectAll"]> {
    return this.text.requestSelectAll(...args);
  }

  async requestKeyboard(
    ...args: Parameters<CtrlProxyKeyboard["requestKeyboard"]>
  ): ReturnType<CtrlProxyKeyboard["requestKeyboard"]> {
    return this.keyboard.requestKeyboard(...args);
  }

  async requestPressKey(
    ...args: Parameters<CtrlProxyKeyboard["requestPressKey"]>
  ): ReturnType<CtrlProxyKeyboard["requestPressKey"]> {
    return this.keyboard.requestPressKey(...args);
  }

  // ===========================================================================
  // Delegated Public Methods - Navigation
  // ===========================================================================

  async requestPressHome(
    timeoutMs?: number,
    perf?: PerformanceTracker,
    frameContext?: string,
    signal?: AbortSignal,
    onDispatch?: () => void,
  ): Promise<IOSDispatchResult<CtrlProxyPressHomeResult>> {
    this.sdkCapability.invalidateSdkCapabilities();
    return this.navigation.requestPressHome(timeoutMs, perf, frameContext, signal, onDispatch);
  }

  async requestPressBack(
    ...args: Parameters<CtrlProxyNavigation["requestPressBack"]>
  ): ReturnType<CtrlProxyNavigation["requestPressBack"]> {
    return this.navigation.requestPressBack(...args);
  }

  async requestShake(
    ...args: Parameters<CtrlProxyNavigation["requestShake"]>
  ): ReturnType<CtrlProxyNavigation["requestShake"]> {
    return this.navigation.requestShake(...args);
  }

  async requestPressButton(
    button: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    frameContext?: string,
    signal?: AbortSignal,
    onDispatch?: () => void,
  ): Promise<IOSDispatchResult<CtrlProxyPressButtonResult>> {
    if (button.toLowerCase() === "home" || button.toLowerCase() === "recent") {
      this.sdkCapability.invalidateSdkCapabilities();
    }
    return this.navigation.requestPressButton(
      button,
      timeoutMs,
      perf,
      frameContext,
      signal,
      onDispatch,
    );
  }

  async requestRecentApps(
    timeoutMs?: number,
    perf?: PerformanceTracker,
    frameContext?: string,
    signal?: AbortSignal,
    onDispatch?: () => void,
  ): Promise<IOSDispatchResult<CtrlProxyRecentAppsResult>> {
    this.sdkCapability.invalidateSdkCapabilities();
    return this.navigation.requestRecentApps(timeoutMs, perf, frameContext, signal, onDispatch);
  }

  async requestRotate(
    ...args: Parameters<CtrlProxyNavigation["requestRotate"]>
  ): ReturnType<CtrlProxyNavigation["requestRotate"]> {
    return this.navigation.requestRotate(...args);
  }

  async requestSetHingeAngle(
    ...args: Parameters<CtrlProxyNavigation["requestSetHingeAngle"]>
  ): ReturnType<CtrlProxyNavigation["requestSetHingeAngle"]> {
    return this.navigation.requestSetHingeAngle(...args);
  }

  async requestLocation(
    ...args: Parameters<CtrlProxyNavigation["requestLocation"]>
  ): ReturnType<CtrlProxyNavigation["requestLocation"]> {
    return this.navigation.requestLocation(...args);
  }

  async requestSiri(
    ...args: Parameters<CtrlProxyNavigation["requestSiri"]>
  ): ReturnType<CtrlProxyNavigation["requestSiri"]> {
    return this.navigation.requestSiri(...args);
  }

  async requestAppearance(
    ...args: Parameters<CtrlProxyNavigation["requestAppearance"]>
  ): ReturnType<CtrlProxyNavigation["requestAppearance"]> {
    return this.navigation.requestAppearance(...args);
  }

  async requestLaunchApp(
    bundleId: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    coldBoot?: boolean,
    signal?: AbortSignal,
  ): Promise<CtrlProxyLaunchAppResult> {
    const launchBudget = sdkCapabilityQueryOptions(this.timer, timeoutMs, signal);
    this.sdkCapability.invalidateSdkCapabilities();
    const result = await this.navigation.requestLaunchApp(
      bundleId,
      timeoutMs,
      perf,
      coldBoot,
      signal,
    );
    if (result.success) {
      await this.sdkCapability
        .refreshSdkCapabilitiesAndSync({
          ...launchBudget,
          deadlineMs: Math.min(launchBudget.deadlineMs ?? Infinity, this.timer.now() + 1000),
        })
        .catch((error) => {
          if (error instanceof SdkCapabilityProbeSupersededError) {
            // The newer foreground generation refreshes its own capabilities.
            logger.debug(
              `[IOSCtrlProxyClient] SDK capability refresh superseded: ${error.message}`,
            );
            return;
          }
          logger.warn(
            `[IOSCtrlProxyClient] SDK capability refresh after launch failed: ${errorMessage(error)}`,
            error,
          );
        });
    }
    return result;
  }

  // ===========================================================================
  // Delegated Public Methods - App Privacy Permissions
  // ===========================================================================

  async requestResetPermissions(
    ...args: Parameters<CtrlProxyPermissions["requestResetPermissions"]>
  ): ReturnType<CtrlProxyPermissions["requestResetPermissions"]> {
    return this.permissions.requestResetPermissions(...args);
  }

  // ===========================================================================
  // Delegated Public Methods - Clipboard
  // ===========================================================================

  async requestClipboard(
    ...args: Parameters<CtrlProxyClipboard["requestClipboard"]>
  ): ReturnType<CtrlProxyClipboard["requestClipboard"]> {
    return this.clipboard.requestClipboard(...args);
  }

  // ===========================================================================
  // Delegated Public Methods - Screenshot
  // ===========================================================================

  async requestScreenshot(
    timeoutMs?: number,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<CtrlProxyScreenshotResult> {
    if ((this.device.displays?.panels.length ?? 0) < 2) {
      return this.screenshot.requestScreenshot(timeoutMs, perf, signal);
    }
    const currentPanel = displayTransitions.currentObservedPanel(this.device.deviceId);
    const hierarchy =
      !currentPanel &&
      this.cachedHierarchy?.fresh &&
      this.cachedHierarchyDisplayRevision === displayTransitions.revision(this.device.deviceId)
        ? this.cachedHierarchy.hierarchy
        : null;
    return captureIosPanelScreenshot(
      this.device,
      hierarchy,
      new SimCtlClient(this.device),
      () => this.screenshot.requestScreenshot(timeoutMs, perf, signal),
      signal,
      currentPanel?.key,
    );
  }

  async requestScreenshotForObserver(
    timeoutMs = 10000,
    signal?: AbortSignal,
  ): Promise<CtrlProxyScreenshotResult> {
    const deadline = this.timer.now() + timeoutMs;
    await this.waitForPendingRequests(timeoutMs, signal);
    const remaining = deadline - this.timer.now();
    if (remaining <= 0) {
      throw new ObserverPendingRequestTimeoutError();
    }
    return this.screenshot.requestScreenshot(remaining, undefined, signal, true);
  }

  async requestScreenshotWithoutObservationStreamPush(
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<CtrlProxyScreenshotResult> {
    return this.requestScreenshot(timeoutMs, perf);
  }

  // ===========================================================================
  // Delegated Public Methods - VoiceOver
  // ===========================================================================

  async requestVoiceOverState(
    ...args: Parameters<CtrlProxyVoiceOver["requestVoiceOverState"]>
  ): ReturnType<CtrlProxyVoiceOver["requestVoiceOverState"]> {
    return this.voiceOver.requestVoiceOverState(...args);
  }

  async requestVoiceOverActivate(
    ...args: Parameters<CtrlProxyVoiceOver["requestVoiceOverActivate"]>
  ): ReturnType<CtrlProxyVoiceOver["requestVoiceOverActivate"]> {
    return this.voiceOver.requestVoiceOverActivate(...args);
  }

  async requestSetVoiceOverEnabled(
    ...args: Parameters<CtrlProxyVoiceOver["requestSetVoiceOverEnabled"]>
  ): ReturnType<CtrlProxyVoiceOver["requestSetVoiceOverEnabled"]> {
    return this.voiceOver.requestSetVoiceOverEnabled(...args);
  }

  async requestAction(
    ...args: Parameters<CtrlProxyVoiceOver["requestAction"]>
  ): ReturnType<CtrlProxyVoiceOver["requestAction"]> {
    return this.voiceOver.requestAction(...args);
  }

  /** Deliver a host trigger to a module in the foreground app's in-app SDK (#1580). */
  async requestSdkTrigger(request: SdkTriggerRequest): Promise<CtrlProxySdkTriggerResult> {
    return requestSdkTrigger(this.createDelegateContext(), request);
  }

  /** Run XCUITest's own accessibility audit on the foreground app (#14086). */
  async requestAccessibilityAudit(
    request: IosAccessibilityAuditRequest,
  ): Promise<CtrlProxyAccessibilityAuditResult> {
    return requestAccessibilityAudit(this.createDelegateContext(), request);
  }

  /** Invoke Magic Tap directly through the foreground app's in-app SDK. */
  async requestMagicTap(
    ...args: Parameters<CtrlProxyVoiceOver["requestMagicTap"]>
  ): ReturnType<CtrlProxyVoiceOver["requestMagicTap"]> {
    return this.voiceOver.requestMagicTap(...args);
  }

  /**
   * On iOS, occurrence is the zero-based index among case-insensitive text matches
   * within the owning text element. Without ownerResourceId, use the first owner
   * carrying a matching link in document order (previously counted tree-wide).
   * Multiple candidate owners produce a runner warning; scope with container/subtext
   * for a specific owner. The XCUITest fallback refuses owner-less occurrence > 0.
   * Android remains unchanged: count matching links in document order within the
   * owner's subtree, or the whole active-window tree when owner-less.
   */

  async requestActivateAccessibilityLink(
    request: IosActivateAccessibilityLinkRequest,
  ): Promise<CtrlProxyActionResult> {
    const { text, occurrence, ownerResourceId, timeoutMs, perf, signal, onDispatch } = request;

    return this.voiceOver.requestActivateAccessibilityLink({
      text,
      occurrence,
      ownerResourceId,
      timeoutMs,
      perf,
      signal,
      onDispatch,
    });
  }

  async requestMultiFingerSwipe(
    ...args: Parameters<CtrlProxyGestures["requestMultiFingerSwipe"]>
  ): Promise<IOSDispatchResult<CtrlProxySwipeResult>> {
    return this.gestures.requestMultiFingerSwipe(...args);
  }

  // ===========================================================================
  // Delegated Public Methods - Storage (UserDefaults)
  // ===========================================================================

  async listPreferenceFiles(
    ...args: Parameters<CtrlProxyStorage["listPreferenceFiles"]>
  ): ReturnType<CtrlProxyStorage["listPreferenceFiles"]> {
    return this.storage.listPreferenceFiles(...args);
  }

  async getPreferenceEntries(
    ...args: Parameters<CtrlProxyStorage["getPreferenceEntries"]>
  ): ReturnType<CtrlProxyStorage["getPreferenceEntries"]> {
    return this.storage.getPreferenceEntries(...args);
  }

  /** Existing-socket UserDefaults access: never reconnect or provision a runner. */
  public getConnectedPreferenceClient(): Pick<
    IOSCtrlProxyClient,
    "getPreference" | "setPreference" | "isConnected"
  > {
    const storage = new CtrlProxyStorage(
      {
        ...this.createDelegateContext(),
        // The storage delegate's connection probe must only inspect the socket.
        ensureConnected: async () => this.isConnected(),
        getWebSocket: () => (this.isConnected() ? this.ws : null),
      },
      () => this.boundSessionId,
      (appId) => iosMutationTokens.get(this.device.deviceId, appId),
    );
    return {
      isConnected: () => this.isConnected(),
      getPreference: (...args) => storage.getPreference(...args),
      setPreference: (...args) => storage.setPreference(...args),
    };
  }

  async getPreference(
    ...args: Parameters<CtrlProxyStorage["getPreference"]>
  ): ReturnType<CtrlProxyStorage["getPreference"]> {
    return this.storage.getPreference(...args);
  }

  async setPreference(
    ...args: Parameters<CtrlProxyStorage["setPreference"]>
  ): ReturnType<CtrlProxyStorage["setPreference"]> {
    return this.storage.setPreference(...args);
  }

  async removePreference(
    ...args: Parameters<CtrlProxyStorage["removePreference"]>
  ): ReturnType<CtrlProxyStorage["removePreference"]> {
    return this.storage.removePreference(...args);
  }

  async deleteKeychainItemForIos(
    ...args: Parameters<CtrlProxyStorage["deleteKeychainItemForIos"]>
  ): ReturnType<CtrlProxyStorage["deleteKeychainItemForIos"]> {
    return this.storage.deleteKeychainItemForIos(...args);
  }

  async clearPreferenceStore(
    ...args: Parameters<CtrlProxyStorage["clearPreferenceStore"]>
  ): ReturnType<CtrlProxyStorage["clearPreferenceStore"]> {
    return this.storage.clearPreferenceStore(...args);
  }

  // ===========================================================================
  // Delegated Public Methods - Database (SQLite)
  // ===========================================================================

  async executeSQLForIos(
    appId: string,
    databasePath: string,
    query: string,
    timeoutMs?: number,
    readOnly?: boolean,
  ): Promise<import("../../database/DatabaseInspector").SQLResult> {
    const options = sdkCapabilityQueryOptions(this.timer, timeoutMs ?? 5000);
    await this.sdkCapability.requireSdkCapability("database", appId, options);
    return this.database.executeSQL(appId, databasePath, query, options, {
      sessionId: this.boundSessionId ?? undefined,
      mutationToken: iosMutationTokens.get(this.device.deviceId, appId),
      readOnly,
    });
  }

  async listDatabasesForIos(
    appId: string,
    timeoutMs?: number,
  ): Promise<import("../../database/DatabaseInspector").DatabaseInfo[]> {
    const options = sdkCapabilityQueryOptions(this.timer, timeoutMs ?? 5000);
    await this.sdkCapability.requireSdkCapability("database", appId, options);
    return this.database.listDatabases(appId, options);
  }

  async getStorageCapabilitiesForIos(
    appId: string,
    timeoutMs?: number,
  ): Promise<import("./CtrlProxyDatabase").StorageCapabilities> {
    const options = sdkCapabilityQueryOptions(this.timer, timeoutMs ?? 5000);
    await this.sdkCapability.requireSdkCapability("database", appId, options);
    return this.database.storageCapabilities(appId, options);
  }

  /** Whether the foreground app's SDK observation bridge is available (#5159). */
  async getObservationBridgeStateForIos(
    appId: string,
    timeoutMs?: number,
  ): Promise<import("./observationBridgeState").IosObservationBridgeState> {
    return this.sdkCapability.getObservationBridgeState(
      appId,
      sdkCapabilityQueryOptions(this.timer, timeoutMs ?? 5000),
    );
  }

  async listTablesForIos(
    appId: string,
    databasePath: string,
    timeoutMs?: number,
  ): Promise<string[]> {
    const options = sdkCapabilityQueryOptions(this.timer, timeoutMs ?? 5000);
    await this.sdkCapability.requireSdkCapability("database", appId, options);
    return this.database.listTables(appId, databasePath, options);
  }

  async getTableDataForIos(
    appId: string,
    databasePath: string,
    table: string,
    limit?: number,
    offset?: number,
    timeoutMs?: number,
  ): Promise<import("../../database/DatabaseInspector").TableDataResult> {
    const options = sdkCapabilityQueryOptions(this.timer, timeoutMs ?? 5000);
    await this.sdkCapability.requireSdkCapability("database", appId, options);
    return this.database.getTableData(appId, databasePath, table, limit, offset, options);
  }

  async getTableStructureForIos(
    appId: string,
    databasePath: string,
    table: string,
    timeoutMs?: number,
  ): Promise<import("../../database/DatabaseInspector").TableStructureResult> {
    const options = sdkCapabilityQueryOptions(this.timer, timeoutMs ?? 5000);
    await this.sdkCapability.requireSdkCapability("database", appId, options);
    return this.database.getTableStructure(appId, databasePath, table, options);
  }

  // Runner-reported scale metadata from the most recent forwarded hierarchy (#4548). Retained for
  // #4549's canonical-pixel conversion; null until a #4548-aware runner reports it. Nothing in
  // current behavior reads it — screenGeometry above stays the points * screenScale computation.
  private reportedScaleMetadata: ScreenScaleMetadata | null = null;

  /**
   * Retain the additive #4548 scale metadata from a received hierarchy. Called on RECEIPT (the
   * first `hierarchy_update` branch) so retention is independent of the observation-stream push,
   * which is skipped with no device-data server and suppressed for initial-frame requests. Follows
   * the same freshness rule as the tracked geometry: it always describes THIS hierarchy, so a
   * hierarchy without complete fields (pre-#4548 runner) resets it to null rather than leaving
   * stale values behind. `readScreenScaleMetadata` is the single all-or-nothing validator.
   */
  protected retainScaleMetadataFrom(
    hierarchy:
      | { nativeScale?: number; pixelWidth?: number; pixelHeight?: number }
      | null
      | undefined,
  ): void {
    this.reportedScaleMetadata = readScreenScaleMetadata(hierarchy);
  }

  /**
   * Runner-reported scale metadata from the most recently received hierarchy (#4548), or null
   * when the runner has not reported it (pre-#4548 runner, or no hierarchy yet). Exposed for
   * #4549's canonical-pixel conversion; nothing in current behavior consumes it.
   */
  getScreenScaleMetadata(): ScreenScaleMetadata | null {
    return this.reportedScaleMetadata;
  }
}

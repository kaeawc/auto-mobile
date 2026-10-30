import type WebSocket from "ws";
import type { SendCommandOptions } from "../DeviceServiceUtils";
import type {
  AndroidActionDispatcher,
  AndroidActionRequestOptions,
  AndroidActivateAccessibilityLinkRequest,
  AndroidAccessibilityActionRequest,
} from "./AndroidActionDispatcher";
import type { AndroidHierarchyUpdateHandler } from "./AndroidHierarchyUpdateHandler";
import type { AndroidInboundMessageRouter } from "./AndroidInboundMessageRouter";
import type {
  AndroidScreenshotRequester,
  AndroidScreenshotRequestOptions,
} from "./AndroidScreenshotRequester";
import type { AndroidServiceReadinessVerifier } from "./AndroidServiceReadinessVerifier";
import { type CertificateFileSystem } from "./CtrlProxyCertificates";
import { CtrlProxyPackages } from "./CtrlProxyPackages";
import type { CertificatesDelegateContext, HierarchyDelegateContext } from "./types";

import { ViewHierarchyResult } from "../../../models";
import { NoOpPerformanceTracker } from "../../../utils/PerformanceTracker";
import { AndroidClientRequests } from "./AndroidClientRequests";
// Import delegates
import { CtrlProxyHierarchy } from "./CtrlProxyHierarchy";
import { type PackageInfoOptions } from "./CtrlProxyPackages";
// Import types
import type { PinchRequest, TapCoordinatesRequest } from "../shared/SharedGestureDelegate";
import type { GestureEndOptions, GestureStartRequest } from "./CtrlProxyGestures";
import type {
  A11yActionResult,
  A11yInstalledPackagesResult,
  A11yLaunchIntentResult,
  A11yPackageInfoResult,
  AccessibilityHierarchy,
  AccessibilityHierarchyResponse,
  AccessibilityNodeSelector,
  AndroidPerfTiming,
  HierarchySyncRequestOptions,
  ImeCommitOptions,
  ScreenshotResult,
  TwoFingerSwipeRequest,
} from "./types";
/**
 * The delegating facade of `AndroidCtrlProxyClient` (gestures, text,
 * certificates, storage, focus, prototypes, highlights), extracted from the client (#11846). Every
 * method forwards to the matching delegate, which stays the single source of truth for defaults.
 * Lazy delegates live here; Android services supplies their contexts through the abstract accessors.
 */
import {
  CurrentFocusResult,
  HighlightOperationResult,
  HighlightShape,
  ImeAction,
  TraversalOrderResult,
} from "../../../models";
import { PerformanceTracker } from "../../../utils/PerformanceTracker";
import type { KeyboardProfileCatalog } from "../../action/keyboardProfiles";
import type { PrototypeShowOverrides } from "../../prototype/PrototypeTransport";
import type { PrototypeAssetUpload } from "../../prototype/prototypeAssets";
import {
  type PrototypePatchReply,
  type PrototypePatchRequest,
} from "../../prototype/prototypePatchWire";
import type { PrototypeChannelHost } from "../../prototype/prototypeChannelHost";
import type { PrototypeRequestHost } from "../../prototype/prototypeRequestHandler";
import type { PrototypeSpec } from "../../prototype/prototypeSpec";
import type {
  KeyValueEntry,
  KeyValueWrite,
  PreferenceFile,
  StorageChangedEvent,
} from "../../storage/storageTypes";
import type { SetTextOptions } from "../DeviceService";
import { DeviceServiceClient } from "../DeviceServiceClient";
import type { DragRequest, SwipeRequest } from "../shared/types";
import { CtrlProxyCertificates } from "./CtrlProxyCertificates";
import { CtrlProxyFocus, type FocusActionOutcome } from "./CtrlProxyFocus";
import { CtrlProxyGestures } from "./CtrlProxyGestures";
import { CtrlProxyHighlights } from "./CtrlProxyHighlights";
import { CtrlProxyPrototypes, type PrototypeAssetRequestOptions } from "./CtrlProxyPrototypes";
import { CtrlProxyStorage } from "./CtrlProxyStorage";
import { CtrlProxyText, type ImeCommitActionResult } from "./CtrlProxyText";
import type {
  InsertTextState,
  PrototypeAssetResult,
  PrototypeDismiss,
  PrototypeEvent,
  PrototypeResult,
} from "./ctrlProxyProtocol";
import type {
  A11yCaCertResult,
  A11yDeviceOwnerStatusResult,
  A11yDragResult,
  A11yImeActionResult,
  A11yPermissionResult,
  A11yPinchResult,
  A11ySelectAllResult,
  A11ySetTextResult,
  A11ySwipeResult,
  A11yTapCoordinatesResult,
} from "./types";

export abstract class AndroidCtrlProxyDelegatingFacade extends DeviceServiceClient {
  // ===========================================================================
  // Delegated Public Methods - Gestures
  // ===========================================================================

  // These are thin pass-throughs. They deliberately DO NOT restate the delegate's
  // default parameter values: omitted args forward as `undefined`, so the delegate
  // (the single source of truth) applies its own defaults. This makes the two-copies
  // drift class from issue #3505 unrepresentable.
  async requestSwipe(request: SwipeRequest): Promise<A11ySwipeResult> {
    return this.gestures.requestSwipe(request);
  }

  async requestTapCoordinates(request: TapCoordinatesRequest): Promise<A11yTapCoordinatesResult> {
    const {
      x,
      y,
      duration = 10,
      timeoutMs,
      perf,
      frameContext,
      onDispatch,
      signal,
      displayId,
      beforeSend,
    } = request;

    return this.gestures.requestTapCoordinates({
      x,
      y,
      duration,
      timeoutMs,
      perf,
      frameContext,
      signal,
      onDispatch,
      displayId,
      beforeSend,
    });
  }

  /** Double tap (TalkBack activation, tapOn/tapAny/tapAt) with device-side double-tap timing. */
  async requestDoubleTapCoordinates(
    x: number,
    y: number,
    onDispatch?: () => void,
    options?: {
      frameContext?: string;
      displayId?: number;
      signal?: AbortSignal;
      beforeSend?: () => void;
    },
  ): Promise<A11yTapCoordinatesResult> {
    return this.gestures.requestDoubleTapCoordinates(x, y, onDispatch, options);
  }

  async requestTwoFingerSwipe(request: TwoFingerSwipeRequest): Promise<A11ySwipeResult> {
    return this.gestures.requestTwoFingerSwipe(request);
  }

  async requestMultiFingerSwipe(
    request: Parameters<CtrlProxyGestures["requestMultiFingerSwipe"]>[0],
  ): Promise<A11ySwipeResult> {
    return this.gestures.requestMultiFingerSwipe(request);
  }

  async requestDrag(request: DragRequest): Promise<A11yDragResult> {
    return this.gestures.requestDrag(request);
  }

  async requestPinch(request: PinchRequest): Promise<A11yPinchResult> {
    return this.gestures.requestPinch(request);
  }

  // Streaming gesture input (Android-only): one live drag = start + moves + end sharing a gestureId,
  // chained into a single continued AccessibilityService gesture by the runner.

  async requestGestureStart(request: GestureStartRequest): Promise<A11ySwipeResult> {
    const { gestureId, x, y, timeoutMs, perf, displayId, beforeSend } = request;

    return this.gestures.requestGestureStart({
      gestureId,
      x,
      y,
      timeoutMs,
      perf,
      displayId,
      beforeSend,
    });
  }

  async requestGestureMove(
    gestureId: string,
    x: number,
    y: number,
    { timeoutMs, perf }: { timeoutMs?: number; perf?: PerformanceTracker } = {},
  ): Promise<A11ySwipeResult> {
    return this.gestures.requestGestureMove(gestureId, x, y, { timeoutMs, perf });
  }

  async requestGestureEnd(
    gestureId: string,
    x: number,
    y: number,
    { cancel, ...options }: GestureEndOptions & { cancel?: boolean } = {},
  ): Promise<A11ySwipeResult> {
    return this.gestures.requestGestureEnd(gestureId, x, y, { cancel, ...options });
  }

  // ===========================================================================
  // Delegated Public Methods - Text
  // ===========================================================================

  async requestSetText(text: string, options?: SetTextOptions): Promise<A11ySetTextResult> {
    return this.text.requestSetText(text, options);
  }

  async requestInsertText(
    text: string,
    {
      timeoutMs,
      perf,
      options,
      transport = {},
    }: {
      timeoutMs?: number;
      perf?: PerformanceTracker;
      options?: {
        expectedSuffix?: string;
        acceptsCaretNotPlaced?: boolean;
        precedingState?: InsertTextState;
      };
      transport?: Pick<SetTextOptions, "abortSignal" | "onDispatch" | "deadlineMs">;
    } = {},
  ): Promise<A11ySetTextResult> {
    return this.text.requestInsertText(text, { timeoutMs, perf, options, transport });
  }

  async commitViaIme(
    text: string,
    priorImeId?: string,
    timeoutMs?: number,
    { perf, ...options }: ImeCommitOptions & { perf?: PerformanceTracker } = {},
  ): Promise<ImeCommitActionResult> {
    return this.text.commitViaIme(text, priorImeId, timeoutMs, { perf, ...options });
  }

  async setKeyboardProfile(
    profileId: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<{
    success: boolean;
    activeProfileId?: string;
    previousProfileId?: string;
    error?: string;
  }> {
    return this.text.setKeyboardProfile(profileId, timeoutMs, perf);
  }

  async listKeyboardProfiles(
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<KeyboardProfileCatalog> {
    return this.text.listKeyboardProfiles(timeoutMs, perf);
  }

  async requestClearText(
    resourceId?: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<A11ySetTextResult> {
    return this.text.requestClearText(resourceId, timeoutMs, perf);
  }

  async requestImeAction(
    action: ImeAction,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    { abortSignal, onDispatch }: { abortSignal?: AbortSignal; onDispatch?: () => void } = {},
  ): Promise<A11yImeActionResult> {
    return this.text.requestImeAction(action, timeoutMs, perf, { abortSignal, onDispatch });
  }

  async requestSelectAll(
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<A11ySelectAllResult> {
    return this.text.requestSelectAll(timeoutMs, perf);
  }

  // ===========================================================================
  // Delegated Public Methods - Certificates & Permissions
  // ===========================================================================

  async requestInstallCaCertificate(
    certificate: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<A11yCaCertResult> {
    return this.certificates.requestInstallCaCertificate(certificate, timeoutMs, perf);
  }

  async requestInstallCaCertificateFromFile(
    certificatePath: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<A11yCaCertResult> {
    return this.certificates.requestInstallCaCertificateFromFile(certificatePath, timeoutMs, perf);
  }

  async requestRemoveCaCertificate(
    alias: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<A11yCaCertResult> {
    return this.certificates.requestRemoveCaCertificate(alias, timeoutMs, perf);
  }

  async requestDeviceOwnerStatus(
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<A11yDeviceOwnerStatusResult> {
    return this.certificates.requestDeviceOwnerStatus(timeoutMs, perf);
  }

  async requestPermission(
    permission: string,
    requestPermission?: boolean,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<A11yPermissionResult> {
    return this.certificates.requestPermission(permission, requestPermission, timeoutMs, perf);
  }

  // ===========================================================================
  // Delegated Public Methods - Storage
  // ===========================================================================

  async listPreferenceFiles(packageName: string, timeoutMs?: number): Promise<PreferenceFile[]> {
    return this.storage.listPreferenceFiles(packageName, timeoutMs);
  }

  async getPreferenceEntries(
    packageName: string,
    fileName: string,
    timeoutMs?: number,
  ): Promise<KeyValueEntry[]> {
    return this.storage.getPreferenceEntries(packageName, fileName, timeoutMs);
  }

  async discoverKeystore(packageName: string) {
    return this.storage.discoverKeystore(packageName);
  }

  async getSdkCapabilities(packageName: string, userId?: number) {
    return this.storage.getSdkCapabilities(packageName, userId);
  }

  async listDataStores(
    packageName: string,
    adapterName: string,
    timeoutMs?: number,
  ): Promise<PreferenceFile[]> {
    return this.storage.listDataStores(packageName, adapterName, timeoutMs);
  }

  async getDataStore(
    packageName: string,
    adapterName: string,
    storeName: string,
    timeoutMs?: number,
  ): Promise<KeyValueEntry[]> {
    return this.storage.getDataStore(packageName, adapterName, storeName, timeoutMs);
  }

  async getPreference(
    packageName: string,
    fileName: string,
    key: string,
    timeoutMs?: number,
  ): Promise<KeyValueEntry | null> {
    return this.storage.getPreference(packageName, fileName, key, timeoutMs);
  }

  async setPreference(
    packageName: string,
    fileName: string,
    entry: KeyValueWrite,
    timeoutMsOrOptions?: number | import("../../storage/storageTypes").StorageWriteOptions,
  ): Promise<void> {
    return this.storage.setPreference(packageName, fileName, entry, timeoutMsOrOptions);
  }

  async removePreference(
    packageName: string,
    fileName: string,
    key: string,
    timeoutMsOrOptions?: number | import("../../storage/storageTypes").StorageWriteOptions,
  ): Promise<void> {
    return this.storage.removePreference(packageName, fileName, key, timeoutMsOrOptions);
  }

  async clearPreferenceStore(
    packageName: string,
    fileName: string,
    timeoutMsOrOptions?: number | import("../../storage/storageTypes").StorageWriteOptions,
  ): Promise<void> {
    return this.storage.clearPreferenceStore(packageName, fileName, timeoutMsOrOptions);
  }

  async unsubscribeStorage(subscriptionId: string, timeoutMs?: number): Promise<void> {
    return this.storage.unsubscribeStorage(subscriptionId, timeoutMs);
  }

  addStorageChangeListener(callback: (event: StorageChangedEvent) => void): () => void {
    return this.storage.addStorageChangeListener(callback);
  }

  // ===========================================================================
  // Delegated Public Methods - Focus
  // ===========================================================================

  async clearAccessibilityFocus(
    resourceId: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<FocusActionOutcome> {
    return this.focus.clearAccessibilityFocus(resourceId, timeoutMs, perf);
  }

  async setAccessibilityFocus(
    resourceId: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<FocusActionOutcome> {
    return this.focus.setAccessibilityFocus(resourceId, timeoutMs, perf);
  }

  async requestCurrentFocus(
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<CurrentFocusResult> {
    return this.focus.requestCurrentFocus(timeoutMs, perf);
  }

  async requestTraversalOrder(
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<TraversalOrderResult> {
    return this.focus.requestTraversalOrder(timeoutMs, perf);
  }

  // ===========================================================================
  // Delegated Public Methods - Highlights
  // ===========================================================================

  requestShowPrototype(
    spec: PrototypeSpec,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    overrides?: PrototypeShowOverrides,
  ): Promise<PrototypeResult> {
    return this.prototypes.requestShowPrototype(spec, timeoutMs, perf, overrides);
  }
  requestDismissPrototype(
    target: PrototypeDismiss,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<PrototypeResult> {
    return this.prototypes.requestDismissPrototype(target, timeoutMs, perf);
  }
  requestPatchPrototype(
    patch: PrototypePatchRequest,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<PrototypePatchReply> {
    return this.prototypes.requestPatchPrototype(patch, timeoutMs, perf);
  }

  requestSavePrototype(
    save: { spec: PrototypeSpec; label: string; icon?: string },
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<PrototypeResult> {
    return this.prototypes.requestSavePrototype(save, timeoutMs, perf);
  }
  requestPinSavedPrototype(
    id: string,
    icon?: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<PrototypeResult> {
    return this.prototypes.requestPinSavedPrototype(id, icon, timeoutMs, perf);
  }
  requestListSavedPrototypes(
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<PrototypeResult> {
    return this.prototypes.requestListSavedPrototypes(timeoutMs, perf);
  }
  requestDeleteSavedPrototype(
    id: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<PrototypeResult> {
    return this.prototypes.requestDeleteSavedPrototype(id, timeoutMs, perf);
  }
  requestAdvancePrototypeClock(
    id: string,
    advanceTimeMs: number,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<PrototypeResult> {
    return this.prototypes.requestAdvancePrototypeClock(id, advanceTimeMs, timeoutMs, perf);
  }
  requestClearPrototypeStorage(
    id: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<PrototypeResult> {
    return this.prototypes.requestClearPrototypeStorage(id, timeoutMs, perf);
  }

  requestInspectPrototypes(
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<PrototypeResult> {
    return this.prototypes.requestInspectPrototypes(timeoutMs, perf);
  }
  requestPutPrototypeAsset(
    asset: PrototypeAssetUpload,
    options?: PrototypeAssetRequestOptions,
  ): Promise<PrototypeAssetResult> {
    return this.prototypes.requestPutPrototypeAsset(asset, options);
  }
  requestRemovePrototypeAsset(
    id: string,
    options?: PrototypeAssetRequestOptions,
  ): Promise<PrototypeAssetResult> {
    return this.prototypes.requestRemovePrototypeAsset(id, options);
  }
  onPrototypeEvent(listener: (event: PrototypeEvent) => void): () => void {
    return this.prototypes.onPrototypeEvent(listener);
  }
  attachPrototypeRequestHost(host: PrototypeRequestHost | undefined): void {
    this.prototypes.attachRequestHost(host);
  }
  attachPrototypeChannelHost(host: PrototypeChannelHost | undefined): void {
    this.prototypes.channels.attach(host);
  }

  async requestAddHighlight(
    id: string,
    shape: HighlightShape,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<HighlightOperationResult> {
    return this.highlights.requestAddHighlight(id, shape, timeoutMs, perf);
  }

  async requestInstalledPackages(
    includeSystem: boolean = true,
    userId?: number,
    timeoutMs: number = 5000,
  ): Promise<A11yInstalledPackagesResult> {
    return this.packages.requestInstalledPackages(includeSystem, userId, timeoutMs);
  }

  async requestPackageInfo(
    packageName: string,
    options: PackageInfoOptions = {},
    timeoutMs: number = 5000,
  ): Promise<A11yPackageInfoResult> {
    return this.packages.requestPackageInfo(packageName, options, timeoutMs);
  }

  async requestLaunchIntent(
    packageName: string,
    timeoutMs: number = 5000,
  ): Promise<A11yLaunchIntentResult> {
    return this.packages.requestLaunchIntent(packageName, timeoutMs);
  }

  // ===========================================================================
  // Delegated Public Methods - Hierarchy
  // ===========================================================================

  // Thin pass-throughs: like the gesture/text/etc. delegates below, these do NOT
  // restate the delegate's default parameter values. Omitted args forward as
  // `undefined`, so CtrlProxyHierarchy (the single source of truth) applies its own
  // defaults — keeping the two-copies drift class from issue #3505 unrepresentable.
  async getAccessibilityHierarchy(
    ...args: Parameters<CtrlProxyHierarchy["getAccessibilityHierarchy"]>
  ): Promise<ViewHierarchyResult | null> {
    return this.hierarchy.getAccessibilityHierarchy(...args);
  }

  async setRecompositionTrackingEnabled(
    enabled: boolean,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.hierarchy.setRecompositionTrackingEnabled(enabled, perf, signal);
  }

  async getLatestHierarchy(
    ...args: Parameters<CtrlProxyHierarchy["getLatestHierarchy"]>
  ): Promise<AccessibilityHierarchyResponse> {
    return this.hierarchy.getLatestHierarchy(...args);
  }

  async requestHierarchySync(
    perf?: PerformanceTracker,
    disableAllFiltering?: boolean,
    signal?: AbortSignal,
    { timeoutMs, ...options }: HierarchySyncRequestOptions & { timeoutMs?: number } = {},
  ): Promise<{ hierarchy: AccessibilityHierarchy; perfTiming?: AndroidPerfTiming[] } | null> {
    return this.hierarchy.requestHierarchySync(perf, disableAllFiltering, signal, {
      timeoutMs,
      ...options,
    });
  }

  hasCachedHierarchy(): boolean {
    return this.hierarchy.hasCachedHierarchy();
  }

  invalidateCache(): void {
    return this.hierarchy.invalidateCache();
  }

  async requestInsertTextState(): Promise<{ success: boolean; state?: InsertTextState }> {
    // Older APKs do not know this optional command; absence retains legacy suffix settling.
    if (!(await this.supportsCommand("request_insert_text_state"))) {
      return { success: true };
    }
    return this.text.requestInsertTextState();
  }

  // ===========================================================================
  // Non-delegated Public Methods
  // ===========================================================================

  async requestAction(
    action: string,
    resourceId?: string,
    timeoutMs?: number,
    { perf, ...options }: AndroidActionRequestOptions & { perf?: PerformanceTracker } = {},
  ): Promise<A11yActionResult> {
    return this.getActionDispatcher().requestAction(action, resourceId, timeoutMs, {
      perf,
      ...options,
    });
  }

  async requestClickFocusedInput(
    timeoutMs?: number,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<A11yActionResult> {
    return this.getActionDispatcher().requestClickFocusedInput(timeoutMs, perf, signal);
  }

  async requestNodeAction(
    action: string,
    selector: AccessibilityNodeSelector,
    {
      timeoutMs,
      perf,
      signal,
    }: { timeoutMs?: number; perf?: PerformanceTracker; signal?: AbortSignal } = {},
  ): Promise<A11yActionResult> {
    return this.getActionDispatcher().requestNodeAction(action, selector, {
      timeoutMs,
      perf,
      signal,
    });
  }

  async supportsNodeActionSelectors(
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return this.getActionDispatcher().supportsNodeActionSelectors(perf, signal);
  }

  public async supportsCommand(name: string): Promise<boolean> {
    return (await this.getSupportedCommands())?.includes(name) === true;
  }

  /** Perform a semantic or custom accessibility action on a node (#14077). */
  async requestAccessibilityAction(
    request: AndroidAccessibilityActionRequest,
  ): Promise<A11yActionResult> {
    return this.getActionDispatcher().requestAccessibilityAction(request);
  }

  async supportsAccessibilityLinkActivation(perf?: PerformanceTracker): Promise<boolean> {
    return this.getActionDispatcher().supportsAccessibilityLinkActivation(perf);
  }

  async requestActivateAccessibilityLink(
    request: AndroidActivateAccessibilityLinkRequest,
  ): Promise<A11yActionResult> {
    const { text, occurrence, selector, timeoutMs, perf, signal, onDispatch } = request;

    return this.getActionDispatcher().requestActivateAccessibilityLink({
      text,
      occurrence,
      selector,
      timeoutMs,
      perf,
      signal,
      onDispatch,
    });
  }

  requestClipboard(
    ...args: Parameters<AndroidClientRequests["requestClipboard"]>
  ): ReturnType<AndroidClientRequests["requestClipboard"]> {
    return this.getClientRequests().requestClipboard(...args);
  }

  requestSettingsGet(
    ...args: Parameters<AndroidClientRequests["requestSettingsGet"]>
  ): ReturnType<AndroidClientRequests["requestSettingsGet"]> {
    return this.getClientRequests().requestSettingsGet(...args);
  }

  requestSettingsPut(
    ...args: Parameters<AndroidClientRequests["requestSettingsPut"]>
  ): ReturnType<AndroidClientRequests["requestSettingsPut"]> {
    return this.getClientRequests().requestSettingsPut(...args);
  }

  requestSettingsList(
    ...args: Parameters<AndroidClientRequests["requestSettingsList"]>
  ): ReturnType<AndroidClientRequests["requestSettingsList"]> {
    return this.getClientRequests().requestSettingsList(...args);
  }

  requestGlobalAction(
    ...args: Parameters<AndroidClientRequests["requestGlobalAction"]>
  ): ReturnType<AndroidClientRequests["requestGlobalAction"]> {
    return this.getClientRequests().requestGlobalAction(...args);
  }

  validateFrameContext(
    ...args: Parameters<AndroidClientRequests["validateFrameContext"]>
  ): ReturnType<AndroidClientRequests["validateFrameContext"]> {
    return this.getClientRequests().validateFrameContext(...args);
  }

  requestDeviceInfo(
    ...args: Parameters<AndroidClientRequests["requestDeviceInfo"]>
  ): ReturnType<AndroidClientRequests["requestDeviceInfo"]> {
    return this.getClientRequests().requestDeviceInfo(...args);
  }

  /**
   * `hidePrototypes` asks the device to hide its prototype for this capture (#9305); it is sent only
   * to a CtrlProxy advertising `screenshot_hide_prototype_v1`, and the result's `prototypesHidden`
   * reports the outcome.
   */
  async requestScreenshot(
    timeoutMs: number = 5000,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    options: AndroidScreenshotRequestOptions = {},
  ): Promise<ScreenshotResult> {
    return this.getScreenshotRequester().requestScreenshot(timeoutMs, perf, options);
  }

  async requestScreenshotWithoutObservationStreamPush(
    timeoutMs: number = 5000,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
  ): Promise<ScreenshotResult> {
    return this.requestScreenshot(timeoutMs, perf, { suppressObservationStreamPush: true });
  }

  async verifyServiceReady(
    maxAttempts: number = 5,
    delayMs: number = 500,
    timeoutMs: number = 3000,
  ): Promise<boolean> {
    return this.getServiceReadinessVerifier().verifyServiceReady(maxAttempts, delayMs, timeoutMs);
  }
  protected abstract getActionDispatcher(): Pick<
    AndroidActionDispatcher,
    | "requestAction"
    | "requestClickFocusedInput"
    | "requestNodeAction"
    | "supportsNodeActionSelectors"
    | "supportsAccessibilityLinkActivation"
    | "requestActivateAccessibilityLink"
    | "requestAccessibilityAction"
    | "sendClientCommand"
  >;
  protected abstract getClientRequests(): AndroidClientRequests;
  protected abstract getScreenshotRequester(): Pick<
    AndroidScreenshotRequester,
    "requestScreenshot"
  >;
  protected abstract getServiceReadinessVerifier(): Pick<
    AndroidServiceReadinessVerifier,
    "verifyServiceReady"
  >;

  // Delegate instances (lazy initialized)
  protected _gestures: CtrlProxyGestures | null = null;

  protected _text: CtrlProxyText | null = null;

  protected _hierarchy: CtrlProxyHierarchy | null = null;

  protected _storage: CtrlProxyStorage | null = null;

  protected _certificates: CtrlProxyCertificates | null = null;

  protected _focus: CtrlProxyFocus | null = null;

  protected _prototypes: CtrlProxyPrototypes | null = null;

  protected _highlights: CtrlProxyHighlights | null = null;

  protected _packages: CtrlProxyPackages | null = null;

  // ===========================================================================
  // Delegate Getters (lazy initialization)
  // ===========================================================================

  protected get gestures(): CtrlProxyGestures {
    return (this._gestures ??= new CtrlProxyGestures(this.createDelegateContext()));
  }

  protected get text(): CtrlProxyText {
    return (this._text ??= new CtrlProxyText(this.createDelegateContext()));
  }

  /** @internal Test seam for CtrlProxyClient tests (#7992); not part of the public API. */
  get hierarchy(): CtrlProxyHierarchy {
    return (this._hierarchy ??= new CtrlProxyHierarchy(this.createHierarchyDelegateContext()));
  }

  protected get storage(): CtrlProxyStorage {
    return (this._storage ??= new CtrlProxyStorage(this.createDelegateContext()));
  }

  protected get certificates(): CtrlProxyCertificates {
    return (this._certificates ??= new CtrlProxyCertificates(
      this.createCertificatesDelegateContext(),
      this.certificateFileSystem,
    ));
  }

  protected get focus(): CtrlProxyFocus {
    return (this._focus ??= new CtrlProxyFocus(this.createDelegateContext()));
  }

  protected get prototypes(): CtrlProxyPrototypes {
    return (this._prototypes ??= new CtrlProxyPrototypes(this.createDelegateContext()));
  }

  protected get highlights(): CtrlProxyHighlights {
    return (this._highlights ??= new CtrlProxyHighlights(this.createDelegateContext()));
  }

  protected get packages(): CtrlProxyPackages {
    return (this._packages ??= new CtrlProxyPackages(this.createDelegateContext()));
  }

  protected awaitCancellableRequest<
    T extends { success: boolean; totalTimeMs: number; error?: string },
  >(
    requestId: string,
    promise: Promise<T>,
    signal: AbortSignal | undefined,
    startTime: number,
  ): Promise<T> {
    return this.getClientRequests().awaitCancellableRequest(requestId, promise, signal, startTime);
  }

  /** These legacy client requests bypass the generic capability/deadline gate. */
  protected sendClientCommand<T extends { success: boolean; totalTimeMs: number; error?: string }>(
    requestId: string,
    serializeRequest: (requestId: string) => string,
    options: Pick<
      SendCommandOptions<T>,
      "responseType" | "messageType" | "timeoutMs" | "responseError" | "beforeSend" | "onDispatch"
    > & { timeoutError: (timeoutMs: number) => T },
    {
      cancellation,
      perf,
    }: {
      cancellation?: { signal: AbortSignal | undefined; startTime: number };
      perf?: PerformanceTracker;
    } = {},
  ): Promise<T> {
    return this.getActionDispatcher().sendClientCommand<T>(requestId, serializeRequest, options, {
      cancellation,
      perf,
    });
  }
  protected abstract createHierarchyDelegateContext(): HierarchyDelegateContext;
  protected abstract createCertificatesDelegateContext(): CertificatesDelegateContext;
  protected abstract readonly certificateFileSystem: CertificateFileSystem | undefined;

  protected get webSocketMessageHandlers() {
    return this.getInboundMessageRouter().webSocketMessageHandlers;
  }

  protected handleWebSocketMessage(data: WebSocket.Data): Promise<void> {
    return this.getInboundMessageRouter().handleWebSocketMessage(data);
  }

  /** @internal Test seam for CtrlProxyClient tests (#7992); not part of the public API. */
  handleHierarchyUpdate(
    data: AccessibilityHierarchy,
    perfTiming?: AndroidPerfTiming[],
    frameContext?: string,
    requestId?: string | null,
  ): void {
    this.getHierarchyUpdateHandler().handle(data, perfTiming, frameContext, requestId);
  }
  protected abstract getInboundMessageRouter(): Pick<
    AndroidInboundMessageRouter,
    "handleWebSocketMessage" | "webSocketMessageHandlers"
  >;
  protected abstract getHierarchyUpdateHandler(): Pick<AndroidHierarchyUpdateHandler, "handle">;
}

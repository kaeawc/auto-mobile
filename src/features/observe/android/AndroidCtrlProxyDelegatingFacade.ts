/**
 * The thin, positional-signature delegating facades of `AndroidCtrlProxyClient` (gestures, text,
 * certificates, storage, focus, prototypes, highlights), extracted from the client (#11846). Every
 * method forwards to the matching delegate, which stays the single source of truth for defaults.
 * The client supplies the delegates through the abstract accessors below.
 */
import type { PrototypeShowOverrides } from "../../prototype/PrototypeTransport";
import {
  type PrototypePatchRequest,
  type PrototypePatchReply,
} from "../../prototype/prototypePatchWire";
import type { InsertTextState } from "./ctrlProxyProtocol";
import {
  ImeAction,
  CurrentFocusResult,
  TraversalOrderResult,
  HighlightOperationResult,
  HighlightShape,
} from "../../../models";
import { PerformanceTracker } from "../../../utils/PerformanceTracker";
import type {
  PreferenceFile,
  KeyValueEntry,
  KeyValueType,
  StorageChangedEvent,
} from "../../storage/storageTypes";
import type { SetTextOptions } from "../DeviceService";
import { CtrlProxyGestures } from "./CtrlProxyGestures";
import { type ImeCommitActionResult } from "./CtrlProxyText";
import type { KeyboardProfileCatalog } from "../../action/keyboardProfiles";
import { type FocusActionOutcome } from "./CtrlProxyFocus";
import { type PrototypeAssetRequestOptions } from "./CtrlProxyPrototypes";
import type { PrototypeSpec } from "../../prototype/prototypeSpec";
import type { PrototypeAssetUpload } from "../../prototype/prototypeAssets";
import type {
  PrototypeAppearanceOverride,
  PrototypeAssetResult,
  PrototypeDismiss,
  PrototypeEvent,
  PrototypeResult,
} from "./ctrlProxyProtocol";
import type {
  A11ySwipeResult,
  A11yTapCoordinatesResult,
  A11yDragResult,
  A11yPinchResult,
  A11ySetTextResult,
  A11yImeActionResult,
  A11ySelectAllResult,
  A11yCaCertResult,
  A11yDeviceOwnerStatusResult,
  A11yPermissionResult,
} from "./types";
import { DeviceServiceClient } from "../DeviceServiceClient";
import type { CtrlProxyText } from "./CtrlProxyText";
import type { CtrlProxyCertificates } from "./CtrlProxyCertificates";
import type { CtrlProxyStorage } from "./CtrlProxyStorage";
import type { CtrlProxyFocus } from "./CtrlProxyFocus";
import type { CtrlProxyPrototypes } from "./CtrlProxyPrototypes";
import type { CtrlProxyHighlights } from "./CtrlProxyHighlights";

export abstract class AndroidCtrlProxyDelegatingFacade extends DeviceServiceClient {
  protected abstract get gestures(): CtrlProxyGestures;
  protected abstract get text(): CtrlProxyText;
  protected abstract get certificates(): CtrlProxyCertificates;
  protected abstract get storage(): CtrlProxyStorage;
  protected abstract get focus(): CtrlProxyFocus;
  protected abstract get prototypes(): CtrlProxyPrototypes;
  protected abstract get highlights(): CtrlProxyHighlights;

  // ===========================================================================
  // Delegated Public Methods - Gestures
  // ===========================================================================

  // These are thin pass-throughs. They deliberately DO NOT restate the delegate's
  // default parameter values: omitted args forward as `undefined`, so the delegate
  // (the single source of truth) applies its own defaults. This makes the two-copies
  // drift class from issue #3505 unrepresentable.
  async requestSwipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    duration?: number,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    frameContext?: string,
    onDispatch?: () => void,
    signal?: AbortSignal,
    displayId?: number,
    beforeSend?: () => void,
  ): Promise<A11ySwipeResult> {
    return this.gestures.requestSwipe(
      x1,
      y1,
      x2,
      y2,
      duration,
      timeoutMs,
      perf,
      frameContext,
      onDispatch,
      signal,
      displayId,
      beforeSend,
    );
  }

  async requestTapCoordinates(
    x: number,
    y: number,
    // Deliberate Android-specific override: taps default to a 10ms press, not the
    // delegate's cross-platform 0ms default. This is the one intentional divergence,
    // not restated drift — see issue #3505.
    duration: number = 10,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    frameContext?: string,
    onDispatch?: () => void,
    signal?: AbortSignal,
    displayId?: number,
    beforeSend?: () => void,
  ): Promise<A11yTapCoordinatesResult> {
    return this.gestures.requestTapCoordinates(
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
    );
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

  async requestTwoFingerSwipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    duration?: number,
    offset?: number,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    displayId?: number,
    beforeSend?: () => void,
  ): Promise<A11ySwipeResult> {
    return this.gestures.requestTwoFingerSwipe(
      x1,
      y1,
      x2,
      y2,
      duration,
      offset,
      timeoutMs,
      perf,
      displayId,
      beforeSend,
    );
  }

  async requestMultiFingerSwipe(
    request: Parameters<CtrlProxyGestures["requestMultiFingerSwipe"]>[0],
  ): Promise<A11ySwipeResult> {
    return this.gestures.requestMultiFingerSwipe(request);
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
    return this.gestures.requestDrag(
      x1,
      y1,
      x2,
      y2,
      pressDurationMs,
      dragDurationMs,
      holdDurationMs,
      timeoutMs,
      frameContext,
      signal,
      displayId,
      beforeSend,
      onDispatch,
    );
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
    return this.gestures.requestPinch(
      centerX,
      centerY,
      distanceStart,
      distanceEnd,
      rotationDegrees,
      duration,
      timeoutMs,
      perf,
      signal,
      displayId,
      beforeSend,
    );
  }

  // Streaming gesture input (Android-only): one live drag = start + moves + end sharing a gestureId,
  // chained into a single continued AccessibilityService gesture by the runner.
  // oxlint-disable-next-line max-params -- Append the dispatch fence to the existing positional Android API.
  async requestGestureStart(
    gestureId: string,
    x: number,
    y: number,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    displayId?: number,
    beforeSend?: () => void,
  ): Promise<A11ySwipeResult> {
    return this.gestures.requestGestureStart(
      gestureId,
      x,
      y,
      timeoutMs,
      perf,
      displayId,
      beforeSend,
    );
  }

  async requestGestureMove(
    gestureId: string,
    x: number,
    y: number,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<A11ySwipeResult> {
    return this.gestures.requestGestureMove(gestureId, x, y, timeoutMs, perf);
  }

  async requestGestureEnd(
    gestureId: string,
    x: number,
    y: number,
    cancel?: boolean,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<A11ySwipeResult> {
    return this.gestures.requestGestureEnd(gestureId, x, y, cancel, timeoutMs, perf);
  }

  // ===========================================================================
  // Delegated Public Methods - Text
  // ===========================================================================

  async requestSetText(text: string, options?: SetTextOptions): Promise<A11ySetTextResult> {
    return this.text.requestSetText(text, options);
  }

  async requestInsertText(
    text: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    options?: {
      expectedSuffix?: string;
      acceptsCaretNotPlaced?: boolean;
      precedingState?: InsertTextState;
    },
    transport: Pick<SetTextOptions, "abortSignal" | "onDispatch" | "deadlineMs"> = {},
  ): Promise<A11ySetTextResult> {
    return this.text.requestInsertText(text, timeoutMs, perf, options, transport);
  }

  async commitViaIme(
    text: string,
    priorImeId?: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
    ...[delivery, trace]: [delivery?: "commit" | "keyEvents" | "clearField", trace?: boolean]
  ): Promise<ImeCommitActionResult> {
    return this.text.commitViaIme(text, priorImeId, timeoutMs, perf, signal, delivery, trace);
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
    abortSignal?: AbortSignal,
    onDispatch?: () => void,
  ): Promise<A11yImeActionResult> {
    return this.text.requestImeAction(action, timeoutMs, perf, abortSignal, onDispatch);
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
    key: string,
    value: string | null,
    type: KeyValueType,
    timeoutMsOrOptions?: number | import("../../storage/storageTypes").StorageWriteOptions,
  ): Promise<void> {
    return this.storage.setPreference(packageName, fileName, key, value, type, timeoutMsOrOptions);
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
    displayId?: number,
    reset?: boolean,
    appearance?: PrototypeAppearanceOverride | PrototypeShowOverrides,
  ): Promise<PrototypeResult> {
    return this.prototypes.requestShowPrototype(
      spec,
      timeoutMs,
      perf,
      displayId,
      reset,
      appearance,
    );
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

  async requestAddHighlight(
    id: string,
    shape: HighlightShape,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<HighlightOperationResult> {
    return this.highlights.requestAddHighlight(id, shape, timeoutMs, perf);
  }
}

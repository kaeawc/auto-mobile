import type { PinchRequest } from "../shared/SharedGestureDelegate";
import type { TwoFingerSwipeRequest } from "./types";
import type { PrototypeShowOverrides } from "../../prototype/PrototypeTransport";
import type {
  PrototypePatchRequest,
  PrototypePatchReply,
} from "../../prototype/prototypePatchWire";
import type { InsertTextState } from "./ctrlProxyProtocol";
import type {
  ImeAction,
  ViewHierarchyResult,
  HighlightOperationResult,
  HighlightShape,
} from "../../../models";
import type { PerformanceTracker } from "../../../utils/PerformanceTracker";
import type { SetTextOptions } from "../DeviceService";
import type { TapCoordinatesRequest } from "../shared/SharedGestureDelegate";
import type {
  AndroidAccessibilityActionRequest,
  AndroidActivateAccessibilityLinkRequest,
} from "./AndroidActionDispatcher";
import type { CtrlProxyClient } from "../interfaces/CtrlProxyClient";
import type { ImeCommitActionResult } from "./CtrlProxyText";
import type { KeyboardProfileCatalog } from "../../action/keyboardProfiles";
import type { PrototypeAssetRequestOptions } from "./CtrlProxyPrototypes";
import type { PrototypeSpec } from "../../prototype/prototypeSpec";
import type { PrototypeAssetUpload } from "../../prototype/prototypeAssets";
import type {
  PrototypeAppearanceOverride,
  PrototypeAssetResult,
  PrototypeDismiss,
  PrototypeEvent,
  PrototypeResult,
} from "./ctrlProxyProtocol";
import type { PackageInfoOptions } from "./CtrlProxyPackages";
import type { DragRequest, SwipeRequest } from "../shared/types";
import type {
  AccessibilityHierarchy,
  AccessibilityHierarchyResponse,
  ScreenshotResult,
  A11ySwipeResult,
  A11yTapCoordinatesResult,
  A11yDragResult,
  A11yPinchResult,
  A11ySetTextResult,
  A11yImeActionResult,
  A11ySelectAllResult,
  A11yActionResult,
  AccessibilityNodeSelector,
  A11yClipboardResult,
  A11yCaCertResult,
  A11yDeviceOwnerStatusResult,
  A11yPermissionResult,
  A11ySettingsGetResult,
  A11ySettingsPutResult,
  A11ySettingsListResult,
  SettingsNamespace,
  SettingsValueType,
  A11yInstalledPackagesResult,
  A11yPackageInfoResult,
  A11yLaunchIntentResult,
  AndroidPerfTiming,
  HierarchySyncDiagnostics,
} from "./types";
import type { AndroidCtrlProxyClient } from "./AndroidCtrlProxyClient";

/**
 * Interface for accessibility service providing Android UI hierarchy and interaction capabilities
 */
/** Concrete-client members that production callers reach through `getInstance()`. */
export type AndroidCtrlProxyClientSurface = Pick<
  AndroidCtrlProxyClient,
  | "attachPrototypeChannelHost"
  | "attachPrototypeRequestHost"
  | "bindSession"
  | "getPreferenceEntries"
  | "getSdkScreenIdentity"
  | "invalidateForShutdownRecovery"
  | "listPreferenceFiles"
  | "notifyRecordingStopped"
  | "onDisplayTransition"
  | "requestAdvancePrototypeClock"
  | "requestClearPrototypeStorage"
  | "requestDeviceInfo"
  | "requestDrag"
  | "requestGlobalAction"
  | "validateFrameContext"
  | "getScreenScaleMetadata"
  | "requestGestureEnd"
  | "requestMultiFingerSwipe"
  | "listDataStores"
  | "getDataStore"
  | "sendMessage"
  | "pushNetworkMockRules"
  | "getSdkCapabilities"
  | "discoverKeystore"
  | "setPreference"
  | "removePreference"
  | "clearPreferenceStore"
  | "recordInitialObservationStreamHierarchy"
  | "captureScreenshotForObservationStream"
  | "requestCurrentFocus"
  | "requestTraversalOrder"
  | "setAccessibilityFocus"
  | "clearAccessibilityFocus"
  | "requestGestureStart"
  | "requestGestureMove"
  | "getSupportedCommands"
  | "getSdkScreenIdentityReceivedAtMs"
  | "awaitSdkScreenIdentityAfter"
  | "supportsCommand"
  | "notifyRecordingStarted"
  | "onInteraction"
  | "requestDoubleTapCoordinates"
>;

export interface AndroidCtrlProxy
  extends Omit<CtrlProxyClient, "requestPinch">, AndroidCtrlProxyClientSurface {
  isLastConnectionFailureForwardingLeaseConflict?(): boolean;
  getLastConnectionFailureMessage?(): string | undefined;
  setRecompositionTrackingEnabled(
    enabled: boolean,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<void>;

  getLatestHierarchy(
    waitForFresh?: boolean,
    timeout?: number,
    perf?: PerformanceTracker,
    skipWaitForFresh?: boolean,
    minTimestamp?: number,
  ): Promise<AccessibilityHierarchyResponse>;

  requestHierarchySync(
    perf?: PerformanceTracker,
    disableAllFiltering?: boolean,
    signal?: AbortSignal,
    timeoutMs?: number,
    diagnostics?: HierarchySyncDiagnostics,
    displayId?: number,
  ): Promise<{
    hierarchy: AccessibilityHierarchy;
    perfTiming?: AndroidPerfTiming[];
    frameContext?: string;
  } | null>;

  requestHierarchySyncWithoutObservationStreamPush(
    perf?: PerformanceTracker,
    disableAllFiltering?: boolean,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<{
    hierarchy: AccessibilityHierarchy;
    perfTiming?: AndroidPerfTiming[];
    frameContext?: string;
  } | null>;

  convertToViewHierarchyResult(accessibilityHierarchy: AccessibilityHierarchy): ViewHierarchyResult;

  requestSwipe(request: SwipeRequest): Promise<A11ySwipeResult>;

  requestTapCoordinates(request: TapCoordinatesRequest): Promise<A11yTapCoordinatesResult>;

  requestDrag(request: DragRequest): Promise<A11yDragResult>;

  requestTwoFingerSwipe(request: TwoFingerSwipeRequest): Promise<A11ySwipeResult>;

  requestPinch(request: PinchRequest): Promise<A11yPinchResult>;

  requestSetText(text: string, options?: SetTextOptions): Promise<A11ySetTextResult>;

  requestInsertTextState(): Promise<{ success: boolean; state?: InsertTextState }>;

  requestInsertText(
    text: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    options?: {
      expectedSuffix?: string;
      acceptsCaretNotPlaced?: boolean;
      precedingState?: InsertTextState;
    },
    transport?: Pick<SetTextOptions, "abortSignal" | "onDispatch" | "deadlineMs">,
  ): Promise<A11ySetTextResult>;

  commitViaIme(
    text: string,
    priorImeId?: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
    delivery?: "commit" | "keyEvents" | "clearField",
    trace?: boolean,
  ): Promise<ImeCommitActionResult>;

  setKeyboardProfile(
    profileId: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<{
    success: boolean;
    activeProfileId?: string;
    previousProfileId?: string;
    error?: string;
  }>;

  listKeyboardProfiles(
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<KeyboardProfileCatalog>;

  requestClearText(
    resourceId?: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<A11ySetTextResult>;

  requestImeAction(
    action: ImeAction,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    abortSignal?: AbortSignal,
    onDispatch?: () => void,
  ): Promise<A11yImeActionResult>;

  requestSelectAll(timeoutMs?: number, perf?: PerformanceTracker): Promise<A11ySelectAllResult>;

  requestAction(
    action: string,
    resourceId?: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<A11yActionResult>;

  requestClickFocusedInput(
    timeoutMs?: number,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<A11yActionResult>;

  requestNodeAction(
    action: string,
    selector: AccessibilityNodeSelector,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<A11yActionResult>;

  supportsNodeActionSelectors(perf?: PerformanceTracker, signal?: AbortSignal): Promise<boolean>;

  supportsCommand(name: string): Promise<boolean>;

  requestActivateAccessibilityLink(
    request: AndroidActivateAccessibilityLinkRequest,
  ): Promise<A11yActionResult>;

  /** Perform a semantic or custom accessibility action on a node (#14077). */
  requestAccessibilityAction(request: AndroidAccessibilityActionRequest): Promise<A11yActionResult>;

  supportsAccessibilityLinkActivation(perf?: PerformanceTracker): Promise<boolean>;

  requestClipboard(
    action: "copy" | "paste" | "clear" | "get",
    text?: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<A11yClipboardResult>;

  requestSettingsGet(
    namespace: SettingsNamespace,
    key: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<A11ySettingsGetResult>;

  requestSettingsPut(
    namespace: SettingsNamespace,
    key: string,
    value: string | null,
    valueType?: SettingsValueType,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<A11ySettingsPutResult>;

  requestSettingsList(
    namespace: SettingsNamespace,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<A11ySettingsListResult>;

  requestInstallCaCertificate(
    certificate: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<A11yCaCertResult>;

  requestInstallCaCertificateFromFile(
    certificatePath: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<A11yCaCertResult>;

  requestRemoveCaCertificate(
    alias: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<A11yCaCertResult>;

  requestDeviceOwnerStatus(
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<A11yDeviceOwnerStatusResult>;

  requestPermission(
    permission: string,
    requestPermission?: boolean,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<A11yPermissionResult>;

  requestShowPrototype(
    spec: PrototypeSpec,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    displayId?: number,
    reset?: boolean,
    appearance?: PrototypeAppearanceOverride | PrototypeShowOverrides,
  ): Promise<PrototypeResult>;
  requestDismissPrototype(
    target: PrototypeDismiss,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<PrototypeResult>;
  requestPatchPrototype(
    patch: PrototypePatchRequest,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<PrototypePatchReply>;
  requestSavePrototype(
    save: { spec: PrototypeSpec; label: string; icon?: string },
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<PrototypeResult>;
  requestPinSavedPrototype(
    id: string,
    icon?: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<PrototypeResult>;
  requestListSavedPrototypes(
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<PrototypeResult>;
  requestDeleteSavedPrototype(
    id: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<PrototypeResult>;
  requestAdvancePrototypeClock(
    id: string,
    advanceTimeMs: number,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<PrototypeResult>;
  requestClearPrototypeStorage(
    id: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<PrototypeResult>;
  requestInspectPrototypes(timeoutMs?: number, perf?: PerformanceTracker): Promise<PrototypeResult>;
  requestPutPrototypeAsset(
    asset: PrototypeAssetUpload,
    options?: PrototypeAssetRequestOptions,
  ): Promise<PrototypeAssetResult>;
  requestRemovePrototypeAsset(
    id: string,
    options?: PrototypeAssetRequestOptions,
  ): Promise<PrototypeAssetResult>;
  onPrototypeEvent(listener: (event: PrototypeEvent) => void): () => void;

  requestAddHighlight(
    id: string,
    shape: HighlightShape,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<HighlightOperationResult>;

  requestScreenshot(
    timeoutMs?: number,
    perf?: PerformanceTracker,
    suppressObservationStreamPush?: boolean,
    signal?: AbortSignal,
    displayId?: number,
    hidePrototypes?: boolean,
  ): Promise<ScreenshotResult>;

  requestScreenshotWithoutObservationStreamPush(
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<ScreenshotResult>;

  requestInstalledPackages(
    includeSystem?: boolean,
    userId?: number,
    timeoutMs?: number,
  ): Promise<A11yInstalledPackagesResult>;

  requestPackageInfo(
    packageName: string,
    options?: PackageInfoOptions,
    timeoutMs?: number,
  ): Promise<A11yPackageInfoResult>;

  requestLaunchIntent(packageName: string, timeoutMs?: number): Promise<A11yLaunchIntentResult>;
}

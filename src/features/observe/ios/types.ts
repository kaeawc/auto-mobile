/**
 * Shared types for CtrlProxyClient delegates.
 *
 * This module defines the context interfaces that delegates receive to access
 * shared state and functionality from the main CtrlProxyClient.
 */

import type { SemanticLink, ViewHierarchyWindowInfo } from "../../../models";
import type { ObservationInsets } from "../../../models/ObservationInsets";
import type { CtrlProxyReconnectStatus } from "../../../models/CtrlProxyReconnectStatus";
import type { IosHierarchyUnavailableReason } from "../../../models/ViewHierarchyResult";
import type { HighlightOperationResult } from "../../../models";
import type {
  PerfTiming,
  BaseResult,
  GestureTimingResult,
  ActionTimingResult,
  DelegateContext,
} from "../shared/types";

// Re-export shared types so existing imports from "./types" continue to work
export type { DelegateContext } from "../shared/types";

/**
 * Interface for iOS accessibility node format (matching Android format)
 */
export interface CtrlProxyNode {
  text?: string;
  /**
   * Entered/current value of a text-input element (UITextField, UITextView,
   * UISearchBar, UISecureTextField). Distinct from `text` — which carries the
   * accessibility label (often the placeholder for these elements). Password
   * fields are masked as bullet characters before serialization.
   */
  value?: string;
  textSize?: number;
  contentDesc?: string;
  resourceId?: string;
  viewId?: string;
  className?: string;
  bounds?: {
    left: number;
    top: number;
    right: number;
    bottom: number;
  };
  clickable?: string;
  enabled?: string;
  focusable?: string;
  focused?: string;
  accessibilityFocused?: string;
  scrollable?: string;
  password?: string;
  checkable?: string;
  checked?: string;
  selected?: string;
  longClickable?: string;
  semanticLinks?: SemanticLink[];
  "semantic-links"?: SemanticLink[];
  testTag?: string;
  role?: string;
  stateDescription?: string;
  errorMessage?: string;
  hintText?: string;
  actions?: string[];
  extras?: Record<string, string>;
  node?: CtrlProxyNode | CtrlProxyNode[];
}

/**
 * Interface for iOS view hierarchy (matching Android format)
 */
export interface XCTestHierarchy {
  /** Daemon sequence assigned when this capture was forwarded to the observation stream. */
  captureSequence?: number;
  updatedAt: number;
  packageName: string;
  /** Runner could not identify the foreground app and guessed SpringBoard instead. */
  fallbackToSpringboard?: boolean;
  hierarchy: CtrlProxyNode;
  windows?: ViewHierarchyWindowInfo[];
  /** iOS screen scale factor (e.g., 2.0 for @2x, 3.0 for @3x retina) */
  screenScale?: number;
  /** Screen width in iOS points (logical pixels) */
  screenWidth?: number;
  /** Screen height in iOS points (logical pixels) */
  screenHeight?: number;
  /**
   * `UIScreen.nativeScale` — the point->screenshot-pixel ratio (#4548, additive; absent from
   * pre-#4548 runners). Distinct from `screenScale` (`UIScreen.scale`) under Display Zoom.
   */
  nativeScale?: number;
  /** Physical screenshot pixel width: round(screenWidth * nativeScale) (#4548, additive). */
  pixelWidth?: number;
  /** Physical screenshot pixel height: round(screenHeight * nativeScale) (#4548, additive). */
  pixelHeight?: number;
  /** Device display rotation captured with the hierarchy: Android-compatible 0..3. */
  rotation?: number;
  systemInsets?: { top: number; right: number; bottom: number; left: number };
  insets?: ObservationInsets;
  truncationReasons?: string[];
  error?: string;
}

export type CtrlProxyHierarchyShape = XCTestHierarchy;
export type CtrlProxyHierarchy = XCTestHierarchy;

/**
 * iOS-side performance timing data.
 * Alias for shared PerfTiming type.
 */
export type CtrlProxyPerfTiming = PerfTiming;

/**
 * Interface for iOS performance snapshot from CADisplayLink FPS monitoring
 */
export interface CtrlProxyPerformanceSnapshot {
  timestamp: number;
  fps?: number;
  frameTimeMs?: number;
  jankFrames?: number;
  touchLatencyMs?: number;
  ttffMs?: number;
  ttiMs?: number;
  cpuUsagePercent?: number;
  memoryUsageMb?: number;
  screenName?: string;
}

/**
 * Interface for WebSocket message from CtrlProxy iOS
 */
export interface WebSocketMessage {
  type: string;
  timestamp?: number;
  requestId?: string;
  id?: number;
  supportedCommands?: string[];
  supportedFeatures?: string[];
  handled?: boolean;
  unsupported?: boolean;
  requiresVoiceOver?: boolean;
  available?: boolean;
  /** sdk_trigger_result: the SDK's HTTP status and structured error fields. */
  statusCode?: number;
  sdkError?: string;
  reason?: string;
  registeredModules?: string[];
  supportedTriggers?: string[];
  bundleId?: string;
  capabilities?: string[];
  data?: XCTestHierarchy;
  /** True when a hierarchy response contains a previous runner capture. */
  servedFromCache?: boolean;
  performanceData?: CtrlProxyPerformanceSnapshot;
  format?: string;
  rotation?: number;
  success?: boolean;
  verified?: boolean;
  warning?: string;
  ok?: boolean;
  open?: boolean;
  method?: "escape" | "dismissKey" | "returnKey";
  totalTimeMs?: number;
  error?: string;
  /** Additive typed companion to `error` (see `runnerErrorCodes.ts`); older runners omit it. */
  errorCode?: string;
  /** Typed runner_busy metadata for a command rejected before entering the serial queue. */
  blockingCommandType?: string;
  blockingElapsedMs?: number;
  /** Signed milliseconds to the blocking command's deadline; negative means overdue. */
  blockingDeadlineRemainingMs?: number;
  perfTiming?: CtrlProxyPerfTiming | CtrlProxyPerfTiming[];
  tapDiagnostics?: CtrlProxyTapDiagnostics;
  previousOrientation?: string;
  currentOrientation?: string;
  value?: number;
  angle?: number;
  rotationPerformed?: boolean;
  // Pinch-only: which mechanism performed the gesture — "event-path" (private
  // synthesis, honors center) or "element-anchored" (public fallback, center-less).
  // See issue #2910.
  pinchPath?: string;
  /** Opaque device-authored identity for the hierarchy/pixels in this message. */
  frameContext?: string;
}

/**
 * Interface for screenshot result
 */
export interface CtrlProxyScreenshotResult {
  success: boolean;
  data?: string; // Base64 encoded PNG
  format?: string;
  timestamp?: number;
  rotation?: number;
  error?: string;
  frameContext?: string;
  /** Present when the request asked to hide prototypes: true when the image excludes them (#9305). */
  prototypesHidden?: boolean;
}

/** Swipe result from CtrlProxy iOS */
export type CtrlProxySwipeResult = GestureTimingResult;

/** Tap coordinates result */
export type CtrlProxyTapResult = BaseResult & {
  tapDiagnostics?: CtrlProxyTapDiagnostics;
  /** Host-side dispatch metadata, as on presses: written to the socket / answered by the runner. */
  dispatched?: boolean;
  acknowledged?: boolean;
};

/** Optional, best-effort runner readings; these are resolved locations, not delivered touches. */
export interface CtrlProxyTapDiagnostics {
  requested?: {
    x?: number;
    y?: number;
    durationMs?: number;
    mode?: string;
    coordinateConstruction?: string;
    units?: string;
  };
  baseScreenPoint?: { x?: number; y?: number };
  resolvedScreenPoint?: { x?: number; y?: number };
  application?: {
    bundleIdentifier?: string;
    frame?: TapDiagnosticFrame;
    windowFrames?: TapDiagnosticFrame[];
  };
  screen?: {
    bounds?: TapDiagnosticFrame;
    nativeBounds?: TapDiagnosticFrame;
    scale?: number;
    nativeScale?: number;
    source?: string;
  };
  orientation?: {
    device?: TapDiagnosticOrientation;
    interface?: TapDiagnosticOrientation;
  };
  sampleErrors?: string[];
  strategy?:
    | "legacy"
    | "appRelative"
    | "appRelativeObserved"
    | "displayTargeted"
    | "displayTargetedObserved";
  route?: "xcuiCoordinate" | "displayTargetedRecord";
  targetDisplayId?: number;
  targetDisplayReason?: string;
  deviceIdiom?: string;
  mainDisplayId?: number;
  applicationDisplayId?: number;
  screens?: { displayId: number; isMain: boolean }[];
  synthesizedPoint?: { x: number; y: number };
  synthesizedInterfaceOrientation?: number;
  fallbackFrom?: string;
  deliveryWarning?: "eventDisplayMismatch";
  strategyReason?: string;
  normalizedOffset?: { x?: number; y?: number };
}

interface TapDiagnosticFrame {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

interface TapDiagnosticOrientation {
  rawValue?: number;
  value?: string;
  source?: string;
  fallback?: string;
}

/** Drag result from CtrlProxy iOS */
export type CtrlProxyDragResult = GestureTimingResult;

/** Pinch result from CtrlProxy iOS */
export type CtrlProxyPinchResult = GestureTimingResult;

/** Set text result from CtrlProxy iOS */
export type CtrlProxySetTextResult = BaseResult;

/** IME action result from CtrlProxy iOS */
export type CtrlProxyImeActionResult = ActionTimingResult;

/** Select all result from CtrlProxy iOS */
export type CtrlProxySelectAllResult = BaseResult;

/** Keyboard action result from CtrlProxy iOS */
export interface CtrlProxyKeyboardResult extends BaseResult {
  open: boolean;
  method?: "escape" | "dismissKey" | "returnKey";
}

/** Discrete keyboard key result from CtrlProxy iOS */
export interface CtrlProxyPressKeyResult extends BaseResult {
  verified?: boolean;
  warning?: string;
  /** iOS runner's typed failure code (`runnerErrorCodes.ts`); absent from older runners. */
  errorCode?: string;
}

/** Press home result from CtrlProxy iOS */
export type CtrlProxyPressHomeResult = BaseResult;

/** Press back result from CtrlProxy iOS */
export type CtrlProxyPressBackResult = BaseResult;

/** Shake result from CtrlProxy iOS */
export type CtrlProxyShakeResult = BaseResult;

/** Generic press button result from CtrlProxy iOS */
export type CtrlProxyPressButtonResult = BaseResult;

/** Rotate result from CtrlProxy iOS */
export interface CtrlProxyRotateResult extends BaseResult {
  previousOrientation: string;
  currentOrientation: string;
  value: number;
  rotationPerformed: boolean;
}

/** Hinge angle result from CtrlProxy iOS */
export interface CtrlProxyHingeAngleResult {
  success: boolean;
  angle?: number;
  error?: string;
  totalTimeMs: number;
}

/** Launch app result from CtrlProxy iOS */
export type CtrlProxyLaunchAppResult = BaseResult;

/** Reset-privacy-permissions result from CtrlProxy iOS (physical devices, issue #2491) */
export type CtrlProxyResetPermissionsResult = BaseResult;

/** Recent apps result from CtrlProxy iOS */
export type CtrlProxyRecentAppsResult = BaseResult;

/** Clipboard result from CtrlProxy iOS */
export interface CtrlProxyClipboardResult {
  success: boolean;
  action: string;
  text?: string;
  totalTimeMs: number;
  error?: string;
}

/** Action result from CtrlProxy iOS */
export interface CtrlProxyActionResult {
  success: boolean;
  action?: string;
  totalTimeMs?: number;
  error?: string;
  /** Runner note on a successful action, e.g. a semantic link tap that chose the first of several candidate owners. */
  warning?: string;
  /** Host-side dispatch/confirmation metadata; absent for other action helpers. */
  dispatched?: boolean;
  acknowledged?: boolean;
  retryable?: boolean;
}

/** VoiceOver state result from CtrlProxy iOS */
export interface CtrlProxyVoiceOverResult {
  success: boolean;
  enabled: boolean;
  totalTimeMs?: number;
  error?: string;
}

/** Highlight result from CtrlProxy iOS */
export type CtrlProxyHighlightResult = HighlightOperationResult;

/**
 * Interface for cached hierarchy with metadata
 */
export interface CtrlProxyCachedHierarchy {
  hierarchy: XCTestHierarchy;
  receivedAt: number;
  /**
   * Host clock when this exact device capture was first seen. Unlike
   * `receivedAt`, this is retained when the runner re-delivers the same
   * `updatedAt`, so a repeated push cannot make old content look newly captured.
   * An explicitly cached runner reply also bounds this by its real `updatedAt`
   * and stays unverified (`fresh: false`), regardless of clock skew.
   */
  captureReceivedAt?: number;
  fresh: boolean;
  perfTiming?: CtrlProxyPerfTiming;
  frameContext?: string;
}

export type CachedHierarchy = CtrlProxyCachedHierarchy;

/**
 * Interface for hierarchy response with freshness indicator
 */
// Enumerable symbols survive internal shallow projections but never serialize to JSON.
export const iosHierarchyAcquisition = Symbol("iosHierarchyAcquisition");

export interface IosHierarchyAcquisition {
  [iosHierarchyAcquisition]?: "device" | "client-cache";
}

/** A successful synchronous runner response; provenance stays on the host envelope. */
export interface CtrlProxySyncedHierarchy extends IosHierarchyAcquisition {
  hierarchy: XCTestHierarchy;
  /** False for a runner cache answer that has not re-verified the current screen. */
  fresh?: boolean;
  perfTiming?: CtrlProxyPerfTiming;
  frameContext?: string;
}

export interface CtrlProxyHierarchyResponse extends IosHierarchyAcquisition {
  hierarchy: XCTestHierarchy | null;
  fresh: boolean;
  updatedAt?: number;
  perfTiming?: CtrlProxyPerfTiming;
  frameContext?: string;
  reconnectStatus?: CtrlProxyReconnectStatus;
  reconnectMessage?: string;
  unavailableReason?: IosHierarchyUnavailableReason;
  unavailableDetail?: string;
}

/**
 * Extended context for hierarchy delegate with additional state access.
 */
export interface HierarchyDelegateContext extends DelegateContext {
  /** Device identity for per-device hierarchy diagnostics. */
  getDeviceId?(): string;
  markObserverHierarchyRequest?(requestId: string): void;
  unmarkObserverHierarchyRequest?(requestId: string): void;
  getLastConnectFailure?(): { reason: IosHierarchyUnavailableReason; detail?: string } | undefined;
  /** Cache freshness TTL in milliseconds */
  cacheFreshTtlMs: number;
  /** Get the cached hierarchy data */
  getCachedHierarchy(): CtrlProxyCachedHierarchy | null;
  /** Set the cached hierarchy data */
  setCachedHierarchy(h: CtrlProxyCachedHierarchy | null): void;
  /** Prevent the response for this request from being forwarded to the observation stream. */
  suppressHierarchyObservationStreamPush?(requestId: string, timeoutMs: number): void;
}

/**
 * Result of relaying a host trigger to the foreground app's in-app SDK `POST /trigger`
 * route (#1580). `available: false` means the app does not embed the SDK (or the runner
 * predates the command); `sdkError` carries the SDK's structured error when it answered.
 */
export interface CtrlProxySdkTriggerResult extends BaseResult {
  available: boolean;
  /** True when the runner does not know `request_sdk_trigger` (older runner build). */
  unsupported?: boolean;
  statusCode?: number;
  sdkError?: string;
  reason?: string;
  registeredModules?: string[];
  supportedTriggers?: string[];
}

/** Direct SDK responder call; no VoiceOver gesture or enabled-state requirement. */
export interface CtrlProxyMagicTapResult extends BaseResult {
  /** Undefined if the runner could not reply; false means SDK support is absent. */
  available?: boolean;
  handled?: boolean;
  unsupported: boolean;
  requiresVoiceOver: false;
}

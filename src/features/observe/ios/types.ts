/**
 * Shared types for CtrlProxyClient delegates.
 *
 * This module defines the context interfaces that delegates receive to access
 * shared state and functionality from the main CtrlProxyClient.
 */

import type { SemanticLink, ViewHierarchyWindowInfo } from "../../../models";
import type { ObservationInsets } from "../../../models/ObservationInsets";
import type { CtrlProxyReconnectStatus } from "../../../models/CtrlProxyReconnectStatus";
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
  updatedAt: number;
  packageName: string;
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
  data?: XCTestHierarchy;
  performanceData?: CtrlProxyPerformanceSnapshot;
  format?: string;
  rotation?: number;
  success?: boolean;
  ok?: boolean;
  open?: boolean;
  totalTimeMs?: number;
  error?: string;
  perfTiming?: CtrlProxyPerfTiming | CtrlProxyPerfTiming[];
  previousOrientation?: string;
  currentOrientation?: string;
  value?: number;
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
}

/** Swipe result from CtrlProxy iOS */
export type CtrlProxySwipeResult = GestureTimingResult;

/** Tap coordinates result */
export type CtrlProxyTapResult = BaseResult;

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
}

/** Discrete keyboard key result from CtrlProxy iOS */
export type CtrlProxyPressKeyResult = BaseResult;

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
export interface CtrlProxyHierarchyResponse {
  hierarchy: XCTestHierarchy | null;
  fresh: boolean;
  updatedAt?: number;
  perfTiming?: CtrlProxyPerfTiming;
  frameContext?: string;
  reconnectStatus?: CtrlProxyReconnectStatus;
  reconnectMessage?: string;
}

/**
 * Extended context for hierarchy delegate with additional state access.
 */
export interface HierarchyDelegateContext extends DelegateContext {
  /** Cache freshness TTL in milliseconds */
  cacheFreshTtlMs: number;
  /** Get the cached hierarchy data */
  getCachedHierarchy(): CtrlProxyCachedHierarchy | null;
  /** Set the cached hierarchy data */
  setCachedHierarchy(h: CtrlProxyCachedHierarchy | null): void;
  /** Prevent the response for this request from being forwarded to the observation stream. */
  suppressHierarchyObservationStreamPush?(requestId: string, timeoutMs: number): void;
}

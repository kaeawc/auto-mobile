/**
 * iOS CtrlProxy Module
 *
 * This module provides access to iOS CtrlProxy functionality
 * for UI automation, hierarchy inspection, and device interaction.
 */

// Main client
export { IOSCtrlProxyClient } from "./IOSCtrlProxyClient";
export type { IOSCtrlProxy } from "./IOSCtrlProxyClient";

// Delegate modules (for advanced usage)
export { CtrlProxyGestures } from "./CtrlProxyGestures";
export { CtrlProxyText } from "./CtrlProxyText";
export { CtrlProxyHierarchy } from "./CtrlProxyHierarchy";
export { CtrlProxyScreenshot } from "./CtrlProxyScreenshot";
export { CtrlProxyNavigation } from "./CtrlProxyNavigation";
export { CtrlProxyClipboard } from "./CtrlProxyClipboard";
export { CtrlProxyStorage } from "./CtrlProxyStorage";
export { CtrlProxyKeyboard } from "./CtrlProxyKeyboard";
export { CtrlProxyHighlights } from "./CtrlProxyHighlights";
export { CtrlProxyDatabase } from "./CtrlProxyDatabase";

// Types
export type {
  // Node and hierarchy types
  CtrlProxyNode,
  XCTestHierarchy,
  CtrlProxyHierarchyShape,
  CtrlProxyHierarchyResponse,
  CtrlProxyPerfTiming,
  CtrlProxyCachedHierarchy,
  WebSocketMessage,

  // Result types
  CtrlProxyScreenshotResult,
  CtrlProxySwipeResult,
  CtrlProxyTapResult,
  CtrlProxyDragResult,
  CtrlProxyPinchResult,
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
  CtrlProxyActionResult,
  CtrlProxyHighlightResult,

  // Delegate context types
  DelegateContext,
  HierarchyDelegateContext,
} from "./types";

// Shared types
export type {
  PerfTiming,
  BaseResult,
  GestureTimingResult,
  ActionTimingResult,
} from "../shared/types";

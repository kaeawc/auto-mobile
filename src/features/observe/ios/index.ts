/**
 * iOS CtrlProxy Module
 *
 * This module provides access to iOS CtrlProxy functionality
 * for UI automation, hierarchy inspection, and device interaction.
 */

// Main client
export { IOSCtrlProxyClient } from "./IOSCtrlProxyClient";
export type {
  IosCtrlProxy,
  IosMockRuleSyncOutcome,
  IosMockRuleSyncResult,
} from "./IOSCtrlProxyClient";

// Delegate modules
export { CtrlProxyHierarchy } from "./CtrlProxyHierarchy";

// Types
export type {
  CtrlProxyHierarchyResponse,
  CtrlProxyPerfTiming,

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
} from "./types";

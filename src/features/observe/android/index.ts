/**
 * CtrlProxy Module
 *
 * This module provides access to Android CtrlProxy functionality
 * for UI automation, hierarchy inspection, and device interaction.
 */

// Main client
export { AndroidCtrlProxyClient } from "./AndroidCtrlProxyClient";
export type { AndroidCtrlProxy } from "./AndroidCtrlProxyClient";
export type { ViewHierarchyAndroidCtrlProxy } from "./ViewHierarchyAndroidCtrlProxy";

// Types
export type {
  // Result types
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
  SettingsNamespace,
  AndroidPerfTiming,
  AccessibilityNodeSelector,
} from "./types";

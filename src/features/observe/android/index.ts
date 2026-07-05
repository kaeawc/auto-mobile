/**
 * CtrlProxy Module
 *
 * This module provides access to Android CtrlProxy functionality
 * for UI automation, hierarchy inspection, and device interaction.
 */

// Main client
export { AndroidCtrlProxyClient } from "./AndroidCtrlProxyClient";
export type { AndroidCtrlProxy, InteractionEvent } from "./AndroidCtrlProxyClient";

// Delegate modules (for advanced usage)
export { CtrlProxyGestures } from "./CtrlProxyGestures";
export { CtrlProxyText } from "./CtrlProxyText";
export { CtrlProxyHierarchy } from "./CtrlProxyHierarchy";
export { CtrlProxyStorage } from "./CtrlProxyStorage";
export { CtrlProxyCertificates } from "./CtrlProxyCertificates";
export { CtrlProxyFocus } from "./CtrlProxyFocus";
export { CtrlProxyHighlights } from "./CtrlProxyHighlights";

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
  A11yClipboardResult,
  A11yCaCertResult,
  A11yDeviceOwnerStatusResult,
  A11yPermissionResult,
  A11ySettingsGetResult,
  A11ySettingsPutResult,
  A11ySettingsListResult,
  SettingsNamespace,
  SettingsValueType,
  AndroidPerfTiming,

  // Internal types (for delegate usage)
  DelegateContext,
  HierarchyDelegateContext,
  CertificatesDelegateContext,
  AccessibilityNode,
  CachedHierarchy,
  NormalizedHighlightBounds,
} from "./types";

// Shared types
export type {
  PerfTiming,
  BaseResult,
  GestureTimingResult,
  ActionTimingResult,
} from "../shared/types";

// Utility functions
export { generateSecureId, quoteForAdbArg } from "./types";

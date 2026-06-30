import { ElementBounds } from "./ElementBounds";
import { RecompositionMetrics, RecompositionNodeInfo } from "./Recomposition";
import type { CtrlProxyReconnectStatus } from "./CtrlProxyReconnectStatus";

/**
 * Hierarchy data sources that contributed to the result
 */
export type HierarchySource = "control-proxy" | "uiautomator";

/**
 * Represents the ViewHierarchy dump result from a device.
 */
export interface ViewHierarchyResult {
  hierarchy: Hierarchy;
  /** Timestamp from the device when the hierarchy was captured (milliseconds since epoch) */
  updatedAt?: number;
  /** Package name of the foreground app (from accessibility service) */
  packageName?: string;
  /** Optional window metadata from the accessibility service */
  windows?: ViewHierarchyWindowInfo[];
  /** Regions where platform accessibility APIs likely hide rendered content. */
  contentHiddenRegions?: ContentHiddenRegion[];
  /** Whether an intent chooser dialog was detected (from accessibility service) */
  intentChooserDetected?: boolean;
  /** Whether a notification permission dialog was detected (from accessibility service) */
  notificationPermissionDetected?: boolean;
  /** Element with TalkBack/accessibility cursor (Android only) */
  "accessibility-focused-element"?: ViewHierarchyNode;
  /**
   * True when CtrlProxy couldn't fully extract the hierarchy.
   * This indicates that uiautomator fallback may have been used.
   */
  ctrlProxyIncomplete?: boolean;
  /**
   * Sources that contributed to this hierarchy result.
   * When both sources are present, the hierarchy was merged from accessibility service + uiautomator.
   */
  sources?: HierarchySource[];
  /** Screen width from accessibility service (eliminates need for dumpsys) */
  screenWidth?: number;
  /** Screen height from accessibility service (eliminates need for dumpsys) */
  screenHeight?: number;
  /** iOS screen scale factor (e.g., 2.0 for @2x, 3.0 for @3x retina). Converts points to pixels. */
  screenScale?: number;
  /** Display rotation: 0=portrait, 1=landscape90, 2=reverse, 3=landscape270 */
  rotation?: number;
  /** System insets (status bar, nav bar, gesture insets) */
  systemInsets?: { top: number; bottom: number; left: number; right: number };
  /** Device wakefulness: "Awake", "Asleep", or "Dozing" (Android only, from accessibility service) */
  wakefulness?: "Awake" | "Asleep" | "Dozing";
  /** Foreground activity component name, e.g. "com.example.app/.MainActivity" (Android only) */
  foregroundActivity?: string;
  /** Display density in DPI (Android only, from accessibility service) */
  density?: number;
  /** Android API level (Android only, from accessibility service) */
  sdkInt?: number;
  /** Device model (Android only, from accessibility service) */
  deviceModel?: string;
  /** Whether running on an emulator (Android only, from accessibility service) */
  isEmulator?: boolean;
  /** Present when CtrlProxy is reconnecting and the hierarchy is temporarily unavailable. */
  ctrlProxyReconnect?: CtrlProxyReconnectStatus;
}

export interface ContentHiddenRegion {
  bounds: ElementBounds;
  reason: "compose-interop-no-hide-descendants" | string;
  areaPercent: number;
}

export interface Hierarchy {
  error?: string;
  node?: ViewHierarchyNode;
  /** iOS root XCTestNode bounds (points): {left, top, right, bottom} */
  bounds?: { left?: number; top?: number; right: number; bottom: number };
}

export interface ViewHierarchyWindowInfo {
  id?: number;
  type?: number;
  isActive?: boolean;
  isFocused?: boolean;
  bounds?: ElementBounds;
  windowLayer?: number;
  packageName?: string;
  hierarchy?: ViewHierarchyNode;
}

// Define types for the view hierarchy structure
export interface NodeAttributes {
  [key: string]: unknown;
}

export interface ViewHierarchyNode {
  $: NodeAttributes;
  node?: ViewHierarchyNode[];
  bounds?: ElementBounds;
  recomposition?: RecompositionNodeInfo;
  recompositionMetrics?: RecompositionMetrics;
  occlusionState?: string;
  occludedBy?: string;
  "test-tag"?: string;
  "view-id"?: string;
  extras?: Record<string, string>;
}

import { ElementBounds } from "./ElementBounds";
import { RecompositionMetrics, RecompositionNodeInfo } from "./Recomposition";
import type { CtrlProxyReconnectStatus } from "./CtrlProxyReconnectStatus";
import type { ObservationInsets } from "./ObservationInsets";

/**
 * Hierarchy data sources that contributed to the result
 */
export type HierarchySource = "control-proxy" | "uiautomator";

/**
 * Why CtrlProxy marked a capture incomplete (`ctrlProxyIncomplete`). The single
 * boolean flag is emitted for several distinct causes (issue #6184), and the
 * recovery advice differs by cause — only a genuinely null (withheld) focused
 * root is recoverable by an `isAccessibilityTool` build:
 *
 * - `null_root` — the focused application window's root node was null: the
 *   framework withheld it (transient, app-restricted, or — on Android 14+ —
 *   accessibility-data-sensitive). This is the ONLY case the "no root /
 *   isAccessibilityTool" diagnosis applies to.
 * - `discarded_windows` — the window(s) had a non-null root, but every extracted
 *   node was discarded as zero-area or entirely offscreen, leaving the capture
 *   empty. Not a withheld root; an `isAccessibilityTool` build does not recover it.
 * - `extraction_error` — extraction threw before any window could be assembled.
 *   Not a withheld root; retrying is the recovery, not an `isAccessibilityTool` build.
 *
 * Additive and optional: pre-#6172 runners send only `ctrlProxyIncomplete` with
 * no reason, so consumers must treat an absent reason as the historical
 * (`null_root`) default to preserve behavior.
 */
export type CtrlProxyIncompleteReason = "null_root" | "discarded_windows" | "extraction_error";

/**
 * Represents the ViewHierarchy dump result from a device.
 */
export interface ViewHierarchyResult {
  hierarchy: Hierarchy;
  /** Timestamp from the device when the hierarchy was captured (milliseconds since epoch) */
  updatedAt?: number;
  /**
   * Host-clock-domain timestamp (ms since epoch) for when the host took delivery
   * of this tree — a fresh sync's receipt time, or a cache entry's original
   * receipt time. Used to measure observation age without crossing clock domains:
   * `updatedAt` is device-authored, so on a skewed emulator `hostNow - updatedAt`
   * misreports clock skew as age (issue #5377). Absent on iOS, which shares the
   * host clock, and on any source that does not track receipt time.
   */
  receivedAt?: number;
  /** Opaque device-authored identity for the UI state captured in this hierarchy. */
  frameContext?: string;
  /**
   * Whether this tree was verified against the device on the call that produced
   * it, as opposed to being served from a host-side cache unverified.
   *
   * The delegates have always computed this (`CtrlProxyHierarchyResponse.fresh`)
   * and then discarded it at this boundary, which is how a cached tree could
   * reach `ObserveScreen` indistinguishable from a freshly fetched one. Optional
   * because not every source can report it.
   */
  fresh?: boolean;
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
   * The specific cause behind {@link ctrlProxyIncomplete} (issue #6184), used to
   * emit cause-appropriate recovery advice instead of always claiming a null
   * (withheld) focused root. Absent on pre-#6172 runners — treat as `null_root`.
   */
  ctrlProxyIncompleteReason?: CtrlProxyIncompleteReason;
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
  /**
   * Ratio between this hierarchy's bounds units and physical screenshot pixels (#4548, additive —
   * absent from pre-#4548 runners). iOS reports `UIScreen.nativeScale` (NOT `scale`: Display Zoom
   * makes them differ, and screenshots render at native scale); Android bounds are already
   * physical pixels, so it reports exactly 1. Retained for #4549's canonical-pixel conversion —
   * NOT consumed by any current behavior.
   */
  nativeScale?: number;
  /** Physical screenshot pixel width reported by the runner (#4548, additive). */
  pixelWidth?: number;
  /** Physical screenshot pixel height reported by the runner (#4548, additive). */
  pixelHeight?: number;
  /** Display rotation: 0=portrait, 1=landscape90, 2=reverse, 3=landscape270 */
  rotation?: number;
  /** System insets (status bar, nav bar, gesture insets) */
  systemInsets?: { top: number; bottom: number; left: number; right: number };
  /** Typed inset metadata captured alongside this hierarchy. */
  insets?: ObservationInsets;
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
  /** Structured reasons why this Android snapshot is partial or unavailable. */
  truncationReasons?: string[];
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
  /**
   * Element bounds in the platform's coordinate space: integer pixels on
   * Android (accessibility-service `Rect`s), XCUITest points on iOS — which are
   * legitimately fractional (retina point→pixel, sub-point layout). Consumers
   * and wire schemas must treat these as plain numbers, never assume integers
   * (issue #3206; see `boundsObjectSchema` in `src/server/toolOutputSchemas.ts`).
   */
  bounds?: ElementBounds;
  recomposition?: RecompositionNodeInfo;
  recompositionMetrics?: RecompositionMetrics;
  occlusionState?: string;
  occludedBy?: string;
  occludedByViewId?: string;
  "test-tag"?: string;
  "view-id"?: string;
  extras?: Record<string, string>;
}

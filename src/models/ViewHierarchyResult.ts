import { ElementBounds } from "./ElementBounds";
import { RecompositionMetrics, RecompositionNodeInfo } from "./Recomposition";
import type { CtrlProxyReconnectStatus } from "./CtrlProxyReconnectStatus";
import type { ObservationInsets } from "./ObservationInsets";

/**
 * Hierarchy data sources that contributed to the result
 */
export type HierarchySource = "control-proxy" | "uiautomator";

/**
 * Why CtrlProxy marked a capture incomplete (`ctrlProxyIncomplete`).
 *
 * - `active_window_null_root` — the active window's root was null.
 * - `app_window_null_root` — the selected application window's root was null.
 * - `no_app_window_root` — no accessible application window root existed and
 *   SystemUI was not in the foreground.
 * When causes overlap, Android emits the active-window cause first, then the
 * selected-app cause, then the no-app-window cause. These three retain the
 * historical null-root recovery guidance (transient or restricted accessibility,
 * including Android 14+ accessibility-data-sensitive content).
 * - `null_root` — the legacy generic withheld-root reason.
 * - `discarded_windows` — non-null roots were discarded as zero-area or entirely
 *   offscreen. An `isAccessibilityTool` build does not recover these nodes.
 * - `extraction_error` — extraction threw before any window could be assembled;
 *   retrying is the recovery, not an `isAccessibilityTool` build.
 *
 * Additive and optional: older runners send only `ctrlProxyIncomplete` with no
 * reason. Consumers treat an absent reason as the historical (`null_root`)
 * default to preserve behavior.
 */
export type CtrlProxyIncompleteReason =
  | "null_root"
  | "discarded_windows"
  | "extraction_error"
  | "active_window_null_root"
  | "app_window_null_root"
  | "no_app_window_root";

/**
 * Represents the ViewHierarchy dump result from a device.
 */
export interface ViewHierarchyResult {
  /** Internal capture metadata, promoted to the observation result for device reads. */
  hierarchyServiceStarted?: boolean;
  displayId?: number | null;
  panelUniqueId?: string | null;
  /** Daemon-assigned sequence if this exact hierarchy was forwarded to the observation stream. */
  captureSequence?: number;
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
  /** Internal iOS diagnostic: SpringBoard was used because foreground detection failed. */
  fallbackToSpringboard?: boolean;
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
  /**
   * Runner rotation only: 0 portrait, 1 landscapeLeft (device top left, counter-clockwise /
   * Android ROTATION_90), 2 portrait upside down, 3 landscapeRight (ROTATION_270).
   * iOS omits unknown/unstable orientation; size-derived observe rotation is never copied here
   * because screenshot crops require the runner's actual quarter-turn direction.
   */
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
  /**
   * Runtime `AccessibilityServiceInfo.isAccessibilityTool` of the bound CtrlProxy service (Android
   * only, #6233). Absent means unknown (API < 31, or a runner that predates the field).
   */
  accessibilityTool?: boolean;
  /** Structured reasons why this Android snapshot is partial or unavailable. */
  truncationReasons?: string[];
  /**
   * True only while an AutoMobile overlay exists but is hidden because the app it was shown over
   * is not in front (Android, #10261). Absent otherwise and from older APKs.
   */
  overlaySuspended?: boolean;
  /** Present when CtrlProxy is reconnecting and the hierarchy is temporarily unavailable. */
  ctrlProxyReconnect?: CtrlProxyReconnectStatus;
}

export interface ContentHiddenRegion {
  bounds: ElementBounds;
  reason: "compose-interop-no-hide-descendants" | string;
  areaPercent: number;
}

export type Hierarchy = {
  error?: string;
  /** Why an iOS CtrlProxy hierarchy could not be retrieved. */
  iosUnavailableReason?: IosHierarchyUnavailableReason;
  /** Platform-neutral reason for an unavailable hierarchy. */
  unavailableReason?: HierarchyUnavailableReason;
  unavailableDetail?: string;
  node?: ViewHierarchyNode;
  /** iOS root XCTestNode bounds (points): {left, top, right, bottom} */
  bounds?: { left?: number; top?: number; right: number; bottom: number };
  /**
   * True when {@link error} represents lost CtrlProxy connectivity/binding
   * (Android only) rather than an ordinary content error (e.g. screen off,
   * locked device, malformed capture). `HierarchyCollector` reads this typed
   * signal off the RESOLVED result to fire `onAvailabilityLost` — the
   * accessibility service swallows connection failures into a resolved
   * error-shaped `Hierarchy` rather than throwing, so a thrown error is not a
   * reliable primary detection point for this failure class (#7534).
   */
  transportFailure?: boolean;
};

export type IosHierarchyUnavailableReason =
  | "runner_not_running"
  | "runner_stalled"
  | "connection_lost"
  | "simulator_not_booted"
  | "request_timed_out"
  | "auto_setup_failed"
  | "service_recovering"
  | "unknown";

/** `unknown` covers older delegates that do not yet report a typed cause. */
export type HierarchyUnavailableReason =
  | IosHierarchyUnavailableReason
  | "device_locked"
  | "incomplete_capture"
  /** Android: automatic CtrlProxy recovery is exhausted or suspended; `unavailableDetail` has the last failure. */
  | "runner_unavailable";

export type OwnOverlayPlacement = "fullscreen" | "sheet" | "floating";

export interface ViewHierarchyWindowInfo {
  displayId?: number | null;
  panelUniqueId?: string | null;
  id?: number;
  type?: number;
  isActive?: boolean;
  isFocused?: boolean;
  bounds?: ElementBounds;
  windowLayer?: number;
  /**
   * Package of the window's own root node (Android CtrlProxy). Omitted by older
   * APKs and when the root reports none, so consumers must fall back to the
   * capture-level `packageName`.
   */
  packageName?: string;
  /**
   * Placement of CtrlProxy's own interactive overlay window, only on that window and only from an
   * APK advertising `overlay_window_metadata_v1`. It identifies the window (`ownOverlayWindows`);
   * placement and opacity do not change tappability, since the overlay is touchable within its
   * bounds whatever it paints (#10715).
   */
  overlayPlacement?: OwnOverlayPlacement;
  /**
   * Whether that overlay's rendered surface is fully opaque (window opacity 100 and an opaque
   * root or scrim). Absent when unknown or from an older APK.
   */
  overlayOpaque?: boolean;
  hierarchy?: ViewHierarchyNode;
  /** Per-window truncation attribution; absent from older runners and complete windows. */
  truncationReasons?: string[] | null;
}

// Define types for the view hierarchy structure
export interface NodeAttributes {
  [key: string]: unknown;
}

export type ViewHierarchyNode = {
  displayId?: number | null;
  panelUniqueId?: string | null;
  $?: NodeAttributes;
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
};

/** iOS CtrlProxy nests attributes in `$`; Android and cleaned iOS nodes are flat. */
export function nodeAttributes(node: { $?: NodeAttributes }): NodeAttributes {
  return node.$ ?? node;
}

/** Direct bounds take precedence when a converter also carries bounds in `$`. */
export function nodeBounds(node: ViewHierarchyNode): unknown {
  return node.bounds ?? nodeAttributes(node)["bounds"];
}

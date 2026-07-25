/** Insets expressed in the same coordinate space as an observation's screen and bounds. */
export interface ObservationEdgeInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface ObservationSystemBarsInsets {
  /** Areas currently occupied by visible system bars. */
  visible: ObservationEdgeInsets;
  /** Areas system bars may occupy even while temporarily hidden. */
  stable: ObservationEdgeInsets;
}

/**
 * Current system-chrome visibility for the foreground app window. It describes
 * presentation state only; edge-to-edge layout remains an independent choice.
 */
export interface ObservationSystemChrome {
  visibility: "visible" | "hidden" | "partial" | "unknown";
  statusBar: "visible" | "hidden" | "unknown";
  navigationBar?: "visible" | "hidden" | "unknown";
  /** iOS only: the top view controller's preference, not observed visibility. */
  homeIndicatorAutoHideRequested?: boolean;
  source: "android-window-insets" | "ios-status-bar-manager";
}

/**
 * Typed platform inset metadata. `systemInsets` remains the backwards-compatible
 * stable-system-bar alias used by existing gesture callers.
 */
export interface ObservationInsets {
  available: boolean;
  source: "android-window-metrics" | "android-resource-fallback" | "ios-sdk-safe-area" | "unavailable";
  units: "physical-pixels" | "points" | "unknown";
  systemBars?: ObservationSystemBarsInsets;
  displayCutout?: ObservationEdgeInsets;
  systemGestures?: ObservationEdgeInsets;
  mandatorySystemGestures?: ObservationEdgeInsets;
  tappableElement?: ObservationEdgeInsets;
  /** UIKit's window safe area, including device and container-bar obstructions. */
  safeArea?: ObservationEdgeInsets;
  systemChrome?: ObservationSystemChrome;
}

export interface LayoutWarning {
  type: "important-content-under-inset" | "interaction-in-system-gesture-region";
  severity: "warning" | "info";
  element: {
    viewId?: string;
    resourceId?: string;
    text?: string;
    contentDesc?: string;
    bounds: ObservationEdgeInsets;
  };
  categories: Array<"text" | "interaction">;
  insetTypes: Array<"systemBars" | "displayCutout" | "safeArea" | "systemGestures" | "mandatorySystemGestures">;
  sides: Array<"top" | "right" | "bottom" | "left">;
  /** Distance the element extends into each reported inset, in observation coordinate units. */
  overflowPx: Partial<Record<"top" | "right" | "bottom" | "left", number>>;
  /** Effective inset size for each reported side, in observation coordinate units. */
  insetPx: Partial<Record<"top" | "right" | "bottom" | "left", number>>;
  overlapPercent: number;
  confidence: "high" | "medium";
}

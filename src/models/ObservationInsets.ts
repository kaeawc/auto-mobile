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

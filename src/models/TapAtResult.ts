import { BaseActionResult } from "./BaseActionResult";
import type { TapEffect } from "./TapOnElementResult";

/** Result of a platform-native absolute coordinate tap. */
export interface TapAtResult extends BaseActionResult {
  /** Coordinates actually dispatched (Android physical pixels; iOS XCTest points). */
  x: number;
  y: number;
  /** XR screenshot input mapped to the selected app panel's display pixels. */
  xrPanel?: { packageName: string; taskId: number; displayX: number; displayY: number };
  /** XR caveat: coordinates assume the default panel pose; omitted off XR. */
  warning?: string;
  /** Gesture requested, including on a failed dispatch. */
  action?: "tap" | "longPress" | "doubleTap";
  /** iOS: observed screen change after a successful tap. */
  effect?: TapEffect;
  /** The route the runner reports, e.g. "xcuiCoordinate" / "displayTargetedRecord"; absent when unreported. */
  dispatchRoute?: string;
}

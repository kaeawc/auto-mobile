import type { HierarchyLayer } from "./HierarchyLayer";
import type { PointerOption } from "./PointerOption";

/** One vertex of a drag path. */
export interface DragPathPoint {
  x: number;
  y: number;
  /** Milliseconds spent moving from the previous point to this one (ignored on the first point). */
  durationMs?: number;
  /** Stylus pressure 0..1 at this point; needs `pointer`. */
  pressure?: number;
  /** Stylus tilt in radians at this point; needs `pointer`. */
  tilt?: number;
}

/** Drag a single finger along a polyline, optionally holding at the start and at the end. */
export interface DragPathOptions {
  /** At least two points, in `coordinateSpace` units. */
  points: DragPathPoint[];
  /** Press-and-hold at the first point before moving (covers long press then drag). */
  holdMs?: number;
  /** Keep the finger down at the last point before lifting. */
  releaseHoldMs?: number;
  coordinateSpace?: "absolute" | "normalized" | "percent";
  display?: string;
  snapshotId?: string;
  layer?: HierarchyLayer;
  /** Draw with a stylus instead of a finger (Android 12+, `stylus_input_v1`); never falls back to a finger. */
  pointer?: PointerOption;
}

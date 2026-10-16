import type { HierarchyLayer } from "./HierarchyLayer";

/** One vertex of a drag path. */
export interface DragPathPoint {
  x: number;
  y: number;
  /** Milliseconds spent moving from the previous point to this one (ignored on the first point). */
  durationMs?: number;
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
}

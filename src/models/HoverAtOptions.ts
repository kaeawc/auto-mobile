import type { HierarchyLayer } from "./HierarchyLayer";

/** One position of a hover path. */
export interface HoverAtPoint {
  x: number;
  y: number;
  /** Milliseconds spent moving from the previous point to this one (ignored on the first point). */
  durationMs?: number;
  /** Stylus hover distance from the surface, 0 (touching) to 1 (far); a mouse has none. */
  distance?: number;
}

/** Hover over a path with a stylus or a mouse and no contact: enter, move, exit (Android). */
export interface HoverAtOptions {
  /** At least one point, in `coordinateSpace` units. */
  points: HoverAtPoint[];
  coordinateSpace?: "absolute" | "normalized" | "percent";
  toolType?: "stylus" | "mouse";
  display?: string;
  snapshotId?: string;
  layer?: HierarchyLayer;
}

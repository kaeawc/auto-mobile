import type { HierarchyLayer } from "./HierarchyLayer";
import type { ImagePointSource } from "./ImageRelativePoint";

/** One screen point in the coordinate space the swipe selects. */
export interface SwipeAtPoint {
  x: number;
  y: number;
}

/** Both swipe endpoints measured in one screenshot or observe.crop image. */
export interface ImageRelativeSwipe {
  unit: "normalized" | "pixels";
  source: ImagePointSource;
  from: SwipeAtPoint;
  to: SwipeAtPoint;
}

interface SwipeAtGestureOptions {
  /** Optional observe snapshot reference; stale geometry or frame context rejects the gesture. */
  snapshotId?: string;
  /** Swipe speed preset; defaults to normal. */
  speed?: "slow" | "normal" | "fast";
  /** Refuse the gesture when the `from` point lies on the other layer's windows. */
  layer?: HierarchyLayer;
  /** Android panel key, role, or `active`; points are in that panel's coordinate space. */
  display?: string;
}

export type SwipeAtOptions = SwipeAtGestureOptions &
  (
    | {
        from: SwipeAtPoint;
        to: SwipeAtPoint;
        coordinateSpace?: "absolute" | "normalized" | "percent";
        image?: never;
      }
    | { image: ImageRelativeSwipe; from?: never; to?: never; coordinateSpace?: never }
  );

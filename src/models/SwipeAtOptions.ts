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

/**
 * Filled by the action while it resolves a swipe, for the tool-call recorder: the native endpoints
 * and the screen they were resolved against. Internal; never part of the public tool schema.
 */
export interface SwipeAtRecordingContext {
  recorded?: {
    screenSize: { width: number; height: number };
    from: SwipeAtPoint;
    to: SwipeAtPoint;
  };
}

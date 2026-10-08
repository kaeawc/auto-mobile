import type { ImageRelativePoint } from "./ImageRelativePoint";

import type { HierarchyLayer } from "./HierarchyLayer";
import type { TapAtPlanContext } from "./TapAtGeometry";

/** One screen point, resolved to the platform-native observe coordinate space. */
interface TapAtGestureOptions {
  /** Internal replay/recording context; absent from the public tool schema. */
  planContext?: TapAtPlanContext;
  display?: string;
  /** Optional observe snapshot reference; stale geometry or frame context rejects the gesture. */
  snapshotId?: string;
  /** Gesture to perform; defaults to tap. */
  action?: "tap" | "longPress" | "doubleTap";
  /** Long-press duration in milliseconds (500–10000); defaults to 1000. */
  durationMs?: number;
  /** Refuse the gesture when the point lies on the other layer's windows (issue #9305). */
  layer?: HierarchyLayer;
}

export type TapAtOptions = TapAtGestureOptions &
  (
    | {
        x: number;
        y: number;
        coordinateSpace?: "absolute" | "normalized" | "percent";
        image?: never;
      }
    | { image: ImageRelativePoint; x?: never; y?: never; coordinateSpace?: never }
  );

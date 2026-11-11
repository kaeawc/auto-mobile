import type { ImageRelativePoint } from "./ImageRelativePoint";

import type { HierarchyLayer } from "./HierarchyLayer";
import type { PointerOption } from "./PointerOption";
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
  /** Stylus instead of a finger (Android 12+, tap and long press only; #13081). */
  pointer?: PointerOption;
  /**
   * Internal: what absolute x/y mean. `screenshot` (default, the public tapAt tool) maps Android
   * XR home-space screenshot pixels onto the app panel; `native` is view-hierarchy space (an
   * element centre from observe), dispatched without XR panel mapping. Absent from the schema.
   */
  pointSpace?: "native" | "screenshot";
  /**
   * Internal: the shared `isAndroidXr` predicate's answer, set by tapAt before resolution.
   * Absent means not XR. Absent from the schema.
   */
  androidXr?: boolean;
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

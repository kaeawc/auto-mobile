import type { ImageRelativePoint } from "./ImageRelativePoint";

/** One screen point, resolved to the platform-native observe coordinate space. */
interface TapAtGestureOptions {
  display?: string;
  /** Optional observe snapshot reference; stale geometry or frame context rejects the gesture. */
  snapshotId?: string;
  /** Gesture to perform; defaults to tap. */
  action?: "tap" | "longPress" | "doubleTap";
  /** Long-press duration in milliseconds (500–10000); defaults to 1000. */
  durationMs?: number;
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

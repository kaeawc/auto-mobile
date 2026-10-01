/** One screen point, resolved to the platform-native observe coordinate space. */
export interface TapAtOptions {
  x: number;
  y: number;
  display?: string;
  /** Optional observe snapshot reference; stale geometry or frame context rejects the gesture. */
  snapshotId?: string;
  /** Coordinate units; absolute is the platform-native observe space. */
  coordinateSpace?: "absolute" | "normalized" | "percent";
  /** Gesture to perform; defaults to tap. */
  action?: "tap" | "longPress" | "doubleTap";
  /** Long-press duration in milliseconds (500–10000); defaults to 1000. */
  durationMs?: number;
}

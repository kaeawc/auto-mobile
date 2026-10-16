import type { BaseActionResult } from "./BaseActionResult";

/** Result of a polyline drag. Coordinates are the native points actually driven. */
export interface DragPathResult extends BaseActionResult {
  /** Native-space vertices dispatched (Android physical pixels). */
  points?: Array<{ x: number; y: number }>;
  /** Planned wall time from finger down to finger up, excluding dispatch latency. */
  plannedDurationMs?: number;
  /** Number of streamed move frames sent. */
  moveCount?: number;
}

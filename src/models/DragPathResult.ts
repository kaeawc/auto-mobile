import { BaseActionResult } from "./BaseActionResult";

/**
 * Why an iOS drag was refused as unsupported: synthesized touches open a SpringBoard icon's
 * context menu but never lift the icon (home screen grid or dock), so no input was sent.
 */
export type SpringBoardDragUnsupported = "springboard_icon_drag";

/** Result of a polyline drag. Coordinates are the native points actually driven. */
export interface DragPathResult extends BaseActionResult {
  /** Native-space vertices dispatched (Android physical pixels). */
  points?: Array<{ x: number; y: number }>;
  /** Planned wall time from finger down to finger up, excluding dispatch latency. */
  plannedDurationMs?: number;
  /** Number of streamed move frames sent. */
  moveCount?: number;
  /** iOS: refused before any input because the stroke starts on a SpringBoard icon (#18859). */
  unsupported?: SpringBoardDragUnsupported;
}

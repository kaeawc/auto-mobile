import type { BaseActionResult } from "./BaseActionResult";

/** Result of a platform-native absolute coordinate tap. */
export interface TapAtResult extends BaseActionResult {
  /** Coordinates actually dispatched (Android physical pixels; iOS XCTest points). */
  x: number;
  y: number;
}

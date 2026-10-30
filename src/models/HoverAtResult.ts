import type { BaseActionResult } from "./BaseActionResult";

export interface HoverAtResult extends BaseActionResult {
  /** Native-space positions dispatched (Android physical pixels). */
  points?: Array<{ x: number; y: number }>;
  /** Planned wall time from hover enter to exit, excluding dispatch latency. */
  plannedDurationMs?: number;
  /** The injection route that carried the hover. */
  route?: string;
}

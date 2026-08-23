import { BaseActionResult } from "./BaseActionResult";

/**
 * Result of a shake operation
 */
export interface ShakeResult extends BaseActionResult {
  duration: number;
  intensity: number;
}

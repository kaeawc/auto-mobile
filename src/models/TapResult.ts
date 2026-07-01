import { BaseActionResult } from "./BaseActionResult";

/**
 * Result of a tap operation
 */
export interface TapResult extends BaseActionResult {
  x: number;
  y: number;
}

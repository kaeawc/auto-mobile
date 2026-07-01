import { BaseActionResult } from "./BaseActionResult";

/**
 * Result of a send text operation
 */
export interface SendTextResult extends BaseActionResult {
  text: string;
  imeAction?: string;
}

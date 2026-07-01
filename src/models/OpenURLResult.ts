import { BaseActionResult } from "./BaseActionResult";

/**
 * Result of an open URL operation
 */
export interface OpenURLResult extends BaseActionResult {
  url: string;
}

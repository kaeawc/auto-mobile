import { BaseActionResult } from "./BaseActionResult";

/**
 * Result of a recent apps navigation operation
 */
export interface RecentAppsResult extends BaseActionResult {
  method: "hardware" | "ios_swipe";
}

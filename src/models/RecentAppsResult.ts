import { BaseActionResult } from "./BaseActionResult";

/**
 * Result of a recent apps navigation operation
 */
export interface RecentAppsResult extends BaseActionResult {
  method: "gesture" | "legacy" | "hardware" | "ios_swipe";
}

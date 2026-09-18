import { BaseActionResult } from "./BaseActionResult";
import type { TimingData } from "../utils/PerformanceTracker";

/**
 * Result of an uninstall app operation
 */
export interface UninstallAppResult extends BaseActionResult {
  packageName: string;
  keepData: boolean;
  /**
   * Whether the app was installed before the uninstall. Optional/omitted when
   * the install state could not be established — e.g. an iOS installed-app
   * listing that failed rather than reported an empty device (issue #5621).
   * Always read `success` before trusting this field.
   */
  wasInstalled?: boolean;
  /** Android user ID where the app was uninstalled from (0 for primary user, 10+ for work profiles) */
  userId?: number;
  /** Command-span timing tree, present only when `--debug-perf` is enabled and this call was not nested inside an outer ambient perf scope. */
  perfTiming?: TimingData;
}

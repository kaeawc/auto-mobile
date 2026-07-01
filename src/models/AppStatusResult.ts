import { BaseActionResult } from "./BaseActionResult";

/**
 * Result of checking comprehensive app status
 */
export interface AppStatusResult extends BaseActionResult {
  packageName: string;
  isInstalled: boolean;
  isRunning: boolean;
}

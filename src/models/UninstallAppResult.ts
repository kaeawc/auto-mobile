import { BaseActionResult } from "./BaseActionResult";

/**
 * Result of an uninstall app operation
 */
export interface UninstallAppResult extends BaseActionResult {
  packageName: string;
  keepData: boolean;
  wasInstalled: boolean;
  /** Android user ID where the app was uninstalled from (0 for primary user, 10+ for work profiles) */
  userId?: number;
}

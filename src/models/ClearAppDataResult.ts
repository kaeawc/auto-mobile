import { BaseActionResult } from "./BaseActionResult";

/**
 * Result of a clear app data operation
 */
export interface ClearAppDataResult extends BaseActionResult {
  packageName: string;
  /** Android user ID where the app data was cleared (0 for primary user, 10+ for work profiles) */
  userId?: number;
}

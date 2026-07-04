import { BaseActionResult } from "./BaseActionResult";

/**
 * Result of a terminate app operation
 */
export interface TerminateAppResult extends BaseActionResult {
  packageName: string;
  /**
   * Whether the app was installed. Optional/omitted on a failed termination
   * (`success:false`), where install state is genuinely unknown — a devicectl
   * failure can occur after the app was confirmed installed. Always read
   * `success` before trusting this field.
   */
  wasInstalled?: boolean;
  /** Whether the app had a running process that was terminated. Omitted on `success:false` (unknown). */
  wasRunning?: boolean;
  wasForeground: boolean;
  /** Android user ID where the app was terminated (0 for primary user, 10+ for work profiles) */
  userId?: number;
}

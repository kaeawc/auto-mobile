import { BaseActionResult } from "./BaseActionResult";

/**
 * Result of an install app operation
 */
export interface InstallAppResult extends BaseActionResult {
  artifactPath: string;
  /** Android user ID where the app was installed (0 for primary user, 10+ for work profiles) */
  userId?: number;
  /** Package name or bundle ID detected for the installed app, when available */
  packageName?: string;
  /** True if installation replaced an existing package */
  upgrade?: boolean;
  /** Warning message when best-effort detection was required */
  warning?: string;
}

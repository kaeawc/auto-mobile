import { BaseActionResult } from "./BaseActionResult";
import type { TimingData } from "../utils/PerformanceTracker";

/**
 * Result of an install app operation
 */
export interface InstallAppResult extends BaseActionResult {
  artifactPath?: string;
  /** Android user ID where the app was installed (0 for primary user, 10+ for work profiles) */
  userId?: number;
  /** Package name or bundle ID detected for the installed app, when available */
  packageName?: string;
  /** True if installation replaced an existing package */
  upgrade?: boolean;
  /** Warning message when best-effort detection was required */
  warning?: string;
  /**
   * Present when the caller requested a signing guard: `matched` when an installed copy
   * carried exactly the expected signers, `no-existing-package` when nothing was replaced.
   */
  signingGuard?: { status: "matched"; matchedSha256: string[] } | { status: "no-existing-package" };
  /** Command-span timing tree, present only when `--debug-perf` is enabled. */
  perfTiming?: TimingData;
}

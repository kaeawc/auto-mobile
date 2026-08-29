import { BaseActionResult } from "./BaseActionResult";

/**
 * Result of a launch app operation
 */
export interface LaunchAppResult extends BaseActionResult {
  packageName: string;
  activityName?: string;
  /** Android user ID where the app was launched (0 for primary user, 10+ for work profiles) */
  userId?: number;
  /** Process ID (iOS only) */
  pid?: number;
  /**
   * Explains a deliberately-omitted `observation` (issue #5872) so the launch
   * payload has a deterministic, self-describing shape: rather than silently
   * dropping the observation when it still reports the previous app, the response
   * carries this marker naming why and what the stale observation actually showed.
   */
  observationOmitted?: {
    reason: "stale_launch_observation";
    expectedPackage: string;
    reportedPackages: string;
  };
}

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
   * The app was already in the foreground, so nothing was launched (issue #6868).
   * "Make this app foreground" is a goal, not a transition: the desired end state
   * held before and after the call, so this is a success — the observation and
   * the response-level `verified`/`observedAppId` carry the proof — not an error
   * a client has to string-match to decide whether to continue.
   *
   * ANDROID ONLY: the iOS path re-launches through simctl/devicectl (the warm
   * `activate()` fast path) without detecting the already-foreground case, so an
   * iOS result never carries this marker — its absence is not evidence the app
   * was backgrounded.
   */
  alreadyForeground?: boolean;
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

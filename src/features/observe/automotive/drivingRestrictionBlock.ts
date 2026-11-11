import type { BackStackInfo } from "../../../models/BackStack";

/**
 * The activity the car service starts over a non-distraction-optimized activity while driving
 * ("You can’t use this feature while driving"), as the API 34 AAOS back stack names it (#18045).
 */
export const ACTIVITY_BLOCKING_ACTIVITY =
  "com.android.systemui.car.activity.ActivityBlockingActivity";

export interface DrivingRestrictionBlock {
  /** The blocking activity in front. */
  blockedBy: string;
  /** The activity it covers: the top activity of the next task down, when the stack lists one. */
  blockedActivity?: string;
}

/** The driving-restriction block the back stack shows, or `undefined` when none is in front. */
export function detectDrivingRestrictionBlock(
  backStack: Pick<BackStackInfo, "activities" | "currentActivity"> | undefined,
): DrivingRestrictionBlock | undefined {
  const current = backStack?.currentActivity;
  if (current?.name !== ACTIVITY_BLOCKING_ACTIVITY) {
    return undefined;
  }
  const blocked = backStack?.activities.find((activity) => activity.taskId !== current.taskId);
  return { blockedBy: current.name, ...(blocked ? { blockedActivity: blocked.name } : {}) };
}

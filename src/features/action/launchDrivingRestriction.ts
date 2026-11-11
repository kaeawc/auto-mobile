import type { ObserveResult } from "../../models";
import { detectDrivingRestrictionBlock } from "../observe/automotive/drivingRestrictionBlock";

/** The code a launch failure names when the car's driving restrictions block the activity. */
export const BLOCKED_BY_DRIVING_RESTRICTIONS = "blocked_by_driving_restrictions";

/**
 * The launch failure message when the car's blocking activity is in front of a task owned by
 * `expectedPackageName` (#18046), or `undefined` when the back stack shows no such block.
 */
export function describeLaunchDrivingRestriction(
  observation: Pick<ObserveResult, "backStack"> | undefined,
  expectedPackageName: string,
): string | undefined {
  const backStack = observation?.backStack;
  const block = detectDrivingRestrictionBlock(backStack);
  if (!block?.blockedActivity) {
    return undefined;
  }
  const activities = backStack?.activities ?? [];
  const blocker = backStack?.currentActivity;
  const blockerIndex = activities.findIndex(
    (activity) => activity.name === blocker?.name && activity.taskId === blocker?.taskId,
  );
  const covered = activities
    .slice(blockerIndex + 1)
    .find((activity) => activity.taskId !== blocker?.taskId);
  const coveredPackage = backStack?.tasks.find((task) => task.id === covered?.taskId)?.packageName;
  if (coveredPackage !== expectedPackageName) {
    return undefined;
  }
  return (
    `${BLOCKED_BY_DRIVING_RESTRICTIONS}: ${block.blockedActivity} is not distraction optimized, ` +
    `so the car's driving restrictions cover it with ${block.blockedBy}. Park the vehicle ` +
    `(setDeviceState with deviceCondition {"vehicle":{"motion":"parked"}}) and retry, ` +
    `or launch an activity declared distractionOptimized.`
  );
}

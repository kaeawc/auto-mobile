import { logger } from "../../utils/logger";

/**
 * Count a visit to `newScreen` after a successful interaction and return the
 * screen the next interaction starts from. A return to a screen already seen
 * increments its count; staying on the same screen does not.
 */
export function recordScreenVisit(
  loopDetection: Map<string, number>,
  previousScreen: string | null,
  newScreen: string | null,
): string | null {
  if (!newScreen) {
    return previousScreen;
  }
  if (previousScreen === null) {
    // First screen we're tracking
    loopDetection.set(newScreen, 1);
  } else if (newScreen !== previousScreen) {
    const visitCount = loopDetection.get(newScreen) ?? 0;
    if (visitCount > 0) {
      logger.debug(`[Explore] Returning to screen ${newScreen}, visit count: ${visitCount + 1}`);
    }
    loopDetection.set(newScreen, visitCount + 1);
  }
  return newScreen;
}

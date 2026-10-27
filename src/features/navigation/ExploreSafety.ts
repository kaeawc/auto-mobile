const MAX_CONSECUTIVE_BACKS = 5;
const MAX_LOOP_ITERATIONS = 3;

/** Counters and limits the exploration loop checks before every interaction. */
export interface ExploreSafetyState {
  consecutiveBackCount: number;
  consecutiveNoChangeCount: number;
  maxConsecutiveNoChange: number;
  loopDetection: ReadonlyMap<string, number>;
  getCurrentScreen: () => string | null;
}

/** Why exploration must stop for safety, or null when it may continue. */
export function explorationSafetyStopReason(state: ExploreSafetyState): string | null {
  if (state.consecutiveBackCount >= MAX_CONSECUTIVE_BACKS) {
    return `Too many consecutive back navigations (${MAX_CONSECUTIVE_BACKS})`;
  }
  if (state.consecutiveNoChangeCount >= state.maxConsecutiveNoChange) {
    return `Screen appears stuck - no changes detected after ${state.maxConsecutiveNoChange} interactions`;
  }
  const currentScreen = state.getCurrentScreen();
  if (currentScreen && (state.loopDetection.get(currentScreen) ?? 0) >= MAX_LOOP_ITERATIONS) {
    return `Detected navigation loop on screen: ${currentScreen}`;
  }
  return null;
}

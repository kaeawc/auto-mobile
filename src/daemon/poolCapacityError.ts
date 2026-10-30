import { ActionableError } from "../models";
import type { Platform } from "../models";
import type { DeviceCriteriaMatcher } from "./DeviceCriteriaMatcher";

/** The pool counts the capacity error reports; structurally a subset of the pool's stats. */
export interface PoolCapacityStats {
  total: number;
  idle: number;
  assigned: number;
  error: number;
}

/** What else counts toward, and is reported with, a pool capacity check. */
export interface PoolCapacityContext {
  /** Android emulators being recovered, which count toward capacity. */
  recoveringAndroidImages: number;
  /** The already-rendered refresh-failure prefix (empty when the last refresh succeeded). */
  refreshContext: string;
}

/**
 * Throws the "not enough devices" error when the pool plus eligible Android recoveries cannot
 * satisfy a multi-device acquisition (`recoveringAndroidImages` are Android emulators being
 * recovered, which count toward capacity). `refreshContext` is the already-rendered refresh-failure
 * prefix (empty when the last refresh succeeded). Synchronous and side-effect free otherwise.
 */
export function assertPoolCapacity(
  matcher: Pick<DeviceCriteriaMatcher, "hasSufficientCapacityIncludingAndroidRecovery">,
  stats: PoolCapacityStats,
  requiredCount: number,
  platform: Platform | undefined,
  { recoveringAndroidImages, refreshContext }: PoolCapacityContext,
): void {
  if (
    matcher.hasSufficientCapacityIncludingAndroidRecovery(
      stats.total,
      requiredCount,
      recoveringAndroidImages,
      platform,
    )
  ) {
    return;
  }
  throw new ActionableError(
    `Not enough devices in pool: need ${requiredCount}, have ${stats.total}.\n` +
      refreshContext +
      `Device pool status:\n` +
      `  Total devices: ${stats.total}\n` +
      `  Idle: ${stats.idle}\n` +
      `  Assigned: ${stats.assigned}\n` +
      `  Error: ${stats.error}\n\n` +
      `Suggestions:\n` +
      `  - Start ${requiredCount - stats.total} more emulator(s) or simulators\n` +
      `  - Reduce the number of devices required in the test plan\n` +
      `  - Verify ADB is working: adb devices`,
  );
}

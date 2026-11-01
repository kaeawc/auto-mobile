import { DeviceLossMisses } from "../../../src/daemon/deviceLossMisses";

/** A miss owner preloaded with per-device streaks, for evaluator and pool tests. */
export function seededMisses(entries: ReadonlyArray<[string, number]> = []): DeviceLossMisses {
  const misses = new DeviceLossMisses();
  for (const [deviceId, count] of entries) {
    misses.set(deviceId, count);
  }
  return misses;
}

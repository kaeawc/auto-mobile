import type { BootedDevice, ObserveResult } from "../../../models";
import { awaitWhileRequestIsLive, throwIfAborted } from "../../../utils/toolUtils";
import { getSystemTrayDependencies } from "./dependencies";
import { observeSystemTray } from "./runtime";

/**
 * A Wear `systemTray` read of the screen as it is now (#19312). The floor is the device clock
 * just before the read, the domain the detector's `getObservationTimestamp` and the dismissal
 * reads use, so `requireFreshExtraction` forces a capture newer than the action the read
 * follows. A floor of 0 would let a cached tree from before a swipe, tap or Back answer.
 */
export async function readWatchNow(
  device: BootedDevice,
  signal?: AbortSignal,
): Promise<ObserveResult> {
  throwIfAborted(signal);
  const deps = getSystemTrayDependencies();
  const floor = await awaitWhileRequestIsLive(
    deps.adbFactory(device).getDeviceTimestampMs(),
    signal,
  );
  return observeSystemTray(deps.observeScreenFactory(device), floor, signal, true);
}

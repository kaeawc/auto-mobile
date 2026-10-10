import type { Timer } from "../utils/SystemTimer";
import { logger } from "../utils/logger";
import { errorMessage } from "../utils/describeUnknownError";

/** Coalescing window for bursts of pool state changes (a claim often follows a release). */
export const DEVICE_STATE_NOTIFY_DEBOUNCE_MS = 100;

export interface DeviceStateChangeNotifierOptions {
  timer: Timer;
  /** Runs synchronously on every change so a read inside the debounce window is never stale. */
  invalidate: () => void;
  /** Runs once per burst, after the window closes. */
  notify: () => Promise<void>;
  debounceMs?: number;
}

/**
 * Turns DevicePool state-change events into one debounced resource notification (#11413).
 * It only invalidates caches and notifies subscribers: it never touches a session, so it
 * cannot hold or extend one.
 */
export function createDeviceStateChangeNotifier(
  options: DeviceStateChangeNotifierOptions,
): (deviceId: string) => void {
  const { timer, invalidate, notify, debounceMs = DEVICE_STATE_NOTIFY_DEBOUNCE_MS } = options;
  let pending: NodeJS.Timeout | undefined;
  return (_deviceId: string) => {
    invalidate();
    if (pending) {
      return;
    }
    pending = timer.setTimeout(() => {
      pending = undefined;
      notify().catch((error) => {
        logger.warn(
          `[DeviceStateChangeNotifier] Resource notification failed: ${errorMessage(error)}`,
        );
      });
    }, debounceMs);
  };
}

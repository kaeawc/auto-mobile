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

export interface DeviceStateChangeNotifier {
  (deviceId: string): void;
  /** Cancels the pending notification and ignores later changes (daemon shutdown). */
  dispose(): void;
}

/**
 * Turns DevicePool state-change events into one debounced resource notification (#11413).
 * It only invalidates caches and notifies subscribers: it never touches a session, so it
 * cannot hold or extend one.
 */
export function createDeviceStateChangeNotifier(
  options: DeviceStateChangeNotifierOptions,
): DeviceStateChangeNotifier {
  const { timer, invalidate, notify, debounceMs = DEVICE_STATE_NOTIFY_DEBOUNCE_MS } = options;
  let pending: NodeJS.Timeout | undefined;
  let disposed = false;
  const onChange = (_deviceId: string) => {
    invalidate();
    if (pending || disposed) {
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
  return Object.assign(onChange, {
    dispose: () => {
      disposed = true;
      if (pending) {
        timer.clearTimeout(pending);
        pending = undefined;
      }
    },
  });
}

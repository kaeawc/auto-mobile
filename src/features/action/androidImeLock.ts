import { Mutex } from "async-mutex";

// IME selection is global to an Android device. Share this lock between temporary typing
// sessions and persistent keyboard selection so neither can restore over the other.
const imeLocks = new Map<string, Mutex>();
const unsafeImeDevices = new Set<string>();

export function quarantineAndroidIme(deviceId: string): void {
  unsafeImeDevices.add(deviceId);
}

/** Call only after a verified runner restart or device reset. */
export function clearAndroidImeQuarantine(deviceId: string): void {
  unsafeImeDevices.delete(deviceId);
}

export function withAndroidImeLock<T>(
  deviceId: string,
  action: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  let lock = imeLocks.get(deviceId);
  if (!lock) {
    lock = new Mutex();
    imeLocks.set(deviceId, lock);
  }
  return lock.runExclusive(() => {
    if (unsafeImeDevices.has(deviceId)) {
      throw new Error(
        "IME state is unknown after an unacknowledged cancellation; restart AutoMobile before changing keyboards.",
      );
    }
    signal?.throwIfAborted();
    return action();
  });
}

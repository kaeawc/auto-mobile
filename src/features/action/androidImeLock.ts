import { Mutex } from "async-mutex";

// IME selection is global to an Android device. Share this lock between temporary typing
// sessions and persistent keyboard selection so neither can restore over the other.
const imeLocks = new Map<string, Mutex>();

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
    signal?.throwIfAborted();
    return action();
  });
}

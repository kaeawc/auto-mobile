import { Mutex } from "async-mutex";
import { throwIfAborted } from "./toolUtils";

const locks = new Map<string, Mutex>();

/**
 * Serializes AutoMobile's Android package mutations (install, uninstall) per device so a
 * guarded inspect-then-mutate sequence cannot interleave with another AutoMobile mutation.
 * It cannot see package changes made outside AutoMobile (adb from a shell, the Play Store);
 * callers needing that must hold the device exclusively.
 */
export async function withAndroidPackageMutationLock<T>(
  deviceId: string,
  signal: AbortSignal | undefined,
  action: () => Promise<T>,
): Promise<T> {
  let lock = locks.get(deviceId);
  if (!lock) {
    lock = new Mutex();
    locks.set(deviceId, lock);
  }
  return lock.runExclusive(async () => {
    // A caller that left while queued must not start a mutation.
    throwIfAborted(signal);
    return action();
  });
}

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
  throwIfAborted(signal);
  let lock = locks.get(deviceId);
  if (!lock) {
    lock = new Mutex();
    locks.set(deviceId, lock);
  }
  let started = false;
  const run = lock.runExclusive(async () => {
    // A caller that left while queued must not start a mutation; its turn is released at once.
    throwIfAborted(signal);
    started = true;
    return action();
  });
  if (!signal) {
    return run;
  }
  // A caller cancelled while still queued is answered now, not when the holder finishes (#11058).
  // Once its mutation has started, the action's own handling of the signal decides the outcome.
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      if (started) {
        return;
      }
      try {
        throwIfAborted(signal);
      } catch (error) {
        reject(error);
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    run.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

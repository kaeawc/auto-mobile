import { Mutex } from "async-mutex";

type ImeLockRelease = Awaited<ReturnType<Mutex["acquire"]>>;

// IME selection is global to an Android device. Share this lock between temporary typing
// sessions and persistent keyboard selection so neither can restore over the other.
const imeLocks = new Map<string, Mutex>();
const unsafeImeDevices = new Set<string>();

export function quarantineAndroidIme(deviceId: string): void {
  unsafeImeDevices.add(deviceId);
}

/** Call only after verified explicit IME selection, runner restart, or device reset. */
export function clearAndroidImeQuarantine(deviceId: string): void {
  unsafeImeDevices.delete(deviceId);
}

async function acquireImeLock(lock: Mutex, signal?: AbortSignal): Promise<ImeLockRelease> {
  signal?.throwIfAborted();
  if (!signal) {
    return lock.acquire();
  }
  return new Promise<ImeLockRelease>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    void lock.acquire().then(
      (release) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) {
          release();
          return;
        }
        resolve(release);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export async function withAndroidImeLock<T>(
  deviceId: string,
  action: () => Promise<T>,
  signal?: AbortSignal,
  options: { allowQuarantined?: boolean } = {},
): Promise<T> {
  let lock = imeLocks.get(deviceId);
  if (!lock) {
    lock = new Mutex();
    imeLocks.set(deviceId, lock);
  }
  const release = await acquireImeLock(lock, signal);
  try {
    if (unsafeImeDevices.has(deviceId) && !options.allowQuarantined) {
      throw new Error(
        'IME state is unknown after an unacknowledged cancellation; run "keyboard setIme <imeId>" with an enabled IME, or restart AutoMobile before other IME operations.',
      );
    }
    signal?.throwIfAborted();
    return await action();
  } finally {
    release();
  }
}

import { Mutex } from "async-mutex";
import { registerDeviceIncarnationListener } from "../../utils/deviceIncarnation";

type ImeLockRelease = Awaited<ReturnType<Mutex["acquire"]>>;

// IME selection is global to an Android device. Share this lock between temporary typing
// sessions and persistent keyboard selection so neither can restore over the other.
const imeLocks = new Map<string, Mutex>();
export interface AndroidImeRecoverySnapshot {
  imeId: string;
  subtypeId: number | null;
}

const unsafeImeDevices = new Map<string, AndroidImeRecoverySnapshot | undefined>();

export function quarantineAndroidIme(
  deviceId: string,
  snapshot?: AndroidImeRecoverySnapshot,
): void {
  unsafeImeDevices.set(deviceId, snapshot);
}

/**
 * Call only after verified explicit IME selection, runner restart, or identity replacement
 * of the device behind the serial; NOT on removal or same-device restart.
 */
export function clearAndroidImeQuarantine(deviceId: string): void {
  unsafeImeDevices.delete(deviceId);
}

registerDeviceIncarnationListener({
  name: "android-ime-quarantine",
  onDeviceIdentityReplaced: clearAndroidImeQuarantine,
  // Snapshot restore and same-device re-pool retain guest IME state and its quarantine.
  onDeviceIncarnationChanged: () => {},
});

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
  options: {
    allowQuarantined?: boolean;
    recoverQuarantined?: (snapshot: AndroidImeRecoverySnapshot) => Promise<boolean>;
  } = {},
): Promise<T> {
  let lock = imeLocks.get(deviceId);
  if (!lock) {
    lock = new Mutex();
    imeLocks.set(deviceId, lock);
  }
  const release = await acquireImeLock(lock, signal);
  try {
    if (unsafeImeDevices.has(deviceId) && !options.allowQuarantined) {
      const snapshot = unsafeImeDevices.get(deviceId);
      if (snapshot && (await options.recoverQuarantined?.(snapshot))) {
        clearAndroidImeQuarantine(deviceId);
      }
    }
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

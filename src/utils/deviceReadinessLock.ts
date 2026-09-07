import { defaultTimer, type Timer } from "./SystemTimer";

/**
 * Per-device readiness serialization lock (#6227).
 *
 * Bringing an Android device to automation readiness resets and re-runs setup
 * on the *shared*, process-wide per-device `AndroidCtrlProxyManager` singleton
 * (`resetSetupState()` + `setup()`). Two readiness setups running concurrently
 * against the same physical device — e.g. a `startDevice`/`getAndroid`/provision
 * acquisition preparing the device through one daemon queue while a persisted
 * session's readiness *upgrade* (`ToolExecutionContext`) prepares the same
 * device through another — would corrupt each other's setup state.
 *
 * This module owns the single, process-wide map that serializes readiness setup
 * per device so both the acquisition path (`RunnerReadinessService`) and the
 * session-scoped upgrade path (`ToolExecutionContext`) participate in the SAME
 * lock. The lock is a per-key FIFO mutex: the first caller acquires
 * immediately, later callers queue and are handed the lock in arrival order as
 * each holder releases. Waiters may optionally bound their wait with a timeout
 * and/or an `AbortSignal` (the acquisition path uses its readiness deadline);
 * an unbounded waiter (the upgrade path) simply waits its turn.
 */

export type DeviceReadinessLockRelease = () => void;

interface ReadinessWaiter {
  active: boolean;
  resolve: (release: DeviceReadinessLockRelease) => void;
  reject: (error: unknown) => void;
  timer: Timer;
  timeoutHandle?: NodeJS.Timeout;
  abortListener?: () => void;
  signal?: AbortSignal;
}

interface ReadinessLock {
  locked: boolean;
  waiters: ReadinessWaiter[];
}

const readinessLocksByDevice = new Map<string, ReadinessLock>();

/**
 * Canonical lock key for a device. Both the acquisition path and the upgrade
 * path must derive the key identically so they serialize on the same entry.
 */
export function deviceReadinessLockKey(platform: string, deviceId: string): string {
  return `${platform}:${deviceId}`;
}

export interface AcquireDeviceReadinessLockOptions {
  /** Timer used for the optional wait timeout (injected for deterministic tests). */
  timer?: Timer;
  /** Aborts a queued wait (never interrupts a holder). */
  signal?: AbortSignal;
  /** Bounds how long a queued caller waits before abandoning its turn. */
  timeoutMs?: number;
  /** Error a timed-out wait rejects with; defaults to a generic timeout error. */
  timeoutError?: () => unknown;
}

/**
 * Acquire the readiness lock for `key`, resolving with a release function.
 * Release exactly once (a `withDeviceReadinessLock` wrapper is provided for the
 * common try/finally case).
 */
export function acquireDeviceReadinessLock(
  key: string,
  options: AcquireDeviceReadinessLockOptions = {},
): Promise<DeviceReadinessLockRelease> {
  const timer = options.timer ?? defaultTimer;
  const lock = readinessLocksByDevice.get(key) ?? { locked: false, waiters: [] };
  readinessLocksByDevice.set(key, lock);
  if (!lock.locked) {
    lock.locked = true;
    return Promise.resolve(createRelease(key, lock));
  }
  return new Promise<DeviceReadinessLockRelease>((resolve, reject) => {
    const waiter: ReadinessWaiter = {
      active: true,
      resolve,
      reject,
      timer,
      signal: options.signal,
    };
    const abandon = (error: unknown) => {
      if (!waiter.active) {
        return;
      }
      waiter.active = false;
      removeReadinessWaiter(lock, waiter);
      cleanupReadinessWaiter(waiter);
      reject(error);
    };
    if (options.timeoutMs !== undefined) {
      waiter.timeoutHandle = timer.setTimeout(
        () =>
          abandon(
            options.timeoutError
              ? options.timeoutError()
              : new Error("device readiness lock wait timed out"),
          ),
        options.timeoutMs,
      );
    }
    if (options.signal) {
      waiter.abortListener = () => abandon(options.signal!.reason);
      options.signal.addEventListener("abort", waiter.abortListener, { once: true });
    }
    lock.waiters.push(waiter);
    if (options.signal?.aborted) {
      waiter.abortListener!();
    }
  });
}

/** Acquire the device readiness lock, run `fn`, and release the lock. */
export async function withDeviceReadinessLock<T>(
  key: string,
  fn: () => Promise<T>,
  options: AcquireDeviceReadinessLockOptions = {},
): Promise<T> {
  const release = await acquireDeviceReadinessLock(key, options);
  try {
    return await fn();
  } finally {
    release();
  }
}

function createRelease(key: string, lock: ReadinessLock): DeviceReadinessLockRelease {
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    let waiter = lock.waiters.shift();
    while (waiter && !waiter.active) {
      waiter = lock.waiters.shift();
    }
    if (waiter) {
      waiter.active = false;
      cleanupReadinessWaiter(waiter);
      waiter.resolve(createRelease(key, lock));
      return;
    }
    lock.locked = false;
    if (readinessLocksByDevice.get(key) === lock) {
      readinessLocksByDevice.delete(key);
    }
  };
}

function removeReadinessWaiter(lock: ReadinessLock, waiter: ReadinessWaiter): void {
  const index = lock.waiters.indexOf(waiter);
  if (index >= 0) {
    lock.waiters.splice(index, 1);
  }
}

function cleanupReadinessWaiter(waiter: ReadinessWaiter): void {
  if (waiter.timeoutHandle) {
    waiter.timer.clearTimeout(waiter.timeoutHandle);
  }
  if (waiter.abortListener) {
    waiter.signal?.removeEventListener("abort", waiter.abortListener);
  }
}

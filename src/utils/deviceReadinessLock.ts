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
  // A caller that was cancelled before it reached the lock must never start
  // setup merely because there happened to be no current holder. Queued
  // callers already get this behavior through their abort listener below.
  options.signal?.throwIfAborted();
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

/**
 * Device-scoped "acquisition is recording readiness" marker (#6280 P2
 * follow-up).
 *
 * The acquisition path (`startDevice`/`getAndroid`) releases the readiness
 * lock above as soon as `RunnerReadinessService.ensureReady` finishes CtrlProxy
 * setup — well before it goes on to bind (or reuse) the device's session and
 * record the achieved readiness on it (`recordAcquiredSessionReadiness` in
 * `deviceTools.ts`). For a device whose session already existed before this
 * acquisition started (a post-restart recovered session, reused rather than
 * freshly created), that session is addressable by UUID throughout this gap.
 * A concurrent tool call on that UUID can queue behind the readiness lock,
 * acquire it the instant CtrlProxy setup finishes, observe the still-`undefined`
 * readiness (not recorded yet), and redundantly reset/rerun CtrlProxy on the
 * device that was just prepared.
 *
 * This map lets that concurrent caller (`ensureReadinessUpgraded` in
 * `ToolExecutionContext`) detect the in-flight acquisition and await its
 * completion instead of racing a second setup: once the marker settles,
 * readiness has been recorded and the caller's own satisfaction check
 * (re-run in a loop) passes without redoing setup.
 */
const deviceAcquisitionReadiness = new Map<string, Promise<void>>();

/**
 * Run `fn` while `key` is marked as having readiness acquisition in flight.
 * Callers awaiting {@link getDeviceAcquisitionReadiness} for the same key
 * resolve once `fn` settles (successfully or not) and the marker is cleared.
 */
export async function trackDeviceAcquisitionReadiness<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  let settle!: () => void;
  const marker = new Promise<void>((resolve) => {
    settle = resolve;
  });
  deviceAcquisitionReadiness.set(key, marker);
  try {
    return await fn();
  } finally {
    settle();
    // A recovery can replace a device serial after this acquisition begins.
    // Clear every alias of this marker, not only its original key.
    for (const [markerKey, current] of deviceAcquisitionReadiness) {
      if (current === marker) {
        deviceAcquisitionReadiness.delete(markerKey);
      }
    }
  }
}

/** Move an in-flight acquisition marker to a replacement device identity. */
export function moveDeviceAcquisitionReadiness(fromKey: string, toKey: string): void {
  const marker = deviceAcquisitionReadiness.get(fromKey);
  if (marker && fromKey !== toKey) {
    deviceAcquisitionReadiness.set(toKey, marker);
  }
}

/**
 * The in-flight acquisition-readiness marker for `key`, if any device
 * acquisition is currently binding/recording readiness for it.
 */
export function getDeviceAcquisitionReadiness(key: string): Promise<void> | undefined {
  return deviceAcquisitionReadiness.get(key);
}

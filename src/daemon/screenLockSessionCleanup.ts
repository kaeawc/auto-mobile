import type { BootedDevice } from "../models";
import {
  defaultLockSettingsClientFactory,
  scrubLockCredentials,
  type LockSettingsClientFactory,
} from "../features/utility/screenLock/AndroidLockSettings";
import {
  defaultScreenLockRegistry,
  type ScreenLockRegistry,
  type SessionScreenLock,
} from "../features/utility/screenLock/ScreenLockRegistry";
import {
  defaultForgetRememberedUnlock,
  restoreSessionScreenLock,
  type ForgetRememberedUnlock,
} from "../features/utility/screenLock/ScreenLockRestore";
import type { ScreenLockRestoreReport } from "../features/utility/screenLock/ScreenLockTypes";
import { runOutsideRequestContext } from "../utils/AbortContext";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import type { SessionManager, SessionReleaseOptions } from "./sessionManager";
import { SESSION_RELEASE_TEARDOWN_CAP_MS } from "./sessionManager/sessionConstants";

export interface ScreenLockSessionCleanupOptions {
  registry?: ScreenLockRegistry;
  clientFactory?: LockSettingsClientFactory;
  timer?: Pick<Timer, "sleep" | "setTimeout" | "clearTimeout">;
  forgetRememberedUnlock?: ForgetRememberedUnlock;
}

type PendingCleanupHost = Pick<SessionManager, "registerPendingDeviceCleanup">;

/**
 * Start clearing a credential `lock.sessionId` set, register it as pending device cleanup (the
 * next session cannot acquire the device mid-clear) and keep its outcome for the release result.
 */
export function startScreenLockRestore(
  manager: PendingCleanupHost,
  lock: SessionScreenLock,
  options: ScreenLockSessionCleanupOptions = {},
): Promise<ScreenLockRestoreReport> {
  const device: BootedDevice = {
    name: lock.deviceId,
    platform: "android",
    deviceId: lock.deviceId,
  };
  // Not part of whichever request triggered the release: its abort must not cut the clear short.
  // Async, so a refusal to create the adb client becomes a reported failure like any other.
  const restore = runOutsideRequestContext(async () =>
    restoreSessionScreenLock(
      lock,
      (options.clientFactory ?? defaultLockSettingsClientFactory())(device),
      {
        timer: options.timer ?? defaultTimer,
        forgetRememberedUnlock: options.forgetRememberedUnlock ?? defaultForgetRememberedUnlock,
      },
    ),
  ).catch((error: unknown): ScreenLockRestoreReport => {
    // A client or store fault, not a locksettings refusal; scrubbed anyway, never logged raw.
    const detail = scrubLockCredentials(errorMessage(error), [lock.credential]);
    logger.warn(`[screenLock] Clearing session ${lock.sessionId}'s lock threw: ${detail}`);
    return {
      status: "failed",
      deviceId: lock.deviceId,
      type: lock.type,
      error: detail,
      leftover: `Device ${lock.deviceId} may still have the ${lock.type} lock this session set.`,
    };
  });
  (options.registry ?? defaultScreenLockRegistry).noteRestore(lock.sessionId, restore);
  manager.registerPendingDeviceCleanup(lock.deviceId, restore, {
    name: "clear session screen lock",
    leftover: "the released session's lock-screen credential",
  });
  return restore;
}

/**
 * Clear the lock-screen credential a session set with `setDeviceState` when that session is
 * released or moves off the device (#14107), on the same release and unbound seams as
 * `registerNetworkStateSessionCleanup`. A leaked lock blocks every later session on the device,
 * so the outcome is kept for the release result (`screenLockRestore`), not only logged.
 */
export function registerScreenLockSessionCleanup(
  manager: Pick<
    SessionManager,
    "onSessionRelease" | "onSessionDeviceUnbound" | "registerPendingDeviceCleanup"
  >,
  options: ScreenLockSessionCleanupOptions = {},
): void {
  const registry = options.registry ?? defaultScreenLockRegistry;
  const cleanup = (
    sessionId: string,
    deviceId: string,
    releaseOptions?: Pick<SessionReleaseOptions, "deviceIdentityReplaced">,
  ): void => {
    const lock = registry.takeOwnedBy(deviceId, sessionId);
    if (!lock) {
      return;
    }
    if (releaseOptions?.deviceIdentityReplaced) {
      // A different device now answers on this serial; the locked one is gone with its data.
      logger.info(`[screenLock] Session ${sessionId}'s ${deviceId} was replaced; not clearing`);
      registry.noteRestore(
        sessionId,
        Promise.resolve({
          status: "skipped",
          deviceId,
          type: lock.type,
          error: "The device was replaced before its lock could be cleared.",
        }),
      );
      return;
    }
    void startScreenLockRestore(manager, lock, options);
  };
  // A terminal upgrade of a finished release must not touch the device's next owner (#10825).
  manager.onSessionRelease((sessionId, deviceId, _reason, releaseOptions) => {
    if (releaseOptions?.upgradeOnly) {
      return;
    }
    cleanup(sessionId, deviceId, releaseOptions);
  });
  manager.onSessionDeviceUnbound(cleanup);
}

/** A release result's `screenLockRestore`: the clear's outcome, or `pending` if still running. */
export type ScreenLockReleaseReport = ScreenLockRestoreReport | { status: "pending" };

const REPORT_WAIT_TIMEOUT = Symbol("screen lock report wait");

/**
 * `screenLockRestore` for a release result: how clearing the session's credential went. Waits
 * for the clear its release started, at most the teardown cap; a clear still running then is
 * reported `pending` (its outcome is logged, and the device stays quarantined until it settles).
 */
export async function screenLockRestoreResult(
  sessionId: string,
  options: Pick<ScreenLockSessionCleanupOptions, "registry" | "timer"> = {},
): Promise<{ screenLockRestore?: ScreenLockReleaseReport }> {
  const pending = (options.registry ?? defaultScreenLockRegistry).restoreReport(sessionId);
  if (!pending) {
    return {};
  }
  const report = await raceWithDeadline(pending, {
    timer: options.timer ?? defaultTimer,
    timeoutMs: SESSION_RELEASE_TEARDOWN_CAP_MS,
    unref: true,
    label: "screen lock restore report",
    timeoutError: () => REPORT_WAIT_TIMEOUT,
  }).catch((error: unknown) => {
    if (error !== REPORT_WAIT_TIMEOUT) {
      throw error;
    }
    return { status: "pending" as const };
  });
  return { screenLockRestore: report };
}

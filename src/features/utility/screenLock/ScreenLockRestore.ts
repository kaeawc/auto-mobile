import { DeviceLockRepository } from "../../../db/deviceLockRepository";
import { logger } from "../../../utils/logger";
import type { Timer } from "../../../utils/SystemTimer";
import type { LockSettingsClient, LockSettingsCommandResult } from "./AndroidLockSettings";
import type { SessionScreenLock } from "./ScreenLockRegistry";
import type { ScreenLockRestoreReport } from "./ScreenLockTypes";

const RESTORE_ATTEMPTS = 2;
const RESTORE_RETRY_DELAY_MS = 1_000;

/**
 * Drop the PIN `wakeAndUnlock` remembered for the device (`device_locks`): once AutoMobile has
 * changed or cleared the lock it is stale, and it must not outlive the credential on disk.
 */
export type ForgetRememberedUnlock = (deviceId: string) => Promise<void>;

export const defaultForgetRememberedUnlock: ForgetRememberedUnlock = (deviceId) =>
  new DeviceLockRepository().forget(deviceId);

export interface ScreenLockRestoreDependencies {
  timer: Pick<Timer, "sleep">;
  forgetRememberedUnlock: ForgetRememberedUnlock;
}

function leftoverFor(lock: SessionScreenLock): string {
  return (
    `Device ${lock.deviceId} may still have the ${lock.type} lock session ${lock.sessionId} set, ` +
    "which blocks every later session on it. Clear it with setDeviceState " +
    `screenLock {type: "none", currentCredential} using that ${lock.type}, or wipe the device data.`
  );
}

/**
 * Clear a released session's credential (`locksettings clear --old`), then confirm with a fresh
 * read. Never throws: a failure becomes a `failed` report the release result carries. A refused
 * old credential is not retried, because each refusal counts toward the device's lockout.
 */
export async function restoreSessionScreenLock(
  lock: SessionScreenLock,
  client: LockSettingsClient,
  dependencies: ScreenLockRestoreDependencies,
): Promise<ScreenLockRestoreReport> {
  let result: LockSettingsCommandResult = { outcome: "failed" };
  for (let attempt = 1; attempt <= RESTORE_ATTEMPTS; attempt++) {
    result = await client.clearCredential(lock.credential);
    if (["ok", "no_existing_credential", "credential_mismatch"].includes(result.outcome)) {
      break;
    }
    if (attempt < RESTORE_ATTEMPTS) {
      await dependencies.timer.sleep(RESTORE_RETRY_DELAY_MS);
    }
  }
  const base = { deviceId: lock.deviceId, type: lock.type };
  if (result.outcome !== "ok" && result.outcome !== "no_existing_credential") {
    const error =
      result.outcome === "credential_mismatch"
        ? "The device refused the credential the session set; it was changed outside AutoMobile."
        : `locksettings clear failed (${result.outcome}): ${result.detail ?? "no output"}`;
    logger.warn(`[screenLock] Failed to clear session ${lock.sessionId}'s lock: ${error}`);
    return { ...base, status: "failed", error, leftover: leftoverFor(lock) };
  }
  await dependencies.forgetRememberedUnlock(lock.deviceId);
  const reading = await client.read();
  if (reading.type === "none") {
    return { ...base, status: "cleared", verified: true };
  }
  if (reading.secure === true) {
    const error =
      "locksettings reported the lock cleared, but the device still reports a secure lock.";
    logger.warn(`[screenLock] Session ${lock.sessionId}: ${error}`);
    return { ...base, status: "failed", verified: false, error, leftover: leftoverFor(lock) };
  }
  return { ...base, status: "cleared" };
}

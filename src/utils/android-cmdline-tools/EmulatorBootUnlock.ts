import { logger } from "../logger";
import type { BootedDevice } from "../../models";
import type { Timer } from "../SystemTimer";
import { DeviceLockStore } from "../../devices/DeviceLockStore";
import type { AdbClientFactory } from "./AdbClientFactory";
import { AndroidWakeAndUnlock } from "./AndroidWakeAndUnlock";
import { throwIfReadinessAborted } from "./emulatorReadinessEvaluation";

const PRIMARY_USER_UNLOCK_WAIT_MS = 5_000;
const PRIMARY_USER_UNLOCK_POLL_INTERVAL_MS = 250;

/** Wakes a freshly booted emulator and dismisses its lock screen. */
export interface EmulatorBootUnlock {
  wakeAndUnlock(device: BootedDevice, signal?: AbortSignal): Promise<void>;
}

export interface EmulatorBootUnlockDeps {
  timer(): Timer;
  adbFactory(): AdbClientFactory;
}

export class DefaultEmulatorBootUnlock implements EmulatorBootUnlock {
  constructor(private readonly deps: EmulatorBootUnlockDeps) {}

  /**
   * Wake up the emulator and dismiss the lock screen after boot.
   * This ensures the device is immediately usable for automation.
   *
   * Delegates to the shared {@link AndroidWakeAndUnlock} implementation so boot uses the same
   * path as the `wakeAndUnlock` tool: a swipe lock is dismissed, and a secure
   * lock is unlocked with the PIN remembered for the device this session (if
   * any). A secure device with no remembered PIN is left locked — non-fatal, the
   * device is still ready and the user can unlock it with the tool (#4360).
   * @param device - The booted device to wake and unlock
   */
  async wakeAndUnlock(device: BootedDevice, signal?: AbortSignal): Promise<void> {
    try {
      const wakeAndUnlock = new AndroidWakeAndUnlock(device, this.deps.adbFactory(), {
        timer: this.deps.timer(),
        credentialStore: new DeviceLockStore(),
      });
      const result = await wakeAndUnlock.execute(undefined, signal);
      await this.waitForPrimaryUserUnlock(device, signal);
      if (!result.unlocked && result.secure) {
        logger.info(
          `[WakeAndUnlock] Device ${device.deviceId} is secure-locked and no PIN is remembered; ` +
            "leaving it locked. Unlock it once with the wakeAndUnlock tool (passing a pin) to remember it.",
        );
      } else {
        logger.info(
          `[WakeAndUnlock] Device ${device.deviceId} wake/unlock: ${JSON.stringify(result)}`,
        );
      }
    } catch (error) {
      throwIfReadinessAborted(signal);
      // Log but don't fail - the device is still ready, just might need manual interaction.
      // A secure lock with no remembered PIN throws ActionableError here; that is expected.
      logger.warn(`[WakeAndUnlock] Failed to wake/unlock device ${device.deviceId}: ${error}`);
    }
  }

  private async waitForPrimaryUserUnlock(
    device: BootedDevice,
    signal?: AbortSignal,
  ): Promise<void> {
    const adb = this.deps.adbFactory().create(device);
    const timer = this.deps.timer();
    let elapsedMs = 0;
    try {
      while (elapsedMs < PRIMARY_USER_UNLOCK_WAIT_MS) {
        throwIfReadinessAborted(signal);
        const users = await adb.listUsers(signal);
        const primaryUser = users.find(
          (user) => user.profileType === "primary" || user.userId === 0,
        );
        if (primaryUser?.startState !== "RUNNING_LOCKED") {
          return;
        }
        await timer.sleep(PRIMARY_USER_UNLOCK_POLL_INTERVAL_MS);
        elapsedMs += PRIMARY_USER_UNLOCK_POLL_INTERVAL_MS;
      }
      logger.warn(
        `[WakeAndUnlock] Primary user on ${device.deviceId} is still RUNNING_LOCKED after ` +
          `${PRIMARY_USER_UNLOCK_WAIT_MS}ms; CtrlProxy cannot bind until the device unlocks.`,
      );
    } catch (error) {
      // User-state inspection is supplementary; preserve the completed unlock result if unavailable.
      throwIfReadinessAborted(signal);
      logger.debug(
        `[WakeAndUnlock] Could not confirm primary-user unlock state for ${device.deviceId}: ${error}`,
      );
    }
  }
}

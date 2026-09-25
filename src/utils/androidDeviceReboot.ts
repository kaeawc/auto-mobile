import type { DeviceInfo } from "../models";
import type { Timer } from "./SystemTimer";
import { sequenceBackoff } from "./Backoff";
import { logger } from "./logger";

/**
 * What a reboot callback reports back to the retry policy. `"cancelled"`
 * means the recovery stopped before it touched the emulator (an ADB-reset
 * takeover, or an intentional shutdown such as `killDevice`) -- `run` must
 * not spend a crash-loop attempt on it (issue #7545). Anything else,
 * including a bare `void` return, is treated as a completed attempt.
 */
export type AndroidRebootAttemptOutcome = "cancelled" | "succeeded";

export interface AndroidDeviceReboot {
  run(
    target: DeviceInfo,
    reboot: () => Promise<AndroidRebootAttemptOutcome | void>,
  ): Promise<boolean>;
  /**
   * Forgets any tracked attempts for this target's AVD name, e.g. after the
   * AVD is deleted or re-provisioned so a same-named replacement does not
   * inherit a budget spent by an AVD that no longer exists (issue #7545).
   */
  clear(target: Pick<DeviceInfo, "platform" | "name">): void;
}

/**
 * How long a burst of crashes counts against the restart budget. Attempts
 * older than this are pruned before every check, so isolated crashes days
 * apart don't accumulate toward the same budget a genuine crash loop would
 * exhaust (issue #7545).
 */
export const DEFAULT_ANDROID_REBOOT_WINDOW_MS = 15 * 60 * 1000;

/**
 * Retries an emulator reboot a bounded number of times within a rolling time
 * window. DevicePool owns the lifecycle transition; this policy owns only
 * retry timing, the crash-loop budget, and error reporting.
 */
export class BoundedAndroidDeviceReboot implements AndroidDeviceReboot {
  private readonly backoff = sequenceBackoff([1_000]);
  // Attempt timestamps (ms) within the window, keyed by AVD target.
  private readonly attemptsByTarget: Map<string, number[]> = new Map();

  constructor(
    private readonly timer: Timer,
    private readonly maxAttempts: number = 2,
    private readonly windowMs: number = DEFAULT_ANDROID_REBOOT_WINDOW_MS,
  ) {}

  clear(target: Pick<DeviceInfo, "platform" | "name">): void {
    this.attemptsByTarget.delete(this.targetKey(target));
  }

  private targetKey(target: Pick<DeviceInfo, "platform" | "name">): string {
    return `${target.platform}:${target.name}`;
  }

  /** Prunes attempts outside the window and returns what remains, in order. */
  private attemptsInWindow(targetKey: string): number[] {
    const attempts = this.attemptsByTarget.get(targetKey);
    if (!attempts || attempts.length === 0) {
      return [];
    }
    const now = this.timer.now();
    const inWindow = attempts.filter((attemptAtMs) => now - attemptAtMs < this.windowMs);
    if (inWindow.length !== attempts.length) {
      this.attemptsByTarget.set(targetKey, inWindow);
    }
    return inWindow;
  }

  async run(
    target: DeviceInfo,
    reboot: () => Promise<AndroidRebootAttemptOutcome | void>,
  ): Promise<boolean> {
    const targetKey = this.targetKey(target);
    let attempts = this.attemptsInWindow(targetKey);
    if (attempts.length >= this.maxAttempts) {
      const windowMinutes = Math.max(1, Math.round(this.windowMs / 60_000));
      logger.warn(
        `[Android reboot] Restart budget exhausted for ${target.name} ` +
          `(${attempts.length}/${this.maxAttempts} within the last ${windowMinutes}m). ` +
          "Recovery is disabled for this AVD until an attempt ages out of the window; " +
          "raise AUTOMOBILE_DEVICE_RECOVERY_MAX_ATTEMPTS or restart the daemon to reset it sooner.",
      );
      return false;
    }

    if (attempts.length > 0) {
      await this.timer.sleep(this.backoff.delayForAttempt(attempts.length));
    }

    while (attempts.length < this.maxAttempts) {
      const attemptNumber = attempts.length + 1;
      attempts = [...attempts, this.timer.now()];
      this.attemptsByTarget.set(targetKey, attempts);
      try {
        const outcome = await reboot();
        if (outcome === "cancelled") {
          // Refund: the recovery never touched the emulator, so it should
          // not count against the crash-loop budget (issue #7545).
          attempts = attempts.slice(0, -1);
          this.attemptsByTarget.set(targetKey, attempts);
          return false;
        }
        return true;
      } catch (error) {
        logger.warn(
          `[Android reboot] Failed to restart ${target.name} (attempt ${attemptNumber}/${this.maxAttempts}): ${error}`,
          error,
        );
        if (attempts.length < this.maxAttempts) {
          await this.timer.sleep(this.backoff.delayForAttempt(attempts.length));
        }
      }
    }
    return false;
  }
}

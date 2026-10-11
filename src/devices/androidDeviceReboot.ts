import type { DeviceInfo } from "../models";
import { BootCapacityExhaustedError } from "../models/BootCapacityExhaustedError";
import { BootedDeviceDiscoveryIncompleteError } from "../models/BootedDeviceDiscoveryIncompleteError";
import { DEFAULT_ADMISSION_RETRY_AFTER_MS } from "../features/bootAdmission/BootAdmissionGate";
import { DEFAULT_DEVICE_READY_TIMEOUT_MS } from "../utils/deviceTimeouts";
import type { Timer } from "../utils/SystemTimer";
import { sequenceBackoff } from "../utils/Backoff";
import { logger } from "../utils/logger";

/**
 * What a reboot callback reports back to the retry policy. `"cancelled"`
 * means the recovery stopped before it touched the emulator (an ADB-reset
 * takeover, or an intentional shutdown such as `killDevice`) -- `run` must
 * not spend a crash-loop attempt on it (issue #7545). Anything else,
 * including a bare `void` return, is treated as a completed attempt.
 */
export type AndroidRebootAttemptOutcome = "cancelled" | "succeeded";

/** Admission refused before an emulator existed; this is not a crashed launch (#11691). */
export function isBootAdmissionRefusal(
  error: unknown,
): error is BootCapacityExhaustedError | BootedDeviceDiscoveryIncompleteError {
  return (
    error instanceof BootCapacityExhaustedError ||
    error instanceof BootedDeviceDiscoveryIncompleteError
  );
}

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
    private readonly admissionRecoveryWindowMs: number = DEFAULT_DEVICE_READY_TIMEOUT_MS,
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

  /** Retry admission within its own window, separately from the crash backoff. */
  private async waitForAdmissionRetry(
    target: DeviceInfo,
    refusal: BootCapacityExhaustedError | BootedDeviceDiscoveryIncompleteError,
    deadlineMs: number,
  ): Promise<boolean> {
    const remainingMs = Math.max(0, deadlineMs - this.timer.now());
    const retryAfterMs =
      "retryAfterMs" in refusal ? refusal.retryAfterMs : DEFAULT_ADMISSION_RETRY_AFTER_MS;
    logger.warn(
      `[Android reboot] Restart admission refused for ${target.name}: ${refusal.code}; ` +
        `boot capacity/discovery retry in ${Math.min(retryAfterMs, remainingMs)}ms`,
      refusal,
    );
    await this.timer.sleep(Math.min(retryAfterMs, remainingMs));
    if (this.timer.now() >= deadlineMs) {
      logger.warn(
        `[Android reboot] Boot capacity/discovery recovery window exhausted for ${target.name}: ${refusal.code}`,
      );
      return false;
    }
    return true;
  }

  async run(
    target: DeviceInfo,
    reboot: () => Promise<AndroidRebootAttemptOutcome | void>,
  ): Promise<boolean> {
    const targetKey = this.targetKey(target);
    let admissionDeadlineMs: number | undefined;
    let retryAdmission = true;
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
      attempts = this.attemptsInWindow(targetKey);
    }

    while (attempts.length < this.maxAttempts && retryAdmission) {
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
        if (isBootAdmissionRefusal(error)) {
          // Like cancellation, admission never touched the emulator: refund this timestamp.
          attempts = attempts.slice(0, -1);
          this.attemptsByTarget.set(targetKey, attempts);
          admissionDeadlineMs ??= this.timer.now() + this.admissionRecoveryWindowMs;
          retryAdmission = await this.waitForAdmissionRetry(target, error, admissionDeadlineMs);
          attempts = this.attemptsInWindow(targetKey);
          continue;
        }
        logger.warn(
          `[Android reboot] Failed to restart ${target.name} (attempt ${attemptNumber}/${this.maxAttempts}): ${error}`,
          error,
        );
        if (attempts.length < this.maxAttempts) {
          await this.timer.sleep(this.backoff.delayForAttempt(attempts.length));
          attempts = this.attemptsInWindow(targetKey);
        }
      }
    }
    return false;
  }
}

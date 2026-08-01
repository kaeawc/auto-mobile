import type { DeviceInfo } from "../models";
import type { Timer } from "./SystemTimer";
import { sequenceBackoff } from "./Backoff";
import { logger } from "./logger";

export interface AndroidDeviceReboot {
  run(target: DeviceInfo, reboot: () => Promise<void>): Promise<boolean>;
}

/**
 * Retries an emulator reboot a bounded number of times. DevicePool owns the
 * lifecycle transition; this policy owns only retry timing and error reporting.
 */
export class BoundedAndroidDeviceReboot implements AndroidDeviceReboot {
  private readonly backoff = sequenceBackoff([1_000]);
  private readonly attemptsByTarget: Map<string, number> = new Map();

  constructor(
    private readonly timer: Timer,
    private readonly maxAttempts: number = 2,
  ) {}

  async run(target: DeviceInfo, reboot: () => Promise<void>): Promise<boolean> {
    const targetKey = `${target.platform}:${target.name}`;
    let attempts = this.attemptsByTarget.get(targetKey) ?? 0;
    if (attempts >= this.maxAttempts) {
      logger.warn(
        `[Android reboot] Restart budget exhausted for ${target.name} (${attempts}/${this.maxAttempts})`
      );
      return false;
    }

    if (attempts > 0) {
      await this.timer.sleep(this.backoff.delayForAttempt(attempts));
    }

    while (attempts < this.maxAttempts) {
      attempts++;
      this.attemptsByTarget.set(targetKey, attempts);
      try {
        await reboot();
        return true;
      } catch (error) {
        logger.warn(
          `[Android reboot] Failed to restart ${target.name} (attempt ${attempts}/${this.maxAttempts}): ${error}`,
          error
        );
        if (attempts < this.maxAttempts) {
          await this.timer.sleep(this.backoff.delayForAttempt(attempts));
        }
      }
    }
    return false;
  }
}

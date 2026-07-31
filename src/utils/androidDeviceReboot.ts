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

  constructor(
    private readonly timer: Timer,
    private readonly maxAttempts: number = 2,
  ) {}

  async run(target: DeviceInfo, reboot: () => Promise<void>): Promise<boolean> {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        await reboot();
        return true;
      } catch (error) {
        logger.warn(
          `[Android reboot] Failed to restart ${target.name} (attempt ${attempt}/${this.maxAttempts}): ${error}`,
          error
        );
        if (attempt < this.maxAttempts) {
          await this.timer.sleep(this.backoff.delayForAttempt(attempt));
        }
      }
    }
    return false;
  }
}

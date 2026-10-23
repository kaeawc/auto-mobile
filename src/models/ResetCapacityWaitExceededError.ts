import { ActionableError } from "./ActionableError";
import type { BootCapacityExhaustedError } from "./BootCapacityExhaustedError";
import type { Platform } from "./Platform";

export interface ResetCapacityWaitExceededDetails {
  platform: Platform;
  deviceId: string;
  waitedMs: number;
  limit: number;
  booted: number;
  externalDevices?: string[];
  heldDevices?: string[];
}

/** Capacity stayed full through a reset's bounded reservation wait. */
export class ResetCapacityWaitExceededError extends ActionableError {
  readonly code = "reset_capacity_wait_exceeded";
  readonly details: ResetCapacityWaitExceededDetails;

  constructor(deviceId: string, waitedMs: number, cause: BootCapacityExhaustedError) {
    const { platform, limit, booted, externalDevices, heldDevices } = cause.details;
    const external = externalDevices?.length
      ? ` Simulators with no AutoMobile owner still counting toward the limit: ${externalDevices.join(", ")}.`
      : "";
    super(
      `Gave up after ${waitedMs / 1000}s waiting for iOS simulator capacity to re-boot reset simulator ${deviceId}: ${booted} simulator(s) booted, limit is ${limit}.${external} Shut them down (xcrun simctl shutdown <udid>) or raise AUTOMOBILE_IOS_SIM_MAX_BOOTED.`,
      { cause },
    );
    this.name = "ResetCapacityWaitExceededError";
    this.details = { platform, deviceId, waitedMs, limit, booted, externalDevices, heldDevices };
  }
}

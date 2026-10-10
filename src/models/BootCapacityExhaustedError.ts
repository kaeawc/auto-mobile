import { ActionableError } from "./ActionableError";
import type { Platform } from "./Platform";

/** Wire code for a boot refused because the platform's booted-device limit stayed full (#11181). */
export const BOOT_CAPACITY_EXHAUSTED_CODE = "capacity_exhausted";

export interface BootCapacityExhaustedDetails {
  code: typeof BOOT_CAPACITY_EXHAUSTED_CODE;
  retryable: true;
  /** Suggested wait before retrying the boot. */
  retryAfterMs: number;
  /** The platform's booted-device limit when the wait ended. */
  limit: number;
  /** Booted devices (including admitted boots in flight) counted against the limit. */
  booted: number;
  platform: Platform;
  /** Counted devices AutoMobile did not start; present only when there are any. */
  externalDevices?: string[];
}

/**
 * A cold boot waited for the boot admission gate until its deadline and the
 * platform never had capacity. Retryable: capacity frees when another device
 * shuts down, without the caller doing anything.
 */
export class BootCapacityExhaustedError extends ActionableError {
  readonly code = BOOT_CAPACITY_EXHAUSTED_CODE;
  readonly retryable = true;
  readonly details: BootCapacityExhaustedDetails;

  constructor(details: Omit<BootCapacityExhaustedDetails, "code" | "retryable">, message: string) {
    super(message);
    this.name = "BootCapacityExhaustedError";
    this.details = { ...details, code: BOOT_CAPACITY_EXHAUSTED_CODE, retryable: true };
  }

  get retryAfterMs(): number {
    return this.details.retryAfterMs;
  }

  get limit(): number {
    return this.details.limit;
  }

  get booted(): number {
    return this.details.booted;
  }

  get platform(): Platform {
    return this.details.platform;
  }
}

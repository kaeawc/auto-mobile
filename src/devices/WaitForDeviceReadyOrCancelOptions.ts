import type { AndroidEmulatorReadinessOptions } from "../utils/android-cmdline-tools/AndroidEmulatorClient";
import type { Timer } from "../utils/SystemTimer";

export interface WaitForDeviceReadyOrCancelOptions {
  /** Readiness timeout; defaults to `DEFAULT_DEVICE_READY_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Cancellation signal for a non-cooperative readiness wait; defaults to the ambient signal. */
  signal?: AbortSignal;
  timer?: Pick<Timer, "setTimeout" | "clearTimeout">;
  /**
   * Idempotent cleanup for the owned launch handle. Async cleanup is awaited so lifecycle
   * owners can retain their lease until the launch process settles.
   */
  cancelOwnedBoot?: () => void | Promise<void>;
  createTimeoutError?: () => Error;
  readinessOptions?: AndroidEmulatorReadinessOptions;
}

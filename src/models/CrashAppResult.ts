import { BaseActionResult } from "./BaseActionResult";
import type { Platform } from "./Platform";

export type CrashAppMechanism =
  | "android_am_crash"
  | "ios_simulator_sigabrt"
  | "ios_device_sigabrt"
  | "unsupported";

export interface CrashAppEvidence {
  /** `none`: physical iOS, where crash reports cannot be read yet (#14103); see `summary`. */
  source: "android_logcat" | "ios_unified_log" | "none";
  summary: string;
}

/**
 * Stable result of an intentional application-crash request.
 *
 * `success` and `confirmed` require fresh OS crash evidence for the target
 * process, not merely command dispatch or process disappearance. The one
 * exception is physical iOS (#14096): there `success` means SIGABRT was delivered
 * and the process exited, `confirmed` stays false, and `evidence.source` is
 * `none` until crash reports can be read from the device (#14103).
 */
export interface CrashAppResult extends BaseActionResult {
  supported: boolean;
  platform: Platform;
  appId: string;
  processId?: number;
  mechanism: CrashAppMechanism;
  /** Epoch milliseconds when crash induction was attempted. */
  timestamp: number;
  /** Whether a target process was running. Omitted when preflight failed. */
  wasRunning?: boolean;
  confirmed: boolean;
  evidence?: CrashAppEvidence;
  /** Android user/profile targeted by ActivityManager. */
  userId?: number;
}

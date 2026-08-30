import { BaseActionResult } from "./BaseActionResult";
import type { Platform } from "./Platform";

export type CrashAppMechanism = "android_am_crash" | "ios_simulator_sigabrt" | "unsupported";

export interface CrashAppEvidence {
  source: "android_logcat" | "ios_unified_log";
  summary: string;
}

/**
 * Stable result of an intentional application-crash request.
 *
 * `success` means the crash-induction command was accepted. `confirmed` is
 * stricter: it requires OS crash evidence for the target process, not merely
 * that the process disappeared.
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

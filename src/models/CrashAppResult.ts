import { BaseActionResult } from "./BaseActionResult";
import type { Platform } from "./Platform";

export type CrashAppMechanism = "android_am_crash" | "ios_simulator_sigabrt" | "unsupported";

export interface CrashAppEvidence {
  source: "android_logcat" | "ios_unified_log" | "android_dropbox" | "ios_crash_report";
  summary: string;
}

/**
 * The OS crash report for the crashed process (#14103): an `.ips` on iOS
 * Simulator, a dropbox entry on Android. Bounded: no raw report body.
 */
export type CrashAppCrashReport =
  | {
      status: "found";
      source: "ios_ips" | "android_dropbox";
      reportPath: string;
      exceptionType: string;
      exceptionCode?: string;
      exceptionMessage?: string;
      terminationReason?: string;
      appVersion?: string;
      /** Crashing-thread top frames, innermost first. */
      frames: string[];
      /** The `automobile:failures` occurrence recorded for this report. */
      failureOccurrenceId?: string;
    }
  | { status: "notFound" }
  | { status: "unsupported"; reason: string };

/**
 * Stable result of an intentional application-crash request.
 *
 * `success` and `confirmed` require fresh OS crash evidence for the target
 * process, not merely command dispatch or process disappearance.
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
  crashReport?: CrashAppCrashReport;
  /** Android user/profile targeted by ActivityManager. */
  userId?: number;
}

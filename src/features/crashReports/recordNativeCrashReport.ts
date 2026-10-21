import type { FailureRecorderService } from "../failures/interfaces/FailureRecorderService";
import type { NativeCrashReport } from "./NativeCrashReport";

export type CrashReportRecorder = Pick<FailureRecorderService, "recordCrash">;

/**
 * Record an OS crash report as a `crash` entry in `automobile:failures`. The
 * message carries the exception code and termination reason; the stack is the
 * crashing thread's bounded frames.
 */
export function recordNativeCrashReport(
  recorder: CrashReportRecorder,
  deviceId: string,
  report: NativeCrashReport,
): Promise<string> {
  const message = [
    report.exceptionMessage,
    report.exceptionCode && `codes: ${report.exceptionCode}`,
    report.terminationReason && `termination: ${report.terminationReason}`,
    `report: ${report.reportPath}`,
  ]
    .filter(Boolean)
    .join("\n");
  return recorder.recordCrash({
    exceptionType: report.exceptionType,
    exceptionMessage: message,
    stackTrace: report.frames,
    deviceId,
    deviceModel: report.deviceModel ?? (report.platform === "ios" ? "iOS" : "Android"),
    os: report.osVersion ?? (report.platform === "ios" ? "iOS" : "Android"),
    appVersion: report.appVersion ?? "unknown",
    sessionId: `crash-report:${report.id}`,
  });
}

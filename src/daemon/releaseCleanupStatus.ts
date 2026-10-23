import type { KeepAwakeRestoreReport } from "../utils/KeepScreenAwakeManager";
import type { PowerReleaseReport } from "./powerSessionCleanup";
import type { ScreenLockReleaseReport } from "./screenLockSessionCleanup";

interface ReleaseRestoreStatuses {
  keepAwakeRestore?: Pick<KeepAwakeRestoreReport, "status">;
  screenLockRestore?: Pick<ScreenLockReleaseReport, "status">;
  powerRestore?: Pick<PowerReleaseReport, "status">;
}

/** Incomplete restoration only; a failure takes precedence over work still pending. */
export function releaseCleanupStatus(
  reports: ReleaseRestoreStatuses,
): "pending" | "failed" | undefined {
  const statuses = [
    reports.keepAwakeRestore?.status,
    reports.screenLockRestore?.status,
    reports.powerRestore?.status,
  ];
  if (statuses.includes("failed") || statuses.includes("partial")) {
    return "failed";
  }
  return statuses.includes("pending") ? "pending" : undefined;
}

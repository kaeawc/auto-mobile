import { removeDeviceFile, type PerfettoAdb } from "../performanceTrace/perfettoDevice";
import type { SessionProfilingState } from "./ProfilingRegistry";

/** What cleaning up one released session's profiling state did. */
export interface ProfilingCleanupReport {
  deviceId: string;
  removedFiles: string[];
  /** One entry per step that failed; the rest still ran. */
  errors: string[];
}

/**
 * Delete the heap dump device files a released session left behind (#14113). Every file is
 * attempted even if an earlier one failed, and nothing here throws: the device must not stay
 * quarantined on account of a cleanup that cannot finish.
 */
export async function cleanupSessionProfiling(
  deviceId: string,
  state: SessionProfilingState,
  adb: PerfettoAdb,
): Promise<ProfilingCleanupReport> {
  const report: ProfilingCleanupReport = { deviceId, removedFiles: [], errors: [] };
  for (const file of state.deviceFiles) {
    if (await removeDeviceFile(adb, file.remotePath, "profiling")) {
      report.removedFiles.push(file.remotePath);
    } else {
      report.errors.push(`remove ${file.remotePath}: failed`);
    }
  }
  return report;
}

import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { Timer } from "../../utils/SystemTimer";
import {
  removeDeviceFile,
  stopPerfettoRecorder,
  type PerfettoAdb,
  type PerfettoPollOptions,
} from "../performanceTrace/perfettoDevice";
import type { SessionProfilingState } from "./ProfilingRegistry";

/** What cleaning up one released session's profiling state did. */
export interface ProfilingCleanupReport {
  deviceId: string;
  stoppedTraces: string[];
  removedFiles: string[];
  /** One entry per step that failed; the rest still ran. */
  errors: string[];
}

/**
 * Stop the trace recorders a released session left running and delete the device files it left
 * behind (#14113). Nobody is waiting for an orphaned trace, so its data is discarded, not pulled.
 * Every step is attempted even if an earlier one failed, and nothing here throws: the device
 * must not stay quarantined on account of a cleanup that cannot finish.
 */
export async function cleanupSessionProfiling(
  deviceId: string,
  state: SessionProfilingState,
  adb: PerfettoAdb,
  timer: Pick<Timer, "sleep">,
  poll?: PerfettoPollOptions,
): Promise<ProfilingCleanupReport> {
  const report: ProfilingCleanupReport = {
    deviceId,
    stoppedTraces: [],
    removedFiles: [],
    errors: [],
  };
  for (const trace of state.traces) {
    try {
      await stopPerfettoRecorder(adb, timer, trace.pid, [], poll);
      report.stoppedTraces.push(trace.traceId);
    } catch (error) {
      report.errors.push(`stop ${trace.traceId}: ${errorMessage(error)}`);
      logger.warn(`[profiling] failed to stop trace ${trace.traceId} on ${deviceId}`, error);
    }
    // removeDeviceFile logs and swallows its own failure, so the file is always attempted.
    await removeDeviceFile(adb, trace.remotePath, "profiling");
    report.removedFiles.push(trace.remotePath);
  }
  for (const file of state.deviceFiles) {
    await removeDeviceFile(adb, file.remotePath, "profiling");
    report.removedFiles.push(file.remotePath);
  }
  return report;
}

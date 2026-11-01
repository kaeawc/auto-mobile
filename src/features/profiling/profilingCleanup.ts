import { runOutsideRequestContext } from "../../utils/AbortContext";
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

async function removeFile(
  adb: PerfettoAdb,
  remotePath: string,
  report: ProfilingCleanupReport,
): Promise<void> {
  if (await removeDeviceFile(adb, remotePath, "profiling")) {
    report.removedFiles.push(remotePath);
  } else {
    report.errors.push(`remove ${remotePath}: failed`);
  }
}

/**
 * Stop the trace recorders a released session left running and delete the device files it left
 * behind (#14113). Nobody is waiting for an orphaned trace, so its data is discarded, not pulled.
 * Every step is attempted even if an earlier one failed, and nothing here throws: the device
 * must not stay quarantined on account of a cleanup that cannot finish.
 */
export function cleanupSessionProfiling(
  deviceId: string,
  state: SessionProfilingState,
  adb: PerfettoAdb,
  { timer, poll }: { timer: Pick<Timer, "sleep">; poll?: PerfettoPollOptions },
): Promise<ProfilingCleanupReport> {
  // Called from inside a request when a start finishes late: a cancelled request must not abort it.
  return runOutsideRequestContext(() => cleanupAll(deviceId, state, adb, { timer, poll }));
}

async function cleanupAll(
  deviceId: string,
  state: SessionProfilingState,
  adb: PerfettoAdb,
  { timer, poll }: { timer: Pick<Timer, "sleep">; poll?: PerfettoPollOptions },
): Promise<ProfilingCleanupReport> {
  const report: ProfilingCleanupReport = {
    deviceId,
    stoppedTraces: [],
    removedFiles: [],
    errors: [],
  };
  for (const trace of state.traces) {
    try {
      await stopPerfettoRecorder(adb, timer, trace.pid, { warnings: [], poll });
      report.stoppedTraces.push(trace.traceId);
    } catch (error) {
      report.errors.push(`stop ${trace.traceId}: ${errorMessage(error)}`);
      logger.warn(`[profiling] failed to stop trace ${trace.traceId} on ${deviceId}`, error);
    }
    await removeFile(adb, trace.remotePath, report);
  }
  for (const file of state.deviceFiles) {
    await removeFile(adb, file.remotePath, report);
  }
  return report;
}

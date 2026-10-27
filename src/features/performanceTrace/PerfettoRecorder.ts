import { join } from "node:path";
import type { BootedDevice } from "../../models";
import type { Timer } from "../../utils/SystemTimer";
import {
  awaitFlushedDeviceFile,
  DEVICE_TRACE_DIR,
  PULL_TIMEOUT_MS,
  removeDeviceFile,
  startPerfettoRecorder,
  stopPerfettoRecorder,
  type PerfettoAdb,
  type PerfettoPollOptions,
} from "./perfettoDevice";
import { summarizePerfettoTrace, type PerfettoTraceProcessor } from "./perfettoTraceProcessor";
import type {
  PerformanceTraceRecorder,
  RecordingPerformanceTrace,
  StartPerformanceTraceRequest,
} from "./PerformanceTraceRecorder";
import { perfettoTraceConfig } from "./performanceTraceTemplates";

export { parsePerfettoBackgroundPid, type PerfettoAdb } from "./perfettoDevice";

export interface PerfettoRecorderDependencies extends PerfettoPollOptions {
  adbFor(device: BootedDevice): PerfettoAdb;
  /** Host trace processor, or `undefined` when none is installed. */
  traceProcessor(): Promise<PerfettoTraceProcessor | undefined>;
  timer: Pick<Timer, "sleep">;
}

const LOG_TAG = "performanceTrace";

/**
 * Records a Perfetto trace on an Android device (#14102). The config is passed
 * through stdin (base64, so no quoting can break it); `duration_ms` bounds the
 * recorder on the device itself, and stop sends SIGTERM so perfetto flushes.
 */
export class PerfettoRecorder implements PerformanceTraceRecorder {
  constructor(private readonly deps: PerfettoRecorderDependencies) {}

  async start(request: StartPerformanceTraceRequest): Promise<RecordingPerformanceTrace> {
    const adb = this.deps.adbFor(request.device);
    const fileName = `automobile-${request.traceId}.perfetto-trace`;
    const remotePath = `${DEVICE_TRACE_DIR}/${fileName}`;
    const pid = await startPerfettoRecorder(
      adb,
      request.device.deviceId,
      perfettoTraceConfig(request.template, request.appId, request.timeLimitMs),
      remotePath,
      request.signal,
    );
    const warnings: string[] = [];
    if (!request.appId) {
      warnings.push("No appId was given; app-scoped atrace and summaries are disabled.");
    }
    return this.recording(
      adb,
      pid,
      remotePath,
      join(request.artifactDir, fileName),
      request,
      warnings,
    );
  }

  private recording(
    adb: PerfettoAdb,
    pid: number,
    remotePath: string,
    artifactPath: string,
    request: StartPerformanceTraceRequest,
    warnings: string[],
  ): RecordingPerformanceTrace {
    return {
      artifactPath,
      warnings,
      stop: async (signal) => {
        await stopPerfettoRecorder(adb, this.deps.timer, pid, warnings, this.deps, signal);
        await awaitFlushedDeviceFile(adb, this.deps.timer, remotePath, this.deps, LOG_TAG, signal);
        await adb.execute(["pull", remotePath, artifactPath], {
          timeoutMs: PULL_TIMEOUT_MS,
          noRetry: true,
          signal,
        });
        await removeDeviceFile(adb, remotePath, LOG_TAG);
      },
      summarize: async (signal) => {
        const processor = await this.deps.traceProcessor();
        if (!processor) {
          return {
            summary: {},
            warnings: [
              "trace_processor_shell was not found on the host; install Perfetto's trace processor " +
                "(or set AUTOMOBILE_TRACE_PROCESSOR) to get a summary. The trace artifact is complete.",
            ],
          };
        }
        return summarizePerfettoTrace(
          processor,
          artifactPath,
          request.template,
          request.appId,
          signal,
        );
      },
    };
  }
}

import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { BootedDevice } from "../../models";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { Timer } from "../../utils/SystemTimer";
import { defaultProfilingRegistry, type ProfilingRegistry } from "../profiling/ProfilingRegistry";
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
import { perfettoCategoryConfig } from "./perfettoCategoryConfig";
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
  /** Where a device trace file a stop could not remove is recorded for session release cleanup. */
  registry?: Pick<ProfilingRegistry, "addDeviceFile">;
  /** Delete a partial host artifact after a failed pull; absence is not an error. */
  removeHostFile?: (path: string) => Promise<void>;
}

const LOG_TAG = "performanceTrace";

/** Category traces record what the caller chose, which no template summary query fits. */
export const CATEGORY_TRACE_NO_SUMMARY_WARNING =
  "Category traces have no summary; open the artifact in Perfetto UI or trace_processor.";

async function removeHostFile(path: string): Promise<void> {
  try {
    await rm(path, { force: true });
  } catch (error) {
    logger.warn(
      `[performanceTrace] failed to remove partial trace ${path}: ${errorMessage(error)}`,
      error,
    );
  }
}

/** The text config for a template or category request. */
function traceConfigFor(request: StartPerformanceTraceRequest): string {
  return request.categoryConfig
    ? perfettoCategoryConfig(request.categoryConfig)
    : perfettoTraceConfig(request.template, request.appId, request.timeLimitMs);
}

/**
 * Records a Perfetto trace on an Android device (#14102), shaped by a template or by typed
 * categories (#18688). The config is passed through stdin (base64, so no quoting can break it);
 * `duration_ms` bounds the recorder on the device itself, and stop sends SIGTERM so perfetto
 * flushes. Once signalled, the device copy is always removed, pulled or not.
 */
export class PerfettoRecorder implements PerformanceTraceRecorder {
  constructor(private readonly deps: PerfettoRecorderDependencies) {}

  async start(request: StartPerformanceTraceRequest): Promise<RecordingPerformanceTrace> {
    const adb = this.deps.adbFor(request.device);
    const fileName = `automobile-${request.traceId}.perfetto-trace`;
    const remotePath = `${DEVICE_TRACE_DIR}/${fileName}`;
    const pid = await startPerfettoRecorder(adb, request.device.deviceId, traceConfigFor(request), {
      remotePath,
      signal: request.signal,
    });
    const warnings: string[] = [];
    if (!request.appId) {
      warnings.push(
        request.categoryConfig
          ? "No appId was given; app-scoped atrace tags are disabled."
          : "No appId was given; app-scoped atrace and summaries are disabled.",
      );
    }
    return this.recording(
      adb,
      { pid, remotePath, artifactPath: join(request.artifactDir, fileName) },
      request,
      warnings,
    );
  }

  private recording(
    adb: PerfettoAdb,
    { pid, remotePath, artifactPath }: { pid: number; remotePath: string; artifactPath: string },
    request: StartPerformanceTraceRequest,
    warnings: string[],
  ): RecordingPerformanceTrace {
    let signalled = false;
    return {
      artifactPath,
      warnings,
      get signalled() {
        return signalled;
      },
      stop: async (signal) => {
        // Until the SIGTERM reaches the device the recorder is still running: a failure here leaves
        // the trace for a retry or release cleanup, and its file must stay for that stop to fill.
        await stopPerfettoRecorder(adb, this.deps.timer, pid, {
          warnings,
          poll: this.deps,
          signal,
          onSignalled: () => {
            signalled = true;
          },
        });
        try {
          await awaitFlushedDeviceFile(adb, this.deps.timer, remotePath, {
            logTag: LOG_TAG,
            poll: this.deps,
            signal,
          });
          await adb.execute(["pull", remotePath, artifactPath], {
            timeoutMs: PULL_TIMEOUT_MS,
            noRetry: true,
            signal,
          });
        } catch (error) {
          await (this.deps.removeHostFile ?? removeHostFile)(artifactPath);
          throw error;
        } finally {
          await this.removeRemote(adb, remotePath, request);
        }
      },
      summarize: async (signal) => {
        if (!request.template) {
          return { summary: {}, warnings: [CATEGORY_TRACE_NO_SUMMARY_WARNING] };
        }
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
        return summarizePerfettoTrace(processor, artifactPath, request.template, {
          appId: request.appId,
          signal,
        });
      },
    };
  }

  /** Delete the device copy; one that will not go is left to the owning session's release. */
  private async removeRemote(
    adb: PerfettoAdb,
    remotePath: string,
    request: StartPerformanceTraceRequest,
  ): Promise<void> {
    if (await removeDeviceFile(adb, remotePath, LOG_TAG)) {
      return;
    }
    (this.deps.registry ?? defaultProfilingRegistry).addDeviceFile({
      deviceId: request.device.deviceId,
      sessionId: request.ownerSessionUuid,
      remotePath,
    });
  }
}

import { join } from "node:path";
import { ActionableError, type BootedDevice } from "../../models";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { Timer } from "../../utils/SystemTimer";
import { summarizePerfettoTrace, type PerfettoTraceProcessor } from "./perfettoTraceProcessor";
import type {
  PerformanceTraceRecorder,
  RecordingPerformanceTrace,
  StartPerformanceTraceRequest,
} from "./PerformanceTraceRecorder";
import { perfettoTraceConfig } from "./performanceTraceTemplates";

export type PerfettoAdb = Pick<AdbExecutor, "execute">;

export interface PerfettoRecorderDependencies {
  adbFor(device: BootedDevice): PerfettoAdb;
  /** Host trace processor, or `undefined` when none is installed. */
  traceProcessor(): Promise<PerfettoTraceProcessor | undefined>;
  timer: Pick<Timer, "sleep">;
  /** Polls of `kill -0` after SIGTERM before giving up on a clean flush. */
  stopPollAttempts?: number;
  stopPollIntervalMs?: number;
  /** Polls of the device trace size before giving up on perfetto writing the file. */
  flushPollAttempts?: number;
  flushPollIntervalMs?: number;
}

/** Perfetto may only write traces here on user builds (Android 12+ SELinux policy). */
const DEVICE_TRACE_DIR = "/data/misc/perfetto-traces";
const ADB_TIMEOUT_MS = 15_000;
const PULL_TIMEOUT_MS = 120_000;

/** `perfetto --background` prints the detached recorder's pid as its last line. */
export function parsePerfettoBackgroundPid(output: string): number | undefined {
  const pid = output
    .trim()
    .split(/\s+/)
    .map(Number)
    .filter((value) => Number.isInteger(value) && value > 0)
    .at(-1);
  return pid;
}

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
    const config = Buffer.from(
      perfettoTraceConfig(request.template, request.appId, request.timeLimitMs),
    ).toString("base64");
    const started = await adb.execute(
      ["shell", `echo ${config} | base64 -d | perfetto --background --txt -c - -o ${remotePath}`],
      { timeoutMs: ADB_TIMEOUT_MS, noRetry: true, signal: request.signal },
    );
    const pid = parsePerfettoBackgroundPid(started.stdout);
    if (pid === undefined) {
      throw new ActionableError(
        `perfetto did not start on ${request.device.deviceId}: ${`${started.stdout}\n${started.stderr}`.trim()}`,
      );
    }
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
        await this.stopRecorder(adb, pid, warnings, signal);
        await this.awaitFlushedTrace(adb, remotePath, signal);
        await adb.execute(["pull", remotePath, artifactPath], {
          timeoutMs: PULL_TIMEOUT_MS,
          noRetry: true,
          signal,
        });
        await this.removeRemote(adb, remotePath);
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

  private async stopRecorder(
    adb: PerfettoAdb,
    pid: number,
    warnings: string[],
    signal?: AbortSignal,
  ): Promise<void> {
    const options = { timeoutMs: ADB_TIMEOUT_MS, noRetry: true, signal };
    // Exits 0 either way: an already-finished recorder (its duration elapsed) is not an error.
    await adb.execute(["shell", `kill -TERM ${pid} 2>/dev/null; true`], options);
    const attempts = this.deps.stopPollAttempts ?? 40;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const probe = await adb.execute(
        ["shell", `kill -0 ${pid} 2>/dev/null && echo running || echo stopped`],
        options,
      );
      if (probe.stdout.includes("stopped")) {
        return;
      }
      await this.deps.timer.sleep(this.deps.stopPollIntervalMs ?? 250);
    }
    warnings.push(`perfetto (pid ${pid}) did not exit after SIGTERM; the trace may be incomplete.`);
  }

  /**
   * perfetto can exit (or vanish from `kill -0`) a second or two before the trace
   * file holds data (#14737), so wait for a non-zero size that holds across two polls.
   */
  private async awaitFlushedTrace(
    adb: PerfettoAdb,
    remotePath: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const options = { timeoutMs: ADB_TIMEOUT_MS, noRetry: true, signal };
    const attempts = this.deps.flushPollAttempts ?? 40;
    let previous = 0;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const probe = await adb.execute(
        ["shell", `wc -c < ${remotePath} 2>/dev/null || echo 0`],
        options,
      );
      const size = Number.parseInt(probe.stdout.trim(), 10) || 0;
      if (size > 0 && size === previous) {
        return;
      }
      previous = size;
      await this.deps.timer.sleep(this.deps.flushPollIntervalMs ?? 250);
    }
    await this.removeRemote(adb, remotePath);
    throw new ActionableError(
      previous === 0
        ? `perfetto wrote no data to ${remotePath} after it stopped; the trace is empty.`
        : `perfetto was still growing ${remotePath} (${previous} bytes) after waiting for it to flush.`,
    );
  }

  private async removeRemote(adb: PerfettoAdb, remotePath: string): Promise<void> {
    try {
      await adb.execute(["shell", `rm -f ${remotePath}`], {
        timeoutMs: ADB_TIMEOUT_MS,
        noRetry: true,
      });
    } catch (error) {
      // The trace is already on the host; a leftover device copy only costs device storage.
      logger.warn(
        `[performanceTrace] failed to remove ${remotePath}: ${errorMessage(error)}`,
        error,
      );
    }
  }
}

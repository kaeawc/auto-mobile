import { join } from "node:path";
import { ActionableError, type BootedDevice } from "../../models";
import type {
  HostChildProcess,
  HostCommandExecutor,
  HostSpawnOptions,
} from "../../utils/HostCommandExecutor";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import type { Timer } from "../../utils/SystemTimer";
import type {
  PerformanceTraceRecorder,
  RecordingPerformanceTrace,
  StartPerformanceTraceRequest,
} from "./PerformanceTraceRecorder";
import type { PerformanceTraceSummary } from "./PerformanceTraceSummary";
import {
  TEMPLATES_REQUIRING_APP,
  xctraceRecordArgs,
  type PerformanceTraceTemplate,
} from "./performanceTraceTemplates";
import {
  parseXctraceTable,
  parseXctraceToc,
  summarizeXctraceTable,
  XCTRACE_SUMMARY_SCHEMAS,
} from "./xctraceExport";
import { waitForChildExit, waitForChildOutput } from "./childProcessWaits";

export interface XctraceHost extends HostCommandExecutor {
  spawn(file: string, args: string[], options?: HostSpawnOptions): HostChildProcess;
}

/** Resolves the running process id of `appId`; `undefined` when it is not running or unknown. */
export type IosAppPidResolver = (
  device: BootedDevice,
  appId: string,
  signal?: AbortSignal,
) => Promise<number | undefined>;

export interface XctraceRecorderDependencies {
  host: XctraceHost;
  resolvePid: IosAppPidResolver;
  timer: Timer;
  /** How long `xctrace record` may take to report that recording started. */
  startTimeoutMs?: number;
  /** How long `xctrace` may take to finalize the `.trace` after SIGINT. */
  stopTimeoutMs?: number;
}

const DEFAULT_START_TIMEOUT_MS = 60_000;
const DEFAULT_STOP_TIMEOUT_MS = 20_000;
const EXPORT_TIMEOUT_MS = 120_000;
const EXPORT_MAX_BUFFER = 64 * 1024 * 1024;
/** `xctrace record` prints this once the recorder is capturing. */
const RECORDING_STARTED = /Ctrl-C to stop the recording|Starting recording/i;

interface RecordTarget {
  launchBundleId?: string;
  attachPid?: number;
}

/**
 * Records an Instruments trace with `xcrun xctrace record` on a Simulator or a
 * physical device (#14102), stopped by SIGINT so xctrace finalizes the file.
 */
export class XctraceRecorder implements PerformanceTraceRecorder {
  constructor(private readonly deps: XctraceRecorderDependencies) {}

  async start(request: StartPerformanceTraceRequest): Promise<RecordingPerformanceTrace> {
    const warnings: string[] = [];
    const target = await this.resolveTarget(request, warnings);
    const artifactPath = join(request.artifactDir, `${request.traceId}.trace`);
    const args = xctraceRecordArgs({
      template: request.template,
      deviceId: request.device.deviceId,
      outputPath: artifactPath,
      timeLimitMs: request.timeLimitMs,
      ...target,
    });
    const child = this.deps.host.spawn("xcrun", ["xctrace", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = waitForChildExit(child);
    try {
      await waitForChildOutput(child, RECORDING_STARTED, {
        timer: this.deps.timer,
        timeoutMs: this.deps.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
        label: "xctrace record",
        signal: request.signal,
      });
    } catch (error) {
      child.kill("SIGKILL");
      throw new ActionableError(
        `Failed to start xctrace (${request.template}) on ${request.device.deviceId}: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    return this.recording(child, exited, artifactPath, request.template, warnings);
  }

  private async resolveTarget(
    request: StartPerformanceTraceRequest,
    warnings: string[],
  ): Promise<RecordTarget> {
    const { appId, template, device } = request;
    if (!appId) {
      if (TEMPLATES_REQUIRING_APP.has(template)) {
        throw new ActionableError(`The ${template} template needs an appId.`);
      }
      return {};
    }
    if (template === "appLaunch") {
      return { launchBundleId: appId };
    }
    const pid = await this.deps.resolvePid(device, appId, request.signal);
    if (pid !== undefined) {
      return { attachPid: pid };
    }
    if (template === "allocations") {
      throw new ActionableError(
        `The allocations template attaches to a running process, but ${appId} is not running on ${device.deviceId}.`,
      );
    }
    warnings.push(`${appId} is not running; recording all processes instead.`);
    return {};
  }

  private recording(
    child: HostChildProcess,
    exited: Promise<void>,
    artifactPath: string,
    template: PerformanceTraceTemplate,
    warnings: string[],
  ): RecordingPerformanceTrace {
    const { timer, host } = this.deps;
    const stopTimeoutMs = this.deps.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    return {
      artifactPath,
      warnings,
      stop: async () => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGINT");
        }
        const finished = await raceExit(exited, timer, stopTimeoutMs);
        if (!finished) {
          // A killed xctrace leaves a trace without run data (#14737); fail fast and typed
          // rather than reporting a stopped recording whose artifact cannot be opened.
          child.kill("SIGKILL");
          throw new ActionableError(
            `xctrace did not finish within ${stopTimeoutMs}ms after SIGINT; the trace at ${artifactPath} is incomplete and cannot be summarised.`,
          );
        }
      },
      summarize: (signal) => summarizeXctrace(host, artifactPath, template, signal),
    };
  }
}

/** Whether the child exited within `timeoutMs`. */
async function raceExit(exited: Promise<void>, timer: Timer, timeoutMs: number): Promise<boolean> {
  const timedOut = new Error("xctrace finalize timed out");
  try {
    await raceWithDeadline(exited, {
      timer,
      timeoutMs,
      label: "xctrace finalize",
      timeoutError: () => timedOut,
    });
    return true;
  } catch (error) {
    if (error === timedOut) {
      return false;
    }
    throw error;
  }
}

async function exportXml(
  host: HostCommandExecutor,
  args: string[],
  signal?: AbortSignal,
): Promise<string> {
  return (
    await host.executeCommand("xcrun", ["xctrace", "export", ...args], {
      timeoutMs: EXPORT_TIMEOUT_MS,
      maxBuffer: EXPORT_MAX_BUFFER,
      signal,
    })
  ).stdout;
}

/** Summarise a finished `.trace` through `xctrace export`: the TOC, then the template's table. */
export async function summarizeXctrace(
  host: HostCommandExecutor,
  artifactPath: string,
  template: PerformanceTraceTemplate,
  signal?: AbortSignal,
): Promise<{ summary: PerformanceTraceSummary; warnings: string[] }> {
  const warnings: string[] = [];
  let toc;
  try {
    toc = await parseXctraceToc(await exportXml(host, ["--input", artifactPath, "--toc"], signal));
  } catch (error) {
    signal?.throwIfAborted();
    logger.warn(`[performanceTrace] xctrace export --toc failed: ${errorMessage(error)}`, error);
    const unreadable = /malformed|missing/i.test(errorMessage(error))
      ? " The trace is unreadable (xctrace did not finalize it); do not rely on the artifact."
      : "";
    return {
      summary: {},
      warnings: [`xctrace export --toc failed: ${errorMessage(error)}.${unreadable}`],
    };
  }
  const summary: PerformanceTraceSummary = {
    ...(toc.durationMs !== undefined ? { durationMs: toc.durationMs } : {}),
    ...(toc.endReason ? { endReason: toc.endReason } : {}),
  };
  const schema = XCTRACE_SUMMARY_SCHEMAS[template];
  if (!schema) {
    warnings.push(
      `xctrace export has no ${template} table to summarise; open the .trace in Instruments.`,
    );
    return { summary, warnings };
  }
  if (!toc.schemas.includes(schema)) {
    warnings.push(`The trace has no "${schema}" table, so the ${template} summary is empty.`);
    return { summary, warnings };
  }
  try {
    const xpath = `/trace-toc/run[@number="1"]/data/table[@schema="${schema}"]`;
    const rows = await parseXctraceTable(
      await exportXml(host, ["--input", artifactPath, "--xpath", xpath], signal),
    );
    Object.assign(summary, summarizeXctraceTable(template, rows));
  } catch (error) {
    signal?.throwIfAborted();
    logger.warn(
      `[performanceTrace] xctrace export ${schema} failed: ${errorMessage(error)}`,
      error,
    );
    warnings.push(`xctrace export of "${schema}" failed: ${errorMessage(error)}`);
  }
  return { summary, warnings };
}

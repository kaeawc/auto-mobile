import { join } from "node:path";
import { ActionableError, type BootedDevice } from "../../models";
import type {
  HostChildProcess,
  HostCommandExecutor,
  HostSpawnOptions,
} from "../../utils/HostCommandExecutor";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
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
  type XctraceToc,
} from "./xctraceExport";
import { waitForChildExit, waitForChildOutput } from "./childProcessWaits";
import { traceArtifactBytes, waitForXctraceFinalization } from "./xctraceFinalization";

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
  /** Inactivity window while finalizing after SIGINT (default 60 seconds). */
  stopTimeoutMs?: number;
  /** Hard cap on finalization, even with progress (default 180 seconds). */
  stopMaxMs?: number;
  /** Total artifact file bytes; missing paths return zero. */
  artifactBytes?: (path: string) => Promise<number>;
}

const DEFAULT_START_TIMEOUT_MS = 60_000;
const DEFAULT_STOP_TIMEOUT_MS = 60_000;
const DEFAULT_STOP_MAX_MS = 180_000;
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
        if (child.exitCode !== null || child.signalCode !== null) {
          return;
        }
        const finalized = waitForXctraceFinalization(child, exited, {
          timer,
          artifactPath,
          artifactBytes: this.deps.artifactBytes ?? traceArtifactBytes,
          stopTimeoutMs,
          stopMaxMs: this.deps.stopMaxMs ?? DEFAULT_STOP_MAX_MS,
        });
        child.kill("SIGINT");
        await finalized;
      },
      summarize: (signal) => summarizeXctrace(host, artifactPath, template, signal),
    };
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

function isEmptyRun(toc: XctraceToc): boolean {
  return toc.durationMs === 0 && toc.schemas.length === 0;
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
  if (isEmptyRun(toc)) {
    return {
      summary: {},
      warnings: [
        "xctrace saved the trace without any recorded run data (0 s, no tables), so there is nothing to summarise. The recording did not capture; retry on a less loaded host, or open the .trace in Instruments.",
      ],
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

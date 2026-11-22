import { join } from "node:path";
import { ActionableError, type BootedDevice } from "../../models";
import { toActionableError } from "../../models/ActionableError";
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
  TemplatePerformanceTraceRequest,
} from "./PerformanceTraceRecorder";
import type { PerformanceTraceSummary } from "./PerformanceTraceSummary";
import {
  parseXctraceTemplateList,
  TEMPLATES_REQUIRING_APP,
  XCTRACE_TEMPLATE_NAMES,
  xctraceRecordArgs,
  type PerformanceTraceTemplate,
} from "./performanceTraceTemplates";
import { XctraceTemplateUnavailableError } from "./XctraceTemplateUnavailableError";
import { findBrokenXctraceCombination, type XctraceEnvironment } from "./xctraceCompatibility";
import { XctraceUnsupportedEnvironmentError } from "./XctraceUnsupportedEnvironmentError";
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

/**
 * Resolves what `xctrace record --launch` should start for `appId`: the `.app` path on a simulator,
 * where xctrace rejects a bundle id as "Path not found" (#18790). `undefined` keeps the bundle id.
 */
export type IosLaunchTargetResolver = (
  device: BootedDevice,
  appId: string,
  signal?: AbortSignal,
) => Promise<string | undefined>;

export interface XctraceRecorderDependencies {
  host: XctraceHost;
  resolvePid: IosAppPidResolver;
  resolveLaunchTarget?: IosLaunchTargetResolver;
  timer: Timer;
  /** Host Xcode and simulator versions, checked against known-broken pairs; omitted skips the check. */
  environment?: XctraceEnvironment;
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
const LIST_TEMPLATES_TIMEOUT_MS = 30_000;
const RECORD_OUTPUT_MAX_CHARS = 8_000;
const EXPORT_MAX_BUFFER = 64 * 1024 * 1024;
/** `xctrace record` prints this once the recorder is capturing. */
const RECORDING_STARTED = /Ctrl-C to stop the recording|Starting recording/i;

interface RecordTarget {
  /** A bundle id, or a simulator `.app` path when the app resolves to one. */
  launchBundleId?: string;
  attachPid?: number;
}

/**
 * Records an Instruments trace with `xcrun xctrace record` on a Simulator or a
 * physical device (#14102), stopped by SIGINT so xctrace finalizes the file.
 */
export class XctraceRecorder implements PerformanceTraceRecorder {
  /** `xctrace list templates`, cached once read: the installed Xcode does not change under a daemon. */
  private installedTemplates?: ReadonlySet<string>;

  constructor(private readonly deps: XctraceRecorderDependencies) {}

  async start(request: StartPerformanceTraceRequest): Promise<RecordingPerformanceTrace> {
    if (request.template === undefined) {
      throw new ActionableError(
        "iOS performance traces need a template; categories are Android (Perfetto) only.",
      );
    }
    return this.startTemplate(request);
  }

  private async startTemplate(
    request: TemplatePerformanceTraceRequest,
  ): Promise<RecordingPerformanceTrace> {
    await this.assertSupportedEnvironment(request.device, request.signal);
    await this.assertTemplateInstalled(request.template, request.signal);
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
    const output = captureChildOutput(child);
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
    return this.recording(child, exited, artifactPath, {
      template: request.template,
      warnings,
      output,
    });
  }

  /** Refuse up front on an Xcode and simulator pair where xctrace cannot finalise (#16999). */
  private async assertSupportedEnvironment(
    device: BootedDevice,
    signal?: AbortSignal,
  ): Promise<void> {
    const environment = this.deps.environment;
    if (!environment) {
      return;
    }
    const simulatorRuntime = await environment.simulatorRuntime(device, signal);
    if (!simulatorRuntime) {
      return;
    }
    const xcodeVersion = await environment.xcodeVersion(signal);
    if (xcodeVersion && findBrokenXctraceCombination(xcodeVersion, simulatorRuntime)) {
      throw new XctraceUnsupportedEnvironmentError(xcodeVersion, simulatorRuntime, device.deviceId);
    }
  }

  /** Refuse up front when the installed Xcode lacks the Instruments template (#16970). */
  private async assertTemplateInstalled(
    template: PerformanceTraceTemplate,
    signal?: AbortSignal,
  ): Promise<void> {
    const installed = await this.listInstalledTemplates(signal);
    if (installed && !installed.has(XCTRACE_TEMPLATE_NAMES[template])) {
      throw new XctraceTemplateUnavailableError(template, installed);
    }
  }

  private async listInstalledTemplates(
    signal?: AbortSignal,
  ): Promise<ReadonlySet<string> | undefined> {
    if (this.installedTemplates) {
      return this.installedTemplates;
    }
    try {
      const { stdout } = await this.deps.host.executeCommand(
        "xcrun",
        ["xctrace", "list", "templates"],
        {
          timeoutMs: LIST_TEMPLATES_TIMEOUT_MS,
          signal,
        },
      );
      const installed = parseXctraceTemplateList(stdout);
      if (installed.size > 0) {
        this.installedTemplates = installed;
        return installed;
      }
      logger.warn(
        "[performanceTrace] xctrace list templates printed no templates; not prechecking",
      );
      return undefined;
    } catch (error) {
      signal?.throwIfAborted();
      // Best effort: `xctrace record` still reports a missing template itself, just later.
      logger.warn(
        `[performanceTrace] xctrace list templates failed: ${errorMessage(error)}`,
        error,
      );
      return undefined;
    }
  }

  private async resolveTarget(
    request: TemplatePerformanceTraceRequest,
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
      return { launchBundleId: (await this.launchTarget(device, appId, request.signal)) ?? appId };
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

  private async launchTarget(
    device: BootedDevice,
    appId: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    try {
      return await this.deps.resolveLaunchTarget?.(device, appId, signal);
    } catch (error) {
      signal?.throwIfAborted();
      throw toActionableError(
        error,
        `Cannot find ${appId} on ${device.deviceId} to launch it under xctrace; is it installed?`,
      );
    }
  }

  private recording(
    child: HostChildProcess,
    exited: Promise<void>,
    artifactPath: string,
    {
      template,
      warnings,
      output,
    }: { template: PerformanceTraceTemplate; warnings: string[]; output: ChildOutputCapture },
  ): RecordingPerformanceTrace {
    const { timer, host } = this.deps;
    const stopTimeoutMs = this.deps.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    let signalled = false;
    const stopChild = async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        signalled = true;
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
      signalled = true;
      await finalized;
    };
    return {
      artifactPath,
      warnings,
      get signalled() {
        return signalled;
      },
      stop: async () => {
        try {
          await stopChild();
        } finally {
          output.detach();
        }
      },
      summarize: async (signal) => {
        const summarized = await summarizeXctrace(host, artifactPath, template, signal);
        return withRecordErrors(
          summarized,
          xctraceRecordErrors(output.read()),
          artifactPath,
          template,
        );
      },
    };
  }
}

interface ChildOutputCapture {
  read(): string;
  /** Stop listening; the captured text stays readable. */
  detach(): void;
}

/** Keeps the tail of what `xctrace record` prints, for the errors it reports after it starts. */
function captureChildOutput(child: HostChildProcess): ChildOutputCapture {
  let captured = "";
  const onData = (chunk: Buffer | string) => {
    captured = (captured + chunk.toString()).slice(-RECORD_OUTPUT_MAX_CHARS);
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  return {
    read: () => captured,
    detach: () => {
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
    },
  };
}

/**
 * The `* [Error] ...` lines of `xctrace record`'s "Run issues were detected" block. Its exit code
 * is not reliable: an unsupported Animation Hitches recording attached to an app exits 0 (#18790).
 */
export function xctraceRecordErrors(output: string): string[] {
  const errors = [...output.matchAll(/^\s*\*\s*\[Error\]\s*(.+?)\s*$/gm)].map((match) => match[1]!);
  return [...new Set(errors)];
}

/**
 * An unreadable or empty trace with recorder errors failed to record, so it throws instead of
 * returning a successful empty summary; recorder errors on a readable trace stay warnings.
 */
function withRecordErrors(
  summarized: { summary: PerformanceTraceSummary; warnings: string[] },
  errors: string[],
  artifactPath: string,
  template: PerformanceTraceTemplate,
): { summary: PerformanceTraceSummary; warnings: string[] } {
  if (errors.length === 0) {
    return summarized;
  }
  const recorded = Object.keys(summarized.summary).length > 0;
  if (recorded) {
    return {
      summary: summarized.summary,
      warnings: [...summarized.warnings, ...errors.map((error) => `xctrace reported: ${error}`)],
    };
  }
  throw new ActionableError(
    `xctrace could not record the ${template} trace: ${errors.join("; ").replace(/\.$/, "")}. ` +
      `The artifact at ${artifactPath} has no run data.`,
  );
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

function timeProfilerSummaryWarnings(
  template: PerformanceTraceTemplate,
  sampleCount: number,
  summary: PerformanceTraceSummary,
): string[] {
  if (template === "timeProfiler" && sampleCount > 0 && summary.topFunctions?.length === 0) {
    return [
      `performanceTrace timeProfiler: ${sampleCount} samples exported but no function names could be read; the Xcode export shape may be unsupported.`,
    ];
  }
  return [];
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
    warnings.push(...timeProfilerSummaryWarnings(template, rows.length, summary));
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

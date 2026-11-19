import { ActionableError, type BootedDevice, type Platform } from "../../models";
import { errorMessage } from "../../utils/describeUnknownError";
import type { IdGenerator } from "../../utils/IdGenerator";
import { logger } from "../../utils/logger";
import type { Timer } from "../../utils/SystemTimer";
import {
  resolveTraceConfig,
  type ResolvedTraceConfig,
  type TraceCategory,
} from "./perfettoCategoryConfig";
import type {
  PerformanceTraceRecorder,
  RecordingPerformanceTrace,
} from "./PerformanceTraceRecorder";
import type { PerformanceTraceSummary } from "./PerformanceTraceSummary";
import type { PerformanceTraceTemplate } from "./performanceTraceTemplates";

export interface PerformanceTraceStartOptions {
  /** Exactly one of `template` and `categories` shapes the capture. */
  template?: PerformanceTraceTemplate;
  /** Android only: Perfetto categories instead of a template. */
  categories?: readonly TraceCategory[];
  /** Android only, with `categories`: ring buffer size. */
  bufferMb?: number;
  appId?: string;
  timeLimitMs: number;
  /** Session that owns the trace; releasing it stops the recorder. */
  ownerSessionUuid?: string;
  signal?: AbortSignal;
}

export interface PerformanceTraceResult {
  traceId: string;
  state: "recording" | "stopped";
  deviceId: string;
  platform: Platform;
  template?: PerformanceTraceTemplate;
  /** The resolved categories of a category trace (an `appId` adds `app`). */
  categories?: TraceCategory[];
  bufferMb?: number;
  appId?: string;
  startedAt: string;
  timeLimitMs: number;
  artifactPath: string;
  summary?: PerformanceTraceSummary;
  warnings: string[];
}

/** A trace the manager knows, with the session that started it. */
export interface KnownPerformanceTrace {
  result: PerformanceTraceResult;
  ownerSessionUuid?: string;
}

interface ActiveTrace {
  traceId: string;
  device: BootedDevice;
  options: PerformanceTraceStartOptions;
  categoryConfig?: ResolvedTraceConfig;
  startedAtMs: number;
  recording: RecordingPerformanceTrace;
  /** Set while a stop is in flight so concurrent stops share one teardown. */
  stopping?: Promise<PerformanceTraceResult>;
}

export interface PerformanceTraceManagerDependencies {
  recorderFor(platform: Platform): PerformanceTraceRecorder;
  artifactDir(): Promise<string>;
  idGenerator: IdGenerator;
  timer: Pick<Timer, "now">;
}

/** Stopped results kept so a repeated `stop` returns the same summary. */
const MAX_STOPPED_RESULTS = 32;

/**
 * Owns every live `performanceTrace` recorder (#14102), template or category (#18688): at most one per
 * device, each stopped by `stop`, by its owning session's release, or by its
 * device going away, so no `xctrace`/`perfetto` process outlives its session.
 */
export class PerformanceTraceManager {
  private readonly active = new Map<string, ActiveTrace>();
  /** Devices with a start in flight that has not registered its recorder yet. */
  private readonly starting = new Set<string>();
  private readonly stopped = new Map<string, KnownPerformanceTrace>();
  /** Stopped traces whose summary is still being generated; readable, no longer recording. */
  private readonly summarizing = new Map<string, KnownPerformanceTrace>();

  constructor(private readonly deps: PerformanceTraceManagerDependencies) {}

  async start(
    device: BootedDevice,
    options: PerformanceTraceStartOptions,
  ): Promise<PerformanceTraceResult> {
    const categoryConfig = resolveCategoryConfig(device, options);
    const existing = [...this.active.values()].find(
      (trace) => trace.device.deviceId === device.deviceId,
    );
    // Checked and claimed before the first await: overlapping starts must not both reach the device.
    if (existing || this.starting.has(device.deviceId)) {
      throw new ActionableError(
        `A trace (${existing?.traceId ?? "still starting"}) is already recording on ` +
          `${device.deviceId}; stop it before starting another.`,
      );
    }
    this.starting.add(device.deviceId);
    try {
      return await this.startClaimed(device, options, categoryConfig);
    } finally {
      this.starting.delete(device.deviceId);
    }
  }

  private async startClaimed(
    device: BootedDevice,
    options: PerformanceTraceStartOptions,
    categoryConfig: ResolvedTraceConfig | undefined,
  ): Promise<PerformanceTraceResult> {
    const traceId = `trace-${this.deps.idGenerator.next()}`;
    const startedAtMs = this.deps.timer.now();
    const base = {
      traceId,
      device,
      appId: options.appId,
      timeLimitMs: options.timeLimitMs,
      artifactDir: await this.deps.artifactDir(),
      signal: options.signal,
    };
    const recorder = this.deps.recorderFor(device.platform);
    const recording = await (categoryConfig
      ? recorder.start({ ...base, categoryConfig })
      : recorder.start({ ...base, template: options.template! }));
    const trace: ActiveTrace = { traceId, device, options, categoryConfig, startedAtMs, recording };
    this.active.set(traceId, trace);
    return this.describe(trace, "recording", [...recording.warnings]);
  }

  async stop(traceId: string, signal?: AbortSignal): Promise<PerformanceTraceResult> {
    const done = this.stopped.get(traceId);
    if (done) {
      return done.result;
    }
    const trace = this.active.get(traceId);
    if (!trace) {
      throw new ActionableError(`No performance trace with id ${traceId} is recording.`);
    }
    trace.stopping ??= this.finish(trace, signal);
    return trace.stopping;
  }

  /** Stop every trace owned by a released session. */
  async stopTracesForSession(sessionUuid: string): Promise<void> {
    await this.stopMatching((trace) => trace.options.ownerSessionUuid === sessionUuid);
  }

  /** Stop every trace on a released or removed device. */
  async stopTracesOnDevice(deviceId: string): Promise<void> {
    await this.stopMatching((trace) => trace.device.deviceId === deviceId);
  }

  /** A recording or recently stopped trace by id, for read-only resources. */
  lookup(traceId: string): KnownPerformanceTrace | undefined {
    const active = this.active.get(traceId);
    if (active) {
      return {
        result: this.describe(active, "recording", [...active.recording.warnings]),
        ownerSessionUuid: active.options.ownerSessionUuid,
      };
    }
    return this.summarizing.get(traceId) ?? this.stopped.get(traceId);
  }

  activeTraceIds(): string[] {
    return [...this.active.keys()];
  }

  private async stopMatching(match: (trace: ActiveTrace) => boolean): Promise<void> {
    const traces = [...this.active.values()].filter(match);
    await Promise.all(
      traces.map(async (trace) => {
        try {
          await this.stop(trace.traceId);
        } catch (error) {
          logger.warn(
            `[performanceTrace] failed to stop ${trace.traceId} on release: ${errorMessage(error)}`,
            error,
          );
        }
      }),
    );
  }

  private async finish(trace: ActiveTrace, signal?: AbortSignal): Promise<PerformanceTraceResult> {
    try {
      await trace.recording.stop(signal);
    } finally {
      // A failed stop still frees the device: the recorder was signalled and is not retried.
      this.active.delete(trace.traceId);
    }
    this.summarizing.set(trace.traceId, {
      result: this.describe(trace, "stopped", [
        ...trace.recording.warnings,
        "The summary is still being generated.",
      ]),
      ownerSessionUuid: trace.options.ownerSessionUuid,
    });
    let summarized: Awaited<ReturnType<RecordingPerformanceTrace["summarize"]>>;
    try {
      summarized = await trace.recording.summarize(signal);
    } finally {
      this.summarizing.delete(trace.traceId);
    }
    const { summary, warnings } = summarized;
    const result = this.describe(
      trace,
      "stopped",
      [...trace.recording.warnings, ...warnings],
      summary,
    );
    this.stopped.set(trace.traceId, {
      result,
      ownerSessionUuid: trace.options.ownerSessionUuid,
    });
    if (this.stopped.size > MAX_STOPPED_RESULTS) {
      this.stopped.delete(this.stopped.keys().next().value!);
    }
    return result;
  }

  private describe(
    trace: ActiveTrace,
    state: PerformanceTraceResult["state"],
    warnings: string[],
    summary?: PerformanceTraceSummary,
  ): PerformanceTraceResult {
    return {
      traceId: trace.traceId,
      state,
      deviceId: trace.device.deviceId,
      platform: trace.device.platform,
      ...(trace.options.template ? { template: trace.options.template } : {}),
      ...(trace.categoryConfig
        ? { categories: trace.categoryConfig.categories, bufferMb: trace.categoryConfig.bufferMb }
        : {}),
      ...(trace.options.appId ? { appId: trace.options.appId } : {}),
      startedAt: new Date(trace.startedAtMs).toISOString(),
      timeLimitMs: trace.options.timeLimitMs,
      artifactPath: trace.recording.artifactPath,
      ...(summary ? { summary } : {}),
      warnings,
    };
  }
}

/**
 * Check the capture shape before any recorder runs: exactly one of template and categories, and
 * categories only on Android. A category request resolves through the shared category rules
 * (`app` needs an `appId`; an `appId` adds `app`).
 */
function resolveCategoryConfig(
  device: BootedDevice,
  options: PerformanceTraceStartOptions,
): ResolvedTraceConfig | undefined {
  if ((options.template === undefined) === (options.categories === undefined)) {
    throw new ActionableError(
      "performanceTrace start needs exactly one of template or categories.",
    );
  }
  if (options.categories === undefined) {
    if (options.bufferMb !== undefined) {
      throw new ActionableError("bufferMb applies only to a categories trace.");
    }
    return undefined;
  }
  if (device.platform !== "android") {
    throw new ActionableError(
      `categories are Android (Perfetto) only; ${device.platform} traces need a template.`,
    );
  }
  return resolveTraceConfig({
    categories: options.categories,
    appId: options.appId,
    bufferMb: options.bufferMb,
    maxDurationMs: options.timeLimitMs,
  });
}

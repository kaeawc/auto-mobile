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
  /** Settles (never rejects) once the in-flight stop is done with the device; the summary may go on. */
  deviceDone?: Promise<void>;
}

export interface PerformanceTraceManagerDependencies {
  recorderFor(platform: Platform): PerformanceTraceRecorder;
  artifactDir(): Promise<string>;
  idGenerator: IdGenerator;
  timer: Pick<Timer, "now">;
}

/** A start that has claimed its device but not registered its recorder yet. */
interface InFlightStart {
  ownerSessionUuid?: string;
  /** Settles (never rejects) once the start registered its recorder or failed. */
  settled: Promise<void>;
}

/** Stopped results kept so a repeated `stop` returns the same summary. */
const MAX_STOPPED_RESULTS = 32;

/** Stops a release tries before leaving an unsignalled recorder to its `timeLimitMs`. */
const MAX_RELEASE_STOP_ATTEMPTS = 3;

/**
 * Owns every live `performanceTrace` recorder (#14102), template or category (#18688): at most one per
 * device, each stopped by `stop`, by its owning session's release, or by its
 * device going away, so no `xctrace`/`perfetto` process outlives its session.
 */
export class PerformanceTraceManager {
  private readonly active = new Map<string, ActiveTrace>();
  /** Devices with a start in flight that has not registered its recorder yet. */
  private readonly starting = new Map<string, InFlightStart>();
  private readonly stopped = new Map<string, KnownPerformanceTrace>();
  /** Stopped traces whose summary is still being generated; readable, no longer recording. */
  private readonly summarizing = new Map<string, KnownPerformanceTrace>();
  /** Stops in flight (recorder stop, pull and summary) so concurrent stops share one teardown. */
  private readonly finishing = new Map<string, Promise<PerformanceTraceResult>>();

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
    const claimed = this.startClaimed(device, options, categoryConfig);
    // A release that arrives mid-start waits for this, then stops the recorder it registered.
    this.starting.set(device.deviceId, {
      ownerSessionUuid: options.ownerSessionUuid,
      settled: claimed.then(
        () => undefined,
        () => undefined,
      ),
    });
    try {
      return await claimed;
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
      ownerSessionUuid: options.ownerSessionUuid,
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
    const inFlight = this.finishing.get(traceId);
    if (inFlight) {
      return inFlight;
    }
    const trace = this.active.get(traceId);
    if (!trace) {
      throw new ActionableError(`No performance trace with id ${traceId} is recording.`);
    }
    const stopping = this.finish(trace, signal);
    this.finishing.set(traceId, stopping);
    try {
      return await stopping;
    } finally {
      // A recorder that was never signalled is still active, so a retried stop starts afresh.
      if (this.finishing.get(traceId) === stopping) {
        this.finishing.delete(traceId);
      }
    }
  }

  /**
   * Stop every trace owned by a released session. Like the other release stops, this resolves
   * once each recorder is done with its device; pulling is part of that, the summary is not.
   */
  async stopTracesForSession(sessionUuid: string): Promise<void> {
    await this.stopMatching((_deviceId, owner) => owner === sessionUuid);
  }

  /** Stop the traces a session owns on one device, for a session that moved off that device. */
  async stopSessionTracesOnDevice(sessionUuid: string, deviceId: string): Promise<void> {
    await this.stopMatching(
      (traceDevice, owner) => owner === sessionUuid && traceDevice === deviceId,
    );
  }

  /**
   * Drop, without signalling, the traces a session owns on a device whose identity was replaced:
   * their recorder went with the old device, and its pid means nothing on the new one.
   */
  forgetSessionTracesOnDevice(sessionUuid: string, deviceId: string): string[] {
    const forgotten = [...this.active.values()].filter(
      (trace) =>
        trace.options.ownerSessionUuid === sessionUuid && trace.device.deviceId === deviceId,
    );
    forgotten.forEach((trace) => this.active.delete(trace.traceId));
    return forgotten.map((trace) => trace.traceId);
  }

  /**
   * End a trace whose start outlived its session (#18698) without pulling or summarising it.
   * A stop already in flight (a release cleanup) is waited for instead. Never rejects: a failure
   * is logged, and a recorder that was never signalled runs until its `timeLimitMs`.
   */
  async discard(traceId: string): Promise<void> {
    const trace = this.active.get(traceId);
    if (!trace) {
      return;
    }
    if (this.finishing.has(traceId)) {
      await trace.deviceDone;
      return;
    }
    this.active.delete(traceId);
    try {
      await trace.recording.discard();
    } catch (error) {
      logger.warn(
        `[performanceTrace] failed to discard ${traceId} on ${trace.device.deviceId}` +
          `${trace.recording.signalled ? "" : `; it runs until its ${trace.options.timeLimitMs} ms limit`}: ${errorMessage(error)}`,
        error,
      );
    }
  }

  /** Stop every trace on a released or removed device. */
  async stopTracesOnDevice(deviceId: string): Promise<void> {
    await this.stopMatching((traceDevice) => traceDevice === deviceId);
  }

  /** Stop the traces on a device that no session owns, for a session released off that device. */
  async stopUnownedTracesOnDevice(deviceId: string): Promise<void> {
    await this.stopMatching(
      (traceDevice, owner) => owner === undefined && traceDevice === deviceId,
    );
  }

  /** Whether a trace no session owns is recording, or still starting, on a device. */
  hasUnownedTraceOnDevice(deviceId: string): boolean {
    return this.hasTraceOnDevice(deviceId, undefined);
  }

  /** The devices a session has a trace recording, or still starting, on. */
  sessionTraceDeviceIds(sessionUuid: string): string[] {
    const starting = [...this.starting]
      .filter(([, start]) => start.ownerSessionUuid === sessionUuid)
      .map(([deviceId]) => deviceId);
    const recording = [...this.active.values()]
      .filter((trace) => trace.options.ownerSessionUuid === sessionUuid)
      .map((trace) => trace.device.deviceId);
    return [...new Set([...starting, ...recording])];
  }

  /** Whether a session has a trace recording, or still starting, on a device. */
  hasSessionTraceOnDevice(sessionUuid: string, deviceId: string): boolean {
    return this.hasTraceOnDevice(deviceId, sessionUuid);
  }

  private hasTraceOnDevice(deviceId: string, owner: string | undefined): boolean {
    const start = this.starting.get(deviceId);
    if (start && start.ownerSessionUuid === owner) {
      return true;
    }
    return [...this.active.values()].some(
      (trace) => trace.options.ownerSessionUuid === owner && trace.device.deviceId === deviceId,
    );
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

  /**
   * Stop the matching recorders, including ones whose start is still in flight: such a start is
   * awaited, then the recorder it registered is stopped.
   */
  private async stopMatching(
    match: (deviceId: string, ownerSessionUuid: string | undefined) => boolean,
  ): Promise<void> {
    const matchesTrace = (trace: ActiveTrace) =>
      match(trace.device.deviceId, trace.options.ownerSessionUuid);
    const traces = [...this.active.values()].filter(matchesTrace);
    const starts = [...this.starting]
      .filter(([deviceId, start]) => match(deviceId, start.ownerSessionUuid))
      .map(async ([deviceId, start]) => {
        await start.settled;
        const started = [...this.active.values()].find(
          (trace) => trace.device.deviceId === deviceId && matchesTrace(trace),
        );
        if (started && !traces.includes(started)) {
          await this.stopOnRelease(started);
        }
      });
    await Promise.all([...traces.map((trace) => this.stopOnRelease(trace)), ...starts]);
  }

  /**
   * Resolve once the recorder is done with its device; the summary finishes in the background.
   * A stop that fails before the recorder is signalled leaves it running, so it is retried a
   * bounded number of times before the device is let go.
   */
  private async stopOnRelease(trace: ActiveTrace): Promise<void> {
    for (
      let attempt = 1;
      attempt <= MAX_RELEASE_STOP_ATTEMPTS && this.active.has(trace.traceId);
      attempt++
    ) {
      void this.stop(trace.traceId).catch((error: unknown) => {
        logger.warn(
          `[performanceTrace] failed to stop ${trace.traceId} on release (attempt ${attempt}): ${errorMessage(error)}`,
          error,
        );
      });
      // `stop` set it synchronously.
      await trace.deviceDone;
    }
    if (this.active.has(trace.traceId)) {
      logger.warn(
        `[performanceTrace] ${trace.traceId} on ${trace.device.deviceId} was never signalled after ` +
          `${MAX_RELEASE_STOP_ATTEMPTS} stops; it runs until its ${trace.options.timeLimitMs} ms limit`,
      );
    }
  }

  private async finish(trace: ActiveTrace, signal?: AbortSignal): Promise<PerformanceTraceResult> {
    const recorderStopped = this.stopRecorder(trace, signal);
    trace.deviceDone = recorderStopped.then(
      () => undefined,
      () => {
        // Cleared before `deviceDone` settles so a release retry starts a fresh stop.
        if (this.active.has(trace.traceId)) {
          this.finishing.delete(trace.traceId);
        }
      },
    );
    await recorderStopped;
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

  private async stopRecorder(trace: ActiveTrace, signal?: AbortSignal): Promise<void> {
    try {
      await trace.recording.stop(signal);
    } catch (error) {
      // A recorder that was signalled is not retried, so a failed stop after that still frees the
      // device; one that never got its signal is still running and stays registered.
      if (trace.recording.signalled) {
        this.active.delete(trace.traceId);
      }
      throw error;
    }
    this.active.delete(trace.traceId);
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

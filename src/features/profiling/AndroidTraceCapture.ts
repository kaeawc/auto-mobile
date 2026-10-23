import { ActionableError } from "../../models/ActionableError";
import type { IdGenerator } from "../../utils/IdGenerator";
import type { Timer } from "../../utils/SystemTimer";
import {
  perfettoCategoryConfig,
  resolveTraceConfig,
  type ResolvedTraceConfig,
  type TraceConfigRequest,
} from "../performanceTrace/perfettoCategoryConfig";
import {
  awaitFlushedDeviceFile,
  DEVICE_TRACE_DIR,
  PULL_TIMEOUT_MS,
  removeDeviceFile,
  startPerfettoRecorder,
  stopPerfettoRecorder,
  type PerfettoAdb,
  type PerfettoPollOptions,
} from "../performanceTrace/perfettoDevice";
import type { ProfilingArtifactStore } from "./ProfilingArtifactStore";
import type { ProfilingRegistry, TraceStopResult } from "./ProfilingRegistry";

export interface TraceCaptureDependencies {
  adb: PerfettoAdb;
  timer: Pick<Timer, "sleep" | "now">;
  idGenerator: IdGenerator;
  registry: ProfilingRegistry;
  store: ProfilingArtifactStore;
  poll?: PerfettoPollOptions;
}

export interface TraceStartRequest extends TraceConfigRequest {
  deviceId: string;
  /** Session that owns the recorder; its release stops it. */
  sessionId?: string;
  signal?: AbortSignal;
}

export interface TraceStartResult {
  traceId: string;
  startedAt: string;
  config: ResolvedTraceConfig;
  warnings: string[];
}

const LOG_TAG = "captureTrace";

/**
 * Perfetto capture from typed categories (#14113): `start` builds a text config from the
 * categories alone and launches a detached recorder, `stop` signals it, waits for the file to
 * fill, pulls it to the host and removes the device copy. At most one capture runs per device,
 * and the registry lets session release stop one nobody stopped.
 */
export class AndroidTraceCapture {
  constructor(private readonly deps: TraceCaptureDependencies) {}

  async start(request: TraceStartRequest): Promise<TraceStartResult> {
    const { registry } = this.deps;
    const config = resolveTraceConfig(request);
    // Claimed before the first await: overlapping starts must not both reach the device.
    if (!registry.reserveStart(request.deviceId)) {
      const existing = registry.traceOnDevice(request.deviceId);
      throw new ActionableError(
        `A captureTrace (${existing?.traceId ?? "still starting"}) is already recording on ${request.deviceId}; stop it before starting another.`,
      );
    }
    try {
      return await this.startReserved(request, config);
    } finally {
      registry.releaseStart(request.deviceId);
    }
  }

  private async startReserved(
    request: TraceStartRequest,
    config: ResolvedTraceConfig,
  ): Promise<TraceStartResult> {
    const { registry, timer, idGenerator, store } = this.deps;
    const traceId = `trace-${idGenerator.next()}`;
    const remotePath = `${DEVICE_TRACE_DIR}/automobile-${traceId}.perfetto-trace`;
    const hostPath = await store.allocatePath("captureTrace", traceId, "perfetto-trace");
    const startedAtMs = timer.now();
    const pid = await startPerfettoRecorder(
      this.deps.adb,
      request.deviceId,
      perfettoCategoryConfig(config),
      remotePath,
      request.signal,
    );
    const warnings: string[] = [];
    if (!config.appId) {
      warnings.push("No appId was given; app-scoped atrace tags are disabled.");
    }
    registry.addTrace({
      traceId,
      deviceId: request.deviceId,
      sessionId: request.sessionId,
      pid,
      remotePath,
      hostPath,
      startedAtMs,
      config,
      warnings,
    });
    return { traceId, startedAt: new Date(startedAtMs).toISOString(), config, warnings };
  }

  async stop(deviceId: string, traceId: string, signal?: AbortSignal): Promise<TraceStopResult> {
    const record = this.deps.registry.getTrace(traceId);
    if (!record || record.deviceId !== deviceId) {
      throw new ActionableError(`No captureTrace with id ${traceId} is recording on ${deviceId}.`);
    }
    const stopping = (record.stopping ??= this.finish(record.traceId, signal));
    try {
      return await stopping;
    } catch (error) {
      // Still registered means the recorder was never confirmed stopped: let a retry try again.
      if (this.deps.registry.getTrace(traceId)) {
        record.stopping = undefined;
      }
      throw error;
    }
  }

  private async finish(traceId: string, signal?: AbortSignal): Promise<TraceStopResult> {
    const { adb, timer, registry, store, poll } = this.deps;
    const record = registry.getTrace(traceId)!;
    const warnings = [...record.warnings];
    // The SIGTERM must reach the device before anything is unregistered: if it cannot be
    // dispatched (cancellation, adb error) the recorder is still running, and the trace stays
    // registered so a retry or the session's release cleanup can still stop it.
    await stopPerfettoRecorder(adb, timer, record.pid, warnings, poll, signal);
    try {
      await awaitFlushedDeviceFile(adb, timer, record.remotePath, poll ?? {}, LOG_TAG, signal);
      await adb.execute(["pull", record.remotePath, record.hostPath], {
        timeoutMs: PULL_TIMEOUT_MS,
        noRetry: true,
        signal,
      });
    } catch (error) {
      await store.remove(record.hostPath);
      throw error;
    } finally {
      // A failed stop still frees the device: the recorder was signalled and is not retried.
      registry.removeTrace(traceId);
      if (!(await removeDeviceFile(adb, record.remotePath, LOG_TAG))) {
        // The recorder is stopped but its file is not gone: keep it registered for release cleanup.
        registry.addDeviceFile({
          deviceId: record.deviceId,
          sessionId: record.sessionId,
          remotePath: record.remotePath,
        });
      }
    }
    const sizeBytes = await store.sizeOf(record.hostPath);
    if (sizeBytes === 0) {
      throw new ActionableError(`The pulled trace ${record.hostPath} is empty.`);
    }
    return {
      traceId,
      path: record.hostPath,
      sizeBytes,
      // The recorder bounds itself, so a stop long after maxDurationMs still recorded that long.
      durationMs: Math.min(timer.now() - record.startedAtMs, record.config.maxDurationMs),
      warnings,
    };
  }
}

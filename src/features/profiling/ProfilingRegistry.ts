import type { ResolvedTraceConfig } from "../performanceTrace/perfettoCategoryConfig";

/** What stopping a `captureTrace` recorder reports. */
export interface TraceStopResult {
  traceId: string;
  path: string;
  sizeBytes: number;
  durationMs: number;
  warnings: string[];
}

/** A `captureTrace` recorder that is running on a device. */
export interface ActiveTraceRecord {
  traceId: string;
  deviceId: string;
  /** Session that started it; a sessionless (direct-mode) trace has no owner to release it. */
  sessionId?: string;
  /** Pid of the detached on-device `perfetto` process. */
  pid: number;
  remotePath: string;
  hostPath: string;
  startedAtMs: number;
  config: ResolvedTraceConfig;
  warnings: string[];
  /** Set while a stop is in flight so concurrent stops share one teardown. */
  stopping?: Promise<TraceStopResult>;
}

/** A file `heapDump` has put, or is about to put, on a device. */
export interface DeviceFileRecord {
  deviceId: string;
  sessionId?: string;
  remotePath: string;
}

/** Everything one session left on one device. */
export interface SessionProfilingState {
  traces: ActiveTraceRecord[];
  deviceFiles: DeviceFileRecord[];
}

/**
 * In-memory record of the device state profiling tools create (#14113): live trace recorders and
 * the device-side files of in-flight heap dumps. Like the other restore registries it is never
 * persisted; a daemon restart loses it, which is why the recorder also bounds itself with
 * `duration_ms` on the device.
 */
export class ProfilingRegistry {
  private readonly traces = new Map<string, ActiveTraceRecord>();
  private readonly starting = new Set<string>();
  private readonly deviceFiles = new Map<string, DeviceFileRecord>();

  addTrace(record: ActiveTraceRecord): void {
    this.traces.set(record.traceId, record);
  }

  getTrace(traceId: string): ActiveTraceRecord | undefined {
    return this.traces.get(traceId);
  }

  /**
   * Claim the device for a trace start that has not registered its recorder yet, synchronously,
   * so overlapping starts cannot both pass the one-recorder-per-device check. Returns false when
   * a trace is recording or another start holds the claim. Always pair with
   * {@link releaseStart}.
   */
  reserveStart(deviceId: string): boolean {
    if (this.traceOnDevice(deviceId) || this.starting.has(deviceId)) {
      return false;
    }
    this.starting.add(deviceId);
    return true;
  }

  releaseStart(deviceId: string): void {
    this.starting.delete(deviceId);
  }

  traceOnDevice(deviceId: string): ActiveTraceRecord | undefined {
    return [...this.traces.values()].find((trace) => trace.deviceId === deviceId);
  }

  removeTrace(traceId: string): void {
    this.traces.delete(traceId);
  }

  addDeviceFile(record: DeviceFileRecord): void {
    this.deviceFiles.set(`${record.deviceId}\0${record.remotePath}`, record);
  }

  removeDeviceFile(deviceId: string, remotePath: string): void {
    this.deviceFiles.delete(`${deviceId}\0${remotePath}`);
  }

  /** Remove and return what `sessionId` left on `deviceId`; empty when it left nothing. */
  takeOwnedBy(deviceId: string, sessionId: string): SessionProfilingState {
    const traces = [...this.traces.values()].filter(
      (trace) => trace.deviceId === deviceId && trace.sessionId === sessionId,
    );
    const deviceFiles = [...this.deviceFiles.values()].filter(
      (file) => file.deviceId === deviceId && file.sessionId === sessionId,
    );
    traces.forEach((trace) => this.traces.delete(trace.traceId));
    deviceFiles.forEach((file) => this.removeDeviceFile(file.deviceId, file.remotePath));
    return { traces, deviceFiles };
  }
}

export const defaultProfilingRegistry = new ProfilingRegistry();

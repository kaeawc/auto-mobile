import { isDeepStrictEqual } from "node:util";
import type { BootedDevice } from "../../models";
import { logger } from "../../utils/logger";
import type { H264CaptureSource, H264CaptureSourceOptions } from "./H264CaptureSource";
import { H264AnnexBParser, nalUnitType, NAL_TYPE_PPS, NAL_TYPE_SPS } from "./h264";

export interface DeviceCaptureHandle extends H264CaptureSource {
  setHasConsumers?: (hasConsumers: boolean) => void;
}
export interface DeviceCaptureRequest {
  device: BootedDevice;
  create: (options: H264CaptureSourceOptions) => H264CaptureSource | Promise<H264CaptureSource>;
  options: H264CaptureSourceOptions;
  /** Creator defaults remain actual settings; these fields are non-binding only when joining. */
  flexibleHints?: readonly CaptureHintField[];
  /** WebRTC consumers retain this default; the relay sets its actual subscriber state. */
  hasConsumers?: boolean;
}
export type CaptureHintField = "bitrateBps" | "size" | "quality" | "fps";
const captureHintFields: readonly CaptureHintField[] = ["bitrateBps", "size", "quality", "fps"];
function conflictingCaptureHints(
  actual: H264CaptureSourceOptions,
  requested: H264CaptureSourceOptions,
  flexible: readonly CaptureHintField[] = [],
): string[] {
  const fields: string[] = captureHintFields.filter(
    (field) =>
      !flexible.includes(field) &&
      requested[field] !== undefined &&
      !isDeepStrictEqual(actual[field], requested[field]),
  );
  if (requested.audioEnabled && !actual.audioEnabled) {
    fields.push("audioEnabled");
  }
  return fields;
}
/**
 * Undefined joiner values (and flexible defaults) mean no preference. Defined values must
 * deep-equal the creator's actual settings; an undefined actual value is an unknown device
 * default, never an explicit match. Audio is directional: an audio source can serve video only.
 */
export function captureHintsCompatible(
  actual: H264CaptureSourceOptions,
  requested: H264CaptureSourceOptions,
  flexible: readonly CaptureHintField[] = [],
): boolean {
  return conflictingCaptureHints(actual, requested, flexible).length === 0;
}
/** A shared relay may retain a satisfying source; a sole holder must recreate as on main. */
export function canRetainSharedCapture(
  source: H264CaptureSource,
  requested: H264CaptureSourceOptions,
  flexible: readonly CaptureHintField[] = [],
): boolean {
  return (
    source instanceof CaptureHandle &&
    source.entry.handles.size > 1 &&
    captureHintsCompatible(source.entry.request.options, requested, flexible)
  );
}
/** Preserve optional source capabilities while letting the relay retire a stale shared entry
 * even when the physical source implements only stop(). */
export function stopStaleCapture(
  source: H264CaptureSource,
  producerStale?: boolean,
): Promise<void> {
  return source instanceof CaptureHandle
    ? source.entry.release(source, { producerStale })
    : source.stopStale
      ? source.stopStale(producerStale)
      : source.stop();
}
/** Reference-counted compatible capture; incompatible requests get independent private entries.
 * Callback buffers are shared without copying: sinks MUST NOT mutate them.
 */
export interface DeviceCaptureRegistry {
  acquire(request: DeviceCaptureRequest): DeviceCaptureHandle;
}

class CaptureHandle implements DeviceCaptureHandle {
  active = true;
  hasConsumers: boolean;
  private joined = false;
  pendingAlignment = false;
  private released = false;
  private startWaiter: ReturnType<typeof Promise.withResolvers<void>> | null = null;
  constructor(
    readonly entry: CaptureEntry,
    readonly options: H264CaptureSourceOptions,
    consumers: boolean,
  ) {
    this.hasConsumers = consumers;
  }
  start(): Promise<void> {
    if (!this.active || this.entry.retired) {
      return this.released ? Promise.resolve() : (this.entry.startPromise ?? Promise.resolve());
    }
    if (!this.joined) {
      this.joined = true;
      this.pendingAlignment = this.entry.emittedData;
      this.entry.replayMetrics(this);
      if (this.pendingAlignment) {
        this.entry.source?.requestKeyFrame?.("viewer");
      }
    }
    if (this.entry.running) {
      return this.entry.start();
    }
    if (!this.startWaiter) {
      this.startWaiter = Promise.withResolvers<void>();
      void this.entry.start().then(this.startWaiter.resolve, this.startWaiter.reject);
    }
    return this.startWaiter.promise;
  }
  releaseStart(): void {
    this.released = true;
    this.startWaiter?.resolve();
  }
  stop(): Promise<void> {
    return this.entry.release(this);
  }
  get stopStale(): H264CaptureSource["stopStale"] {
    return this.entry.source?.stopStale
      ? (producerStale) => this.entry.release(this, { producerStale })
      : undefined;
  }
  get setHasConsumers(): DeviceCaptureHandle["setHasConsumers"] {
    const source = this.entry.source;
    if (!source || !("setHasConsumers" in source) || typeof source.setHasConsumers !== "function") {
      return undefined;
    }
    return (value) => {
      if (!this.active) {
        return;
      }
      this.hasConsumers = value;
      this.entry.updateConsumers();
    };
  }
  get requestKeyFrame(): H264CaptureSource["requestKeyFrame"] {
    const source = this.entry.source;
    return source?.requestKeyFrame ? source.requestKeyFrame.bind(source) : undefined;
  }
  get getTelemetry(): H264CaptureSource["getTelemetry"] {
    const source = this.entry.source;
    return source?.getTelemetry ? source.getTelemetry.bind(source) : undefined;
  }
}

class CaptureEntry {
  readonly handles = new Set<CaptureHandle>();
  readonly parser = new H264AnnexBParser();
  source: H264CaptureSource | null = null;
  creation: Promise<H264CaptureSource> | null = null;
  startPromise: Promise<void> | null = null;
  private startCompletion: ReturnType<typeof Promise.withResolvers<void>> | null = null;
  private retryOwner: CaptureHandle | null = null;
  private retryAvailable = false;
  private finalStop = false;
  private stopSettled = false;
  stopPromise: Promise<void> | null = null;
  retired = false;
  running = false;
  private sps: Buffer | null = null;
  private pps: Buffer | null = null;
  emittedData = false;
  private frameMetrics:
    | Parameters<NonNullable<H264CaptureSourceOptions["onFrameMetrics"]>>[0]
    | null = null;
  readonly loggedConflicts = new Set<string>();
  constructor(
    readonly request: DeviceCaptureRequest,
    private readonly onRetire: (entry: CaptureEntry) => void,
  ) {}

  canShare(request: DeviceCaptureRequest): boolean {
    const conflicts = conflictingCaptureHints(
      this.request.options,
      request.options,
      request.flexibleHints,
    );
    if (request.options.onFrameMetrics && !this.request.options.onFrameMetrics) {
      conflicts.push("onFrameMetrics");
    }
    if (
      request.options.audioEnabled &&
      request.options.onAudioData &&
      !this.request.options.onAudioData
    ) {
      conflicts.push("onAudioData");
    }
    if (conflicts.length === 0) {
      return true;
    }
    const cause = conflicts.join(", ");
    if (!this.loggedConflicts.has(cause)) {
      this.loggedConflicts.add(cause);
      logger.info(
        `[DeviceCapture] ${request.device.deviceId}: private capture required by incompatible settings (${cause})`,
      );
    }
    return false;
  }
  add(request: DeviceCaptureRequest): CaptureHandle {
    const handle = new CaptureHandle(this, request.options, request.hasConsumers ?? true);
    this.handles.add(handle);
    handle.pendingAlignment = this.emittedData;
    this.updateConsumers();
    return handle;
  }
  initialize(): void {
    // Construct synchronously to preserve actionable synchronous factory errors at acquire.
    const result = this.request.create(this.sourceOptions());
    if (!(result instanceof Promise)) {
      this.source = result;
      this.updateConsumers();
      this.creation = Promise.resolve(result);
    } else {
      this.creation = result.then((source) => {
        this.source = source;
        this.updateConsumers();
        return source;
      });
      void this.creation.then(undefined, () => this.creationFailed());
    }
  }
  start(): Promise<void> {
    if (this.startPromise) {
      return this.startPromise;
    }
    this.startCompletion = Promise.withResolvers<void>();
    this.startPromise = this.startCompletion.promise;
    if (this.source) {
      this.startSource(this.source);
    } else {
      if (!this.creation) {
        this.initialize();
      }
      void this.creation!.then(
        (source) => this.startSource(source),
        (error: unknown) => this.startFailed(error),
      );
    }
    return this.startPromise;
  }
  private startSource(source: H264CaptureSource): void {
    if (this.retired) {
      this.startCompletion?.resolve();
      return;
    }
    try {
      void source.start().then(
        () => {
          this.running = !this.retired;
          this.startCompletion?.resolve();
        },
        (error: unknown) => this.startFailed(error),
      );
    } catch (error) {
      logger.warn(`[DeviceCapture] ${this.request.device.deviceId}: source start failed`, error);
      this.startFailed(error);
    }
  }

  creationFailed(): void {
    if (!this.startPromise) {
      // A rejected factory may precede start(); it still has to release registry ownership.
      void this.retire(undefined, true);
    }
  }
  private startFailed(error: unknown): void {
    if (this.retired) {
      // An explicit release aborts startup; its late outcome cannot resurrect ownership.
      this.startCompletion?.resolve();
      return;
    }
    void this.retire(undefined, true).then(() => this.startCompletion?.reject(error));
  }
  release(handle: CaptureHandle, stale?: { producerStale?: boolean }): Promise<void> {
    if (!handle.active) {
      handle.releaseStart();
      if (handle === this.retryOwner && this.retryAvailable) {
        // Only the owner of a failed explicit last release gets one final attempt.
        this.retryAvailable = false;
        this.retryOwner = null;
        this.finalStop = true;
        return this.beginStop(stale, false);
      }
      return this.finalStop && this.stopSettled
        ? Promise.resolve()
        : (this.stopPromise ?? Promise.resolve());
    }
    handle.active = false;
    handle.releaseStart();
    this.handles.delete(handle);
    if (stale && this.handles.size > 0) {
      this.retryOwner = handle;
      const recipients = [...this.handles];
      const error = new Error(
        `Shared capture for ${this.request.device.deviceId} retired: producer declared stale`,
      );
      return this.retire(stale, false, () => {
        for (const peer of recipients) {
          this.deliver(peer, (options) => options.onError?.(error));
        }
      });
    }
    if (this.handles.size === 0) {
      this.retryOwner = handle;
      return this.retire(stale);
    }
    this.updateConsumers();
    return Promise.resolve();
  }
  retire(
    stale?: { producerStale?: boolean },
    bestEffort = false,
    notify?: () => void,
  ): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise;
    }
    this.retired = true;
    this.running = false;
    for (const handle of this.handles) {
      handle.active = false;
      if (stale) {
        handle.releaseStart();
      }
    }
    this.handles.clear();
    return this.beginStop(stale, bestEffort, notify);
  }
  private beginStop(
    stale: { producerStale?: boolean } | undefined,
    bestEffort: boolean,
    notify?: () => void,
  ): Promise<void> {
    const completion = Promise.withResolvers<void>();
    this.stopSettled = false;
    this.stopPromise = completion.promise;
    this.onRetire(this);
    notify?.();
    const finish = () => this.stopSource(stale, bestEffort, completion);
    // stop() aborts source.start(); waiting for start here can deadlock teardown.
    if (!this.source && this.creation) {
      void this.creation.then(finish, finish);
    } else {
      finish();
    }
    return completion.promise;
  }
  private stopSource(
    stale: { producerStale?: boolean } | undefined,
    bestEffort: boolean,
    completion: ReturnType<typeof Promise.withResolvers<void>>,
  ): void {
    try {
      const stop =
        stale && this.source?.stopStale
          ? this.source.stopStale(stale.producerStale)
          : this.source?.stop();
      void (stop ?? Promise.resolve()).then(
        () => {
          this.stopSettled = true;
          completion.resolve();
        },
        (error: unknown) => this.stopFailed(error, bestEffort, completion),
      );
    } catch (error) {
      // Synchronous implementations still follow the explicit/best-effort stop contract.
      this.stopFailed(error, bestEffort, completion);
    }
  }
  private stopFailed(
    error: unknown,
    bestEffort: boolean,
    completion: ReturnType<typeof Promise.withResolvers<void>>,
  ): void {
    this.stopSettled = true;
    // Best-effort retirement preserves the original failure; explicit release reports stop failure.
    logger.warn(`[DeviceCapture] ${this.request.device.deviceId}: source stop failed`, error);
    if (bestEffort) {
      completion.resolve();
    } else {
      this.retryAvailable = this.retryOwner !== null;
      completion.reject(error);
    }
  }

  updateConsumers(): void {
    const source = this.source;
    if (source && "setHasConsumers" in source && typeof source.setHasConsumers === "function") {
      source.setHasConsumers([...this.handles].some((handle) => handle.hasConsumers));
    }
  }
  private deliver(
    handle: CaptureHandle,
    callback: (options: H264CaptureSourceOptions) => void,
  ): void {
    try {
      callback(handle.options);
    } catch (error) {
      // A broken transport sink must not starve other consumers of the same source.
      logger.warn(`[DeviceCapture] ${this.request.device.deviceId}: capture sink failed`, error);
    }
  }
  private fanout(callback: (options: H264CaptureSourceOptions) => void): void {
    for (const handle of [...this.handles]) {
      if (handle.active) {
        this.deliver(handle, callback);
      }
    }
  }
  private cache(nals: Buffer[]): void {
    for (const nal of nals) {
      const type = nalUnitType(nal);
      if (type === NAL_TYPE_SPS) {
        this.sps = Buffer.concat([Buffer.from([0, 0, 0, 1]), nal]);
      } else if (type === NAL_TYPE_PPS) {
        this.pps = Buffer.concat([Buffer.from([0, 0, 0, 1]), nal]);
      }
    }
  }
  replay(handle: CaptureHandle): void {
    for (const nal of [this.sps, this.pps]) {
      if (nal && handle.active) {
        this.deliver(handle, (options) => (options.onReplayData ?? options.onData)(nal));
      }
    }
  }
  replayMetrics(handle: CaptureHandle): void {
    if (this.frameMetrics) {
      this.deliver(handle, (options) => options.onFrameMetrics?.(this.frameMetrics!));
    }
  }
  private deliverData(chunk: Buffer): void {
    for (const handle of [...this.handles]) {
      if (!handle.active) {
        continue;
      }
      let data = chunk;
      if (handle.pendingAlignment) {
        // Only an entirely in-chunk start code is safe. A split code is skipped; H.264
        // emulation prevention guarantees the next complete code is a genuine NAL boundary.
        const start = chunk.indexOf(Buffer.from([0, 0, 1]));
        if (start < 0) {
          continue;
        }
        const boundary = start > 0 && chunk[start - 1] === 0 ? start - 1 : start;
        handle.pendingAlignment = false;
        this.replay(handle);
        data = chunk.subarray(boundary);
      }
      if (handle.active) {
        this.deliver(handle, (options) => options.onData(data));
      }
    }
  }
  private fail(error: Error): void {
    if (this.retired) {
      return;
    }
    const recipients = [...this.handles];
    // Fence ownership before notifying, but preserve source telemetry until all sinks are notified.
    void this.retire(undefined, true, () => {
      for (const handle of recipients) {
        this.deliver(handle, (options) => options.onError?.(error));
      }
    });
  }
  private sourceOptions(): H264CaptureSourceOptions {
    return {
      ...this.request.options,
      onData: (chunk) => {
        if (this.retired) {
          return;
        }
        try {
          this.cache(this.parser.push(chunk));
        } catch (error) {
          logger.warn(
            `[DeviceCapture] ${this.request.device.deviceId}: invalid H.264 stream`,
            error,
          );
          // Cache parsing is best-effort; transports retain their own malformed-stream handling.
        }
        this.emittedData ||= chunk.length > 0;
        this.deliverData(chunk);
      },
      onEncodedAccessUnit: () => {
        this.cache(this.parser.flush());
        for (const handle of [...this.handles]) {
          if (handle.active && !handle.pendingAlignment) {
            this.deliver(handle, (options) => options.onEncodedAccessUnit?.());
          }
        }
      },
      onSourceFrame: () => this.fanout((options) => options.onSourceFrame?.()),
      onSourceIdle: () => this.fanout((options) => options.onSourceIdle?.()),
      onIdleAttestationSupport: (supported) =>
        this.fanout((options) => options.onIdleAttestationSupport?.(supported)),
      onRotation: (rotation) => this.fanout((options) => options.onRotation?.(rotation)),
      onDroppedFrames: (drops) => this.fanout((options) => options.onDroppedFrames?.(drops)),
      // iOS computes snapshots only when this callback exists. Preserve creator-only work.
      onFrameMetrics: this.request.options.onFrameMetrics
        ? (metrics) => {
            this.frameMetrics = metrics;
            this.fanout((options) => options.onFrameMetrics?.(metrics));
          }
        : undefined,
      onAudioData: this.request.options.onAudioData
        ? (chunk) => this.fanout((options) => options.onAudioData?.(chunk))
        : undefined,
      onError: (error) => this.fail(error),
    };
  }
}

class SharedDeviceCaptureRegistry implements DeviceCaptureRegistry {
  private readonly entries = new Map<string, CaptureEntry>();
  private readonly stopping = new Map<string, Set<CaptureEntry>>();
  acquire(request: DeviceCaptureRequest): DeviceCaptureHandle {
    const deviceId = request.device.deviceId;
    const existing = this.entries.get(deviceId);
    const privateEntry = existing ? !existing.canShare(request) : false;
    if (existing && !privateEntry) {
      return existing.add(request);
    }
    const entry = new CaptureEntry(request, (retired) => {
      if (this.entries.get(deviceId) === retired) {
        this.entries.delete(deviceId);
      }
      const stop = retired.stopPromise!;
      const pending = this.stopping.get(deviceId) ?? new Set<CaptureEntry>();
      pending.add(retired);
      this.stopping.set(deviceId, pending);
      const clear = () => {
        if (retired.stopPromise === stop) {
          pending.delete(retired);
          if (pending.size === 0) {
            this.stopping.delete(deviceId);
          }
        }
      };
      // The released handle retains failed-stop ownership; only in-flight attempts fence creation.
      void stop.then(clear, clear);
    });
    const handle = entry.add(request);
    if (!privateEntry) {
      this.entries.set(deviceId, entry);
    }
    const previousStop = this.stopping.get(deviceId);
    if (previousStop?.size) {
      const createAfterStop = () => {
        // A handle released while queued must not construct another encoder.
        if (entry.retired) {
          throw new Error("Capture released before creation");
        }
        entry.initialize();
        return entry.creation!;
      };
      const waitForStop = (retiring: CaptureEntry): Promise<void> => {
        const stop = retiring.stopPromise!;
        const afterStop = (): void | Promise<void> =>
          retiring.stopPromise !== stop ? waitForStop(retiring) : undefined;
        return stop.then(afterStop, afterStop);
      };
      entry.creation = Promise.all([...previousStop].map(waitForStop)).then(createAfterStop);
      void entry.creation.then(undefined, () => entry.creationFailed());
    } else {
      try {
        entry.initialize();
      } catch (error) {
        logger.warn(`[DeviceCapture] ${deviceId}: source creation failed`, error);
        if (this.entries.get(deviceId) === entry) {
          this.entries.delete(deviceId);
        }
        entry.retired = true;
        handle.active = false;
        entry.handles.clear();
        throw error;
      }
    }
    return handle;
  }
}
export function createDeviceCaptureRegistry(): DeviceCaptureRegistry {
  return new SharedDeviceCaptureRegistry();
}
let defaultRegistry: DeviceCaptureRegistry | undefined;
export function getDefaultDeviceCaptureRegistry(): DeviceCaptureRegistry {
  return (defaultRegistry ??= createDeviceCaptureRegistry());
}

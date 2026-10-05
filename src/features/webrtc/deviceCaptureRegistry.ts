import { isDeepStrictEqual } from "node:util";
import type { BootedDevice } from "../../models";
import { logger } from "../../utils/logger";
import type { H264CaptureSource, H264CaptureSourceOptions } from "./H264CaptureSource";
import { H264AnnexBParser, nalUnitType, NAL_TYPE_PPS, NAL_TYPE_SPS } from "./h264";

export interface DeviceCaptureHandle extends H264CaptureSource {
  setHasConsumers(hasConsumers: boolean): void;
}
export interface DeviceCaptureRequest {
  device: BootedDevice;
  create: (options: H264CaptureSourceOptions) => H264CaptureSource | Promise<H264CaptureSource>;
  options: H264CaptureSourceOptions;
  /** WebRTC consumers retain this default; the relay sets its actual subscriber state. */
  hasConsumers?: boolean;
}
/**
 * Owns source lifetime independently of either transport. First acquirer's capture hints win.
 * An audio-requiring joiner gets a private entry if the shared entry cannot supply audio;
 * this deliberate exception can run a second source, independently of the shared device entry.
 * Callback buffers are shared without copying: sinks MUST NOT mutate them.
 */
export interface DeviceCaptureRegistry {
  acquire(request: DeviceCaptureRequest): DeviceCaptureHandle;
}

class CaptureHandle implements DeviceCaptureHandle {
  active = true;
  hasConsumers: boolean;
  private joined = false;
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
    // Replay at start, after the caller installed its handle identity/generation guards.
    if (!this.joined && this.entry.running) {
      this.joined = true;
      this.entry.replay(this);
    }
    this.joined = true;
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
  stopStale(producerStale?: boolean): Promise<void> {
    return this.entry.release(this, { producerStale });
  }
  setHasConsumers(value: boolean): void {
    if (!this.active) {
      return;
    }
    this.hasConsumers = value;
    this.entry.updateConsumers();
  }
  requestKeyFrame(purpose?: "viewer" | "probe"): boolean {
    return this.active ? (this.entry.source?.requestKeyFrame?.(purpose) ?? false) : false;
  }
  getTelemetry() {
    return (
      this.entry.source?.getTelemetry?.() ?? {
        lastEncodedFrameTimestampUs: null,
        lastIdrTimestampUs: null,
        idrRequestCount: null,
        idrCompletionCount: null,
        encodedAccessUnitCount: null,
      }
    );
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
  private conflictLogged = false;
  constructor(
    readonly request: DeviceCaptureRequest,
    private readonly onRetire: (entry: CaptureEntry) => void,
  ) {}

  add(request: DeviceCaptureRequest): CaptureHandle {
    const handle = new CaptureHandle(this, request.options, request.hasConsumers ?? true);
    this.handles.add(handle);
    const firstHints = this.hints(this.request.options);
    const ignored = Object.entries(this.hints(request.options))
      .filter(
        ([key, value]) => !isDeepStrictEqual(value, firstHints[key as keyof typeof firstHints]),
      )
      .map(([key]) => key);
    if (!this.conflictLogged && ignored.length > 0) {
      this.conflictLogged = true;
      logger.warn(
        `[DeviceCapture] ${request.device.deviceId}: ignoring conflicting capture hints (${ignored.join(", ")}); first acquirer wins`,
      );
    }
    this.updateConsumers();
    return handle;
  }
  private hints(options: H264CaptureSourceOptions) {
    return {
      bitrateBps: options.bitrateBps,
      size: options.size,
      quality: options.quality,
      fps: options.fps,
    };
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
        this.deliver(handle, (options) => options.onData(nal));
      }
    }
    if (handle.active) {
      this.source?.requestKeyFrame?.("viewer");
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
        this.fanout((options) => options.onData(chunk));
      },
      onEncodedAccessUnit: () => {
        this.cache(this.parser.flush());
        this.fanout((options) => options.onEncodedAccessUnit?.());
      },
      onSourceFrame: () => this.fanout((options) => options.onSourceFrame?.()),
      onSourceIdle: () => this.fanout((options) => options.onSourceIdle?.()),
      onIdleAttestationSupport: (supported) =>
        this.fanout((options) => options.onIdleAttestationSupport?.(supported)),
      onRotation: (rotation) => this.fanout((options) => options.onRotation?.(rotation)),
      onDroppedFrames: (drops) => this.fanout((options) => options.onDroppedFrames?.(drops)),
      onFrameMetrics: (metrics) => this.fanout((options) => options.onFrameMetrics?.(metrics)),
      onAudioData: (chunk) => this.fanout((options) => options.onAudioData?.(chunk)),
      onError: (error) => this.fail(error),
    };
  }
}

class SharedDeviceCaptureRegistry implements DeviceCaptureRegistry {
  private readonly entries = new Map<string, CaptureEntry>();
  private readonly stopping = new Map<string, CaptureEntry>();
  acquire(request: DeviceCaptureRequest): DeviceCaptureHandle {
    const deviceId = request.device.deviceId;
    const existing = this.entries.get(deviceId);
    const privateAudio = Boolean(
      existing && request.options.audioEnabled && !existing.request.options.audioEnabled,
    );
    if (existing && !privateAudio) {
      return existing.add(request);
    }
    const entry = new CaptureEntry(request, (retired) => {
      if (privateAudio) {
        return;
      }
      if (this.entries.get(deviceId) === retired) {
        this.entries.delete(deviceId);
      }
      const stop = retired.stopPromise!;
      this.stopping.set(deviceId, retired);
      const clear = () => {
        if (this.stopping.get(deviceId) === retired && retired.stopPromise === stop) {
          this.stopping.delete(deviceId);
        }
      };
      // The released handle retains failed-stop ownership; only in-flight attempts fence creation.
      void stop.then(clear, clear);
    });
    const handle = entry.add(request);
    if (!privateAudio) {
      this.entries.set(deviceId, entry);
    }
    const previousStop = this.stopping.get(deviceId);
    if (previousStop) {
      const createAfterStop = () => {
        // A handle released while queued must not construct another encoder.
        if (entry.retired) {
          throw new Error("Capture released before creation");
        }
        entry.initialize();
        return entry.creation!;
      };
      const afterStop = (): H264CaptureSource | Promise<H264CaptureSource> => {
        if (previousStop.stopPromise !== stop) {
          return previousStop.stopPromise!.then(createAfterStop, createAfterStop);
        }
        return createAfterStop();
      };
      const stop = previousStop.stopPromise!;
      entry.creation = stop.then(afterStop, afterStop);
      void entry.creation.then(undefined, () => entry.creationFailed());
    } else {
      try {
        entry.initialize();
      } catch (error) {
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

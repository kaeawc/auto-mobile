import { isDeepStrictEqual } from "node:util";
import type { BootedDevice } from "../../models";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type {
  H264CaptureSource,
  H264CaptureSourceMetrics,
  H264CaptureSourceOptions,
} from "./H264CaptureSource";
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
    source.entry.conflicts(requested, flexible, false).length === 0
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
    // A frame-rate restart briefly detaches the source; its successor keeps the capability.
    const source = this.entry.source ?? this.entry.lastSource;
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
  parser = new H264AnnexBParser();
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
  /** Last adopted source; capability probes survive the gap of a frame-rate restart. */
  lastSource: H264CaptureSource | null = null;
  /** Actual capture rate: the creator's, raised in place to the highest binding joiner's. */
  private fps: number | undefined;
  /** Rate the current source was constructed with; differs from `fps` while a restart is due. */
  private sourceFps: number | undefined;
  /** Fences callbacks from a source a frame-rate restart has replaced. */
  private generation = 0;
  private restarting: Promise<void> | null = null;
  constructor(
    readonly request: DeviceCaptureRequest,
    private readonly onRetire: (entry: CaptureEntry) => void,
  ) {
    this.fps = request.options.fps;
  }

  /**
   * iOS (#10711, owner option A): a binding frame-rate mismatch does not force a second capture.
   * One capture runs at max(requested fps); a faster joiner restarts it in place (consumers stay
   * attached across a brief gap) and slower consumers simply receive the faster H.264 stream
   * (no temporal layers to subsample). When the fastest consumer leaves the rate is KEPT, not
   * stepped down: a step-down would interrupt the remaining consumers for a saving they never
   * asked for, and the capture stops entirely with its last consumer anyway. Android keeps
   * private captures for fps conflicts; an unknown creator rate is never assumed to satisfy.
   */
  private sharesFrameRate(): boolean {
    return this.request.device.platform === "ios" && this.fps !== undefined;
  }
  /** Binding conflicts against the actual settings; `allowRaise` admits a faster joiner. */
  conflicts(
    requested: H264CaptureSourceOptions,
    flexible: readonly CaptureHintField[] = [],
    allowRaise: boolean,
  ): string[] {
    const conflicts = conflictingCaptureHints(
      { ...this.request.options, fps: this.fps },
      requested,
      flexible,
    );
    const fps = requested.fps;
    const absorbed =
      this.sharesFrameRate() && fps !== undefined && (allowRaise || fps <= this.fps!);
    return absorbed ? conflicts.filter((field) => field !== "fps") : conflicts;
  }
  canShare(request: DeviceCaptureRequest): boolean {
    const conflicts = this.conflicts(request.options, request.flexibleHints, true);
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
  /** Attach a consumer; on iOS a faster binding rate restarts the capture in place. */
  add(request: DeviceCaptureRequest): CaptureHandle {
    const handle = new CaptureHandle(this, request.options, request.hasConsumers ?? true);
    this.handles.add(handle);
    handle.pendingAlignment = this.emittedData;
    this.updateConsumers();
    const fps = request.options.fps;
    const binding = !request.flexibleHints?.includes("fps");
    if (binding && fps !== undefined && this.sharesFrameRate() && fps > this.fps!) {
      this.raiseFrameRate(fps);
    }
    return handle;
  }
  initialize(): void {
    // Construct synchronously to preserve actionable synchronous factory errors at acquire.
    const result = this.request.create(this.sourceOptions());
    if (!(result instanceof Promise)) {
      this.adopt(result);
      this.creation = Promise.resolve(result);
    } else {
      this.creation = result.then((source) => {
        this.adopt(source);
        return source;
      });
      void this.creation.then(undefined, () => this.creationFailed());
    }
  }
  private adopt(source: H264CaptureSource): void {
    this.source = source;
    this.lastSource = source;
    this.updateConsumers();
  }
  private raiseFrameRate(fps: number): void {
    logger.info(
      `[DeviceCapture] ${this.request.device.deviceId}: restarting shared capture at ${fps} fps (was ${this.fps})`,
    );
    this.fps = fps;
    // One loop serializes concurrent raises; it re-reads the target after each replacement.
    this.restarting ??= this.restartAtTargetRate();
  }
  private async restartAtTargetRate(): Promise<void> {
    this.running = false;
    if (this.startPromise) {
      // Joiners arriving during the restart wait for the replacement, not the retired source.
      this.startCompletion = Promise.withResolvers<void>();
      this.startPromise = this.startCompletion.promise;
      void this.startPromise.catch((error: unknown) => {
        // Holders observe the rejection through their own start(); this only marks it handled.
        logger.debug(`[DeviceCapture] restart start rejected: ${errorMessage(error)}`);
      });
    }
    try {
      while (!this.retired && this.sourceFps !== this.fps) {
        await this.replaceSource();
        // A start() issued during the replacement is honoured here, after the await resumes.
        if (!this.retired && this.startPromise && this.source && this.sourceFps === this.fps) {
          await this.source.start();
        }
      }
      this.running = !this.retired && this.startPromise !== null;
      this.startCompletion?.resolve();
    } catch (error) {
      this.restartFailed(error);
    } finally {
      // Cleared synchronously so a start() after this point takes the normal path.
      this.restarting = null;
    }
  }
  private restartFailed(error: unknown): void {
    const completion = this.startCompletion;
    if (this.retired) {
      // An explicit release aborted the restart; its late outcome cannot resurrect ownership.
      completion?.resolve();
      return;
    }
    logger.warn(
      `[DeviceCapture] ${this.request.device.deviceId}: frame-rate restart failed`,
      error,
    );
    this.fail(error instanceof Error ? error : new Error(String(error)));
    const reject = () => completion?.reject(error);
    void this.stopPromise?.then(reject, reject);
  }
  /** Stop the current source, then construct its replacement at the current `fps`. */
  private async replaceSource(): Promise<void> {
    if (!this.source) {
      // Initial (possibly queued) creation is still in flight; its failure retires the entry.
      await this.creation?.catch(() => null);
    }
    const outgoing = this.source;
    if (this.retired || !outgoing || this.sourceFps === this.fps) {
      // A queued creation that ran after the raise already captures at the target rate.
      return;
    }
    // Detach synchronously: a concurrent retire waits on `creation` instead of stopping `outgoing`.
    this.generation++;
    this.source = null;
    this.parser = new H264AnnexBParser();
    this.sps = null;
    this.pps = null;
    const created = Promise.withResolvers<H264CaptureSource>();
    this.creation = created.promise;
    void created.promise.catch((error: unknown) => {
      // Retirement settles on either outcome; the failure itself is reported by the restart loop.
      logger.debug(`[DeviceCapture] restart replacement not adopted: ${errorMessage(error)}`);
    });
    try {
      await outgoing.stop();
    } catch (error) {
      // Best effort: the replacement may still attach; a dead successor fails the entry below.
      logger.warn(
        `[DeviceCapture] ${this.request.device.deviceId}: stopping capture for restart failed`,
        error,
      );
    }
    if (this.retired) {
      created.reject(new Error("Capture released during frame-rate restart"));
      return;
    }
    let source: H264CaptureSource;
    try {
      source = await this.request.create(this.sourceOptions());
    } catch (error) {
      created.reject(error);
      throw error;
    }
    this.adopt(source);
    created.resolve(source);
  }
  start(): Promise<void> {
    if (this.startPromise) {
      return this.startPromise;
    }
    this.startCompletion = Promise.withResolvers<void>();
    this.startPromise = this.startCompletion.promise;
    if (this.restarting) {
      // The restart loop starts its replacement once it sees a pending start.
      return this.startPromise;
    }
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
    if (this.restarting) {
      // A frame-rate restart owns startup now; it starts the replacement it constructs.
      return;
    }
    const generation = this.generation;
    // A restart that replaced this source owns the completion; its aborted start is not a failure.
    const superseded = () => generation !== this.generation || this.restarting !== null;
    try {
      void source.start().then(
        () => {
          if (superseded()) {
            return;
          }
          this.running = !this.retired;
          this.startCompletion?.resolve();
        },
        (error: unknown) => {
          if (superseded()) {
            logger.debug(
              `[DeviceCapture] ${this.request.device.deviceId}: replaced source start aborted: ${errorMessage(error)}`,
            );
            return;
          }
          this.startFailed(error);
        },
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
    const generation = this.generation;
    this.sourceFps = this.fps;
    const stale = () => this.retired || generation !== this.generation;
    const live =
      <A extends unknown[]>(callback: (...args: A) => void) =>
      (...args: A): void => {
        if (!stale()) {
          callback(...args);
        }
      };
    return {
      ...this.request.options,
      fps: this.fps,
      onData: (chunk) => {
        if (stale()) {
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
      onEncodedAccessUnit: live(() => {
        this.cache(this.parser.flush());
        for (const handle of [...this.handles]) {
          if (handle.active && !handle.pendingAlignment) {
            this.deliver(handle, (options) => options.onEncodedAccessUnit?.());
          }
        }
      }),
      onSourceFrame: live(() => this.fanout((options) => options.onSourceFrame?.())),
      onSourceIdle: live(() => this.fanout((options) => options.onSourceIdle?.())),
      onIdleAttestationSupport: live((supported: boolean) =>
        this.fanout((options) => options.onIdleAttestationSupport?.(supported)),
      ),
      onRotation: live((rotation: number) =>
        this.fanout((options) => options.onRotation?.(rotation)),
      ),
      onDroppedFrames: live((drops: number) =>
        this.fanout((options) => options.onDroppedFrames?.(drops)),
      ),
      onFrameMetrics:
        // Always produce metrics (LatestFrameQueue.metrics() is O(1)) so a late joiner on any
        // platform can share this capture instead of forcing a second one (#10711).
        live((metrics: H264CaptureSourceMetrics) => {
          this.frameMetrics = metrics;
          this.fanout((options) => options.onFrameMetrics?.(metrics));
        }),
      onAudioData: this.request.options.onAudioData
        ? live((chunk: Buffer) => this.fanout((options) => options.onAudioData?.(chunk)))
        : undefined,
      // A replaced source's teardown error is not a failure of the shared capture.
      onError: live((error: Error) => this.fail(error)),
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

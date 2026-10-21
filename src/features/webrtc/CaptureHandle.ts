import type { H264CaptureSource, H264CaptureSourceOptions } from "./H264CaptureSource";
import type { CaptureHintField } from "./captureHints";
import type { DeviceCaptureHandle } from "./deviceCaptureTypes";

/** The slice of a capture entry its handles drive; the entry implements it. */
export interface CaptureHandleEntry {
  readonly handles: ReadonlySet<CaptureHandle>;
  readonly retired: boolean;
  readonly running: boolean;
  readonly startPromise: Promise<void> | null;
  readonly emittedData: boolean;
  readonly source: H264CaptureSource | null;
  readonly lastSource: H264CaptureSource | null;
  start(): Promise<void>;
  release(handle: CaptureHandle, stale?: { producerStale?: boolean }): Promise<void>;
  replayMetrics(handle: CaptureHandle): void;
  updateConsumers(): void;
  conflicts(
    requested: H264CaptureSourceOptions,
    flexible: readonly CaptureHintField[],
    allowRaise: boolean,
  ): string[];
}

export class CaptureHandle implements DeviceCaptureHandle {
  active = true;
  hasConsumers: boolean;
  private joined = false;
  pendingAlignment = false;
  private released = false;
  private startWaiter: ReturnType<typeof Promise.withResolvers<void>> | null = null;
  constructor(
    readonly entry: CaptureHandleEntry,
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

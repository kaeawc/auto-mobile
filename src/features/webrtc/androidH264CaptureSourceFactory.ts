import { logger } from "../../utils/logger";
import { AndroidH264Source, type AndroidH264SourceOptions } from "./AndroidH264Source";
import type { H264CaptureSource } from "./H264CaptureSource";
import {
  PersistentEncoderH264Source,
  type PersistentEncoderH264SourceOptions,
} from "./PersistentEncoderH264Source";

/**
 * Injectable seams for {@link createAndroidH264CaptureSource} so the selection
 * and fallback behavior can be unit-tested without a device.
 */
export interface AndroidH264CaptureSourceDeps {
  createPersistent: (options: PersistentEncoderH264SourceOptions) => H264CaptureSource;
  createScreenrecord: (options: AndroidH264SourceOptions) => H264CaptureSource;
}

const defaultDeps: AndroidH264CaptureSourceDeps = {
  createPersistent: options => new PersistentEncoderH264Source(options),
  createScreenrecord: options => new AndroidH264Source(options),
};

/**
 * A capture source that prefers the persistent on-device encoder and
 * transparently falls back to segment-rotated `screenrecord` when the persistent
 * encoder is unavailable or fails to START. A failure AFTER a successful start
 * is NOT caught here — it propagates via the source's `onError` so the publisher
 * runs its normal reconnect loop, exactly as the screenrecord source does.
 */
class FallbackH264CaptureSource implements H264CaptureSource {
  private active: H264CaptureSource | null = null;
  private stopped = false;

  constructor(
    private readonly persistent: H264CaptureSource,
    private readonly buildScreenrecord: () => H264CaptureSource
  ) {}

  async start(): Promise<void> {
    this.stopped = false;
    this.active = this.persistent;
    try {
      await this.persistent.start();
    } catch (error) {
      if (this.stopped || this.active !== this.persistent) {
        return;
      }
      logger.warn(
        `[webrtc] persistent encoder unavailable, falling back to screenrecord: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      const screenrecord = this.buildScreenrecord();
      this.active = screenrecord;
      await screenrecord.start();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const active = this.active;
    this.active = null;
    await active?.stop();
  }

  requestKeyFrame(): void {
    this.active?.requestKeyFrame?.();
  }

  get getTelemetry(): H264CaptureSource["getTelemetry"] {
    const active = this.active;
    return active?.getTelemetry?.bind(active);
  }
}

/**
 * Build the WebRTC capture source for an Android device from a PRE-RESOLVED jar
 * path. Resolution (override → cached/downloaded → local build → null, with the
 * download off the frame path) happens once at stream start in
 * `webrtcStreamManager`; this factory stays synchronous and pure. When a jar
 * path is provided the persistent encoder is preferred (no ~175s rotation seam),
 * with an automatic fallback to `screenrecord`; a `null` path uses
 * `screenrecord` directly.
 */
export function createAndroidH264CaptureSource(
  options: AndroidH264SourceOptions,
  jarPath: string | null,
  deps: AndroidH264CaptureSourceDeps = defaultDeps
): H264CaptureSource {
  if (!jarPath) {
    if (options.audioEnabled) {
      throw new Error("WebRTC audio requires the persistent Android video-server jar.");
    }
    return deps.createScreenrecord(options);
  }

  if (options.audioEnabled) {
    return deps.createPersistent({
      device: options.device,
      onData: options.onData,
      onAudioData: options.onAudioData,
      onError: options.onError,
      bitrateBps: options.bitrateBps,
      size: options.size,
      audioEnabled: true,
      adbFactory: options.adbFactory,
      timer: options.timer,
      jarPath,
    });
  }

  const persistent = deps.createPersistent({
    device: options.device,
    onData: options.onData,
    onAudioData: options.onAudioData,
    onError: options.onError,
    bitrateBps: options.bitrateBps,
    size: options.size,
    audioEnabled: options.audioEnabled,
    adbFactory: options.adbFactory,
    timer: options.timer,
    jarPath,
  });
  return new FallbackH264CaptureSource(persistent, () => deps.createScreenrecord(options));
}

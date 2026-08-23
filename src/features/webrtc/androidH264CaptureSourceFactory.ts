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
  createPersistent: (options) => new PersistentEncoderH264Source(options),
  createScreenrecord: (options) => new AndroidH264Source(options),
};

/**
 * A capture source that prefers the persistent on-device encoder and
 * transparently falls back to segment-rotated `screenrecord` in two cases:
 *
 * 1. the persistent encoder is unavailable or fails to START, and
 * 2. a post-start on-device encoder/server loss exhausts the persistent source's
 *    bounded relaunch budget (issue #4742) — signalled through the
 *    `onScreenrecordFallback` callback the persistent source is built with.
 *
 * Both cases route through the SAME `switchToScreenrecord` path, so a mid-stream
 * encoder crash degrades to screenrecord instead of dropping the viewer to
 * screenshots. A post-start loss that is still WITHIN the relaunch budget is
 * handled inside the persistent source and never reaches here.
 */
class FallbackH264CaptureSource implements H264CaptureSource {
  private active: H264CaptureSource | null = null;
  private stopped = false;
  private readonly persistent: H264CaptureSource;

  constructor(
    buildPersistent: (onScreenrecordFallback: (error: Error) => Promise<void>) => H264CaptureSource,
    private readonly buildScreenrecord: () => H264CaptureSource,
  ) {
    this.persistent = buildPersistent((error) => this.switchToScreenrecord(error));
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.active = this.persistent;
    try {
      await this.persistent.start();
    } catch (error) {
      await this.switchToScreenrecord(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Replace the persistent source with a fresh screenrecord source and start it.
   * Idempotent and safe against teardown: a no-op once stopped or once the active
   * source is no longer the persistent one (already switched). A throw from
   * `screenrecord.start()` propagates to the caller — the initial-start path
   * (publisher) or the persistent source's exhaustion handler (which reports it
   * via `onError`).
   */
  private async switchToScreenrecord(error: Error): Promise<void> {
    if (this.stopped || this.active !== this.persistent) {
      return;
    }
    logger.warn(
      `[webrtc] persistent encoder unavailable, falling back to screenrecord: ${error.message}`,
    );
    const screenrecord = this.buildScreenrecord();
    this.active = screenrecord;
    await screenrecord.start();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const active = this.active;
    this.active = null;
    await active?.stop();
  }

  requestKeyFrame(): boolean {
    return this.active?.requestKeyFrame?.() ?? false;
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
  deps: AndroidH264CaptureSourceDeps = defaultDeps,
): H264CaptureSource {
  if (!jarPath) {
    if (options.audioEnabled) {
      throw new Error("WebRTC audio requires the persistent Android video-server jar.");
    }
    return deps.createScreenrecord(options);
  }

  const persistentOptions = (
    onScreenrecordFallback?: (error: Error) => Promise<void>,
  ): PersistentEncoderH264SourceOptions => ({
    device: options.device,
    onData: options.onData,
    onAudioData: options.onAudioData,
    onRotation: options.onRotation,
    onError: options.onError,
    bitrateBps: options.bitrateBps,
    size: options.size,
    quality: options.quality,
    fps: options.fps,
    audioEnabled: options.audioEnabled,
    adbFactory: options.adbFactory,
    timer: options.timer,
    jarPath,
    onScreenrecordFallback,
  });

  if (options.audioEnabled) {
    // Audio requires the persistent jar (screenrecord cannot carry PCM), so there
    // is no screenrecord fallback to hand off to: a spent relaunch budget surfaces
    // via onError and the publisher runs its normal reconnect loop.
    return deps.createPersistent(persistentOptions());
  }

  return new FallbackH264CaptureSource(
    (onScreenrecordFallback) => deps.createPersistent(persistentOptions(onScreenrecordFallback)),
    () => deps.createScreenrecord(options),
  );
}

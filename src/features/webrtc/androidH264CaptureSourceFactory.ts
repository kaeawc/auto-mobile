import { logger } from "../../utils/logger";
import { AndroidH264Source, type AndroidH264SourceOptions } from "./AndroidH264Source";
import type { H264CaptureSource } from "./H264CaptureSource";
import {
  PersistentEncoderH264Source,
  type PersistentEncoderH264SourceOptions,
} from "./PersistentEncoderH264Source";
import { resolveVideoServerJarPath } from "./videoServerJar";

/**
 * Injectable seams for {@link createAndroidH264CaptureSource} so the selection
 * and fallback behavior can be unit-tested without a device.
 */
export interface AndroidH264CaptureSourceDeps {
  resolveJarPath: (env?: NodeJS.ProcessEnv, cwd?: string) => string | null;
  createPersistent: (options: PersistentEncoderH264SourceOptions) => H264CaptureSource;
  createScreenrecord: (options: AndroidH264SourceOptions) => H264CaptureSource;
}

const defaultDeps: AndroidH264CaptureSourceDeps = {
  resolveJarPath: resolveVideoServerJarPath,
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

  constructor(
    private readonly persistent: H264CaptureSource,
    private readonly buildScreenrecord: () => H264CaptureSource
  ) {}

  async start(): Promise<void> {
    try {
      await this.persistent.start();
      this.active = this.persistent;
    } catch (error) {
      logger.warn(
        `[webrtc] persistent encoder unavailable, falling back to screenrecord: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      const screenrecord = this.buildScreenrecord();
      await screenrecord.start();
      this.active = screenrecord;
    }
  }

  async stop(): Promise<void> {
    await this.active?.stop();
    this.active = null;
  }
}

/**
 * Build the WebRTC capture source for an Android device. When the persistent
 * encoder jar is resolvable it is preferred (no ~175s rotation seam), with an
 * automatic fallback to `screenrecord`; otherwise `screenrecord` is used
 * directly.
 */
export function createAndroidH264CaptureSource(
  options: AndroidH264SourceOptions,
  deps: AndroidH264CaptureSourceDeps = defaultDeps
): H264CaptureSource {
  const jarPath = deps.resolveJarPath();
  if (!jarPath) {
    return deps.createScreenrecord(options);
  }

  const persistent = deps.createPersistent({
    device: options.device,
    onData: options.onData,
    onError: options.onError,
    bitrateBps: options.bitrateBps,
    size: options.size,
    adbFactory: options.adbFactory,
    timer: options.timer,
    jarPath,
  });
  return new FallbackH264CaptureSource(persistent, () => deps.createScreenrecord(options));
}

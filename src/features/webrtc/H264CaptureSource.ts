import type { BootedDevice } from "../../models";
import type { NativeFrameMetrics } from "../screen-stream/IOSScreenCaptureHelper";
import type { FrameQueueMetrics } from "../screen-stream/LatestFrameQueue";

export interface H264EncoderFrameMetrics extends FrameQueueMetrics {
  /** Duration of the last synchronous write into the encoder stdin buffer. */
  outputWriteDurationMs: number | null;
  /** Largest observed synchronous encoder-stdin write duration. */
  outputWriteHighWaterDurationMs: number;
}

/** Queue and write-latency snapshots for the iOS raw-frame pipeline. */
export interface H264CaptureSourceMetrics {
  native: NativeFrameMetrics | null;
  helper: FrameQueueMetrics | null;
  encoder: H264EncoderFrameMetrics;
}

export interface H264CaptureSourceOptions {
  device: BootedDevice;
  /** Called with each chunk of the raw H.264 (Annex-B) elementary stream. */
  onData: (chunk: Buffer) => void;
  /** Called with each chunk of 8 kHz mono PCM16LE audio when audio is enabled. */
  onAudioData?: (chunk: Buffer) => void;
  /**
   * Called with the attested display rotation (0..3) when the source can prove it (issue #4786).
   * Only the Android persistent encoder attests today; screenrecord and iOS sources omit it, so a
   * consumer that never receives a call leaves rotation unknown (control fails closed).
   */
  onRotation?: (rotation: number) => void;
  /** Called when the source fails fatally after it has started. */
  onError?: (error: Error) => void;
  bitrateBps?: number;
  size?: { width: number; height: number };
  /**
   * Device video-server quality preset. Selects resolution and default bitrate:
   * the persistent Android encoder forwards it as `--quality`, the Android
   * `screenrecord` fallback mirrors the same resolution cap and bitrate
   * host-side, and the iOS sources honor the preset's bitrate only (their
   * resolution self-scales to Level 4.2). Frame rate is carried separately by
   * {@link fps} so it can be tuned independently. When omitted the device
   * defaults to `medium`.
   */
  quality?: "low" | "medium" | "high";
  /**
   * Capture frame rate.
   *
   * On Android it is forwarded to the persistent video-server as `--fps`,
   * overriding the quality preset's default (carrying
   * `WebRtcStreamingConfig.androidFps`). The `screenrecord` fallback
   * (`AndroidH264Source`) has no frame-rate flag and captures at the display's
   * native rate, so the hint is a no-op there. On iOS Simulator it requests a
   * capture rate (carrying `WebRtcStreamingConfig.iosSimulatorFps`); physical
   * iOS captures at its own AVFoundation rate but still takes its declared
   * rawvideo input rate and GOP
   * length from it.
   */
  fps?: number;
  audioEnabled?: boolean;
  /** Receives bounded iOS capture-pipeline metrics when the source supports them. */
  onFrameMetrics?: (metrics: H264CaptureSourceMetrics) => void;
  /** Cumulative source-encoder drops; unchanged while a static source is healthy. */
  onDroppedFrames?: (droppedFrames: number) => void;
}

/**
 * Source-side encoder observations. `null` means that the source has not
 * initialized that measurement yet; a zero counter is therefore meaningful.
 */
export interface H264CaptureSourceTelemetry {
  lastEncodedFrameTimestampUs: number | null;
  lastIdrTimestampUs: number | null;
  idrRequestCount: number | null;
  idrCompletionCount: number | null;
  encodedAccessUnitCount: number | null;
}

/**
 * Common contract for a device H.264 capture source feeding the WebRTC
 * publisher. Both the segment-rotated `screenrecord` source
 * (`AndroidH264Source`) and the persistent on-device encoder source
 * (`PersistentEncoderH264Source`) satisfy it, so the stream manager can select
 * between them without caring which is in use.
 */
export interface H264CaptureSource {
  /** Start capturing; resolves once the source is producing (or has armed). */
  start(): Promise<void>;
  /** Stop capturing and release device-side resources. */
  stop(): Promise<void>;
  /**
   * Ask the encoder to emit a fresh IDR as soon as possible, in response to a
   * downstream keyframe request (WHEP viewer PLI relayed through the publisher).
   * Optional: sources that cannot signal their encoder mid-stream omit it and
   * rely on the periodic IDR interval. Implementations must be safe to call
   * frequently (throttle internally) and before/after the stream is running.
   */
  requestKeyFrame?(): boolean;
  /** Optional precise encoder telemetry for the stream-status control plane. */
  getTelemetry?(): H264CaptureSourceTelemetry;
}

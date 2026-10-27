import { ActionableError } from "../../models";
import { type Timer } from "../../utils/SystemTimer";
import { logger } from "../../utils/logger";
import { type FfmpegClient, type FfmpegProcess } from "../../utils/media/FfmpegClient";
import { hasPipedStdio } from "../../utils/pipedChildProcess";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import type {
  CaptureTarget,
  DecodedFrame,
  FrameQueueMetrics,
  NativeFrameMetrics,
} from "../screen-stream";
import { LatestFrameQueue } from "../screen-stream/LatestFrameQueue";
import type { H264EncoderFrameMetrics } from "./H264CaptureSource";
import type {
  IosH264EncoderProcess,
  IosH264FrameMetrics,
  IosH264SourceOptions,
} from "./IosH264SourceConfig";
import { H264AnnexBParser, isKeyFrameNal, NAL_TYPE_IDR } from "./h264";
import { h264MacroblocksPerFrame, WEBRTC_H264_MAX_MACROBLOCKS_PER_FRAME } from "./h264Level";
import { capToQualityPreset, qualityPresetBitrateBps } from "./qualityPresets";

/** Target seconds between IDRs in the ffmpeg GOP (see buildFfmpegArgs). */
const IOS_KEYFRAME_INTERVAL_SECONDS = 2;

/**
 * Minimum spacing between keyframe-driven encoder restarts. ffmpeg cannot be
 * signalled for an IDR mid-stream over a pipe, so `requestKeyFrame()` restarts
 * the encoder (whose first encoded frame is an SPS/PPS + IDR). That is
 * disruptive, so a burst of relayed viewer PLIs collapses to at most one restart
 * per this interval. A replacement that has not emitted its IDR also blocks later
 * restarts, giving VideoToolbox time to initialize rather than repeatedly
 * replacing its in-flight recovery. Mirrors
 * `ANDROID_FORCED_KEYFRAME_MIN_INTERVAL_MS`.
 */
export const IOS_FORCED_KEYFRAME_MIN_INTERVAL_MS = 3000;

/**
 * Grace window granted to an outgoing ffmpeg encoder to honour SIGTERM after a
 * keyframe restart before it is escalated to SIGKILL. A slow or signal-ignoring
 * `h264_videotoolbox` process left un-reaped lingers as a zombie holding the
 * (scarce on hosted runners) hardware encoder, so the restart is not considered
 * complete until the old encoder has exited or been force-killed. Mirrors the
 * capture helper's SIGTERM→grace→SIGKILL discipline
 * ({@link IOS_HELPER_STOP_GRACE_MS}).
 */
export const IOS_ENCODER_RESTART_GRACE_MS = 2_000;

/** H.264 macroblock edge, in pixels. */
const H264_MACROBLOCK_SIZE = 16;

/** Smallest dimension ffmpeg can encode as 4:2:0 chroma-subsampled video. */
const MIN_ENCODER_DIMENSION = 2;

/** One iPhone/iPad-sized BGRA frame awaiting encoder drain. */
const IOS_ENCODER_PENDING_FRAME_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Bits budgeted per encoded pixel per frame for the default WebRTC bitrate.
 *
 * Chosen from the two measured hosted-lane operating points (#4349): after
 * #4346 stopped upscaling toward 1920x1080, a Retina developer host encodes the
 * Simulator window at its native ~910x1940 backing store, so an uncapped
 * VideoToolbox default scales egress with resolution x rate with no ceiling. A
 * 0.1 bpp budget bounds that worst case (910x1940 @ 15 fps -> ~2.6 Mbps) while
 * a headless CI runner's much smaller frame (286x658 @ 15 fps -> ~0.28 Mbps)
 * stays far below it — so the same budget caps the large case without inflating
 * the small one. 0.1 bpp is a conventional target for baseline-profile screen
 * content, whose largely-static frames leave headroom for scroll/animation
 * transients within the 2s GOP. Override per-worker with
 * `AUTOMOBILE_WEBRTC_BITRATE_KBPS` when a specific ceiling is required.
 */
export const IOS_WEBRTC_DEFAULT_BITS_PER_PIXEL = 0.1;

/**
 * Resolution-aware default encoder bitrate (bps) for an iOS WebRTC stream that
 * did not configure one, derived from the *encoded* size (after any downscale)
 * and the declared frame rate. Scales the target with the encoder's real
 * workload rather than pinning a fixed ceiling, and always returns a positive
 * finite integer — a non-finite input (which real capture never produces) falls
 * back to the 1 bps floor rather than passing `NaN` to ffmpeg. See
 * {@link IOS_WEBRTC_DEFAULT_BITS_PER_PIXEL}.
 */
export function defaultIosBitrateBps(size: EncoderSize, fps: number): number {
  const budget = Math.round(size.width * size.height * fps * IOS_WEBRTC_DEFAULT_BITS_PER_PIXEL);
  return Number.isFinite(budget) ? Math.max(1, budget) : 1;
}

export interface EncoderSize {
  width: number;
  height: number;
}

export function validateIosSourceFrameSize(size: EncoderSize): ActionableError | null {
  const { width, height } = size;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return new ActionableError(
      `iOS capture reported an invalid frame size ${width}x${height}; cannot configure the H.264 encoder.`,
    );
  }
  return null;
}

function evenFloor(value: number): number {
  return Math.max(MIN_ENCODER_DIMENSION, Math.floor(value / 2) * 2);
}

/**
 * Resolve the ffmpeg output size for a captured frame, or `null` when the frame
 * can be encoded at its native size.
 *
 * A Simulator window is routinely far smaller than 1920x1080, so scaling every
 * capture toward that box spent encoder time inventing pixels the WHEP viewer
 * gained no detail from. Instead this scales down or not at all: native
 * dimensions are kept whenever they are even and already inside the Level 4.2
 * macroblock budget advertised in the WHIP SDP, odd dimensions round down to
 * even (ffmpeg's 4:2:0 chroma subsampling cannot encode an odd edge), and an
 * oversized capture shrinks just far enough to fit the budget with its aspect
 * ratio intact.
 *
 * The single exception is the `MIN_ENCODER_DIMENSION` floor: an axis of 0 or 1
 * pixel is raised to 2, because 4:2:0 has no smaller legal edge. No real capture
 * produces such a frame.
 */
export function resolveIosEncoderScale(size: EncoderSize): EncoderSize | null {
  const { width, height } = size;
  if (h264MacroblocksPerFrame(width, height) <= WEBRTC_H264_MAX_MACROBLOCKS_PER_FRAME) {
    const even = { width: evenFloor(width), height: evenFloor(height) };
    return even.width === width && even.height === height ? null : even;
  }

  // Shrink the macroblock grid rather than the pixel dimensions: flooring both
  // axes of an area-preserving scale keeps `columns * rows` inside the budget by
  // construction, so no iterative search (and no risk of overshoot) is needed.
  const columns = Math.ceil(width / H264_MACROBLOCK_SIZE);
  const rows = Math.ceil(height / H264_MACROBLOCK_SIZE);
  const factor = Math.sqrt(WEBRTC_H264_MAX_MACROBLOCKS_PER_FRAME / (columns * rows));
  const targetRows = clampMacroblockAxis(Math.floor(rows * factor));
  const targetColumns = clampMacroblockAxis(
    // An extreme aspect ratio can floor one axis to the 1-macroblock clamp, which
    // would otherwise let the product escape the budget; re-cap the other axis.
    Math.min(
      Math.floor(columns * factor),
      Math.floor(WEBRTC_H264_MAX_MACROBLOCKS_PER_FRAME / targetRows),
    ),
  );

  const scale = Math.min(
    (targetColumns * H264_MACROBLOCK_SIZE) / width,
    (targetRows * H264_MACROBLOCK_SIZE) / height,
  );
  return { width: evenFloor(width * scale), height: evenFloor(height * scale) };
}

function clampMacroblockAxis(value: number): number {
  return Math.min(WEBRTC_H264_MAX_MACROBLOCKS_PER_FRAME, Math.max(1, value));
}

function tightlyPackBgraFrame(frame: DecodedFrame): Buffer {
  const tightBytesPerRow = frame.header.width * 4;
  if (frame.header.bytesPerRow === tightBytesPerRow) {
    return frame.pixels;
  }

  const packed = Buffer.alloc(frame.header.height * tightBytesPerRow);
  for (let row = 0; row < frame.header.height; row++) {
    const sourceStart = row * frame.header.bytesPerRow;
    frame.pixels.copy(packed, row * tightBytesPerRow, sourceStart, sourceStart + tightBytesPerRow);
  }
  return packed;
}
interface IosFramePipelineLifecycle {
  isActive(): boolean;
  isRunning(): boolean;
  failIfRunning(error: Error): void;
  reportLegacyIdleSupport(): void;
}
export class IosFramePipeline {
  private readonly pendingFrames: LatestFrameQueue;

  captureKind: CaptureTarget["kind"] | null = null;

  latestLegacyFrame: DecodedFrame | null = null;

  private encoder: IosH264EncoderProcess | null = null;

  private encoderSize: EncoderSize | null = null;

  private encoderBackpressured = false;

  private lastEncoderStderr: string | null = null;

  lastForcedKeyFrameMs = Number.NEGATIVE_INFINITY;

  private lastOutputWriteDurationMs: number | null = null;

  private outputWriteHighWaterDurationMs = 0;

  helperFrameMetrics: FrameQueueMetrics | null = null;

  nativeFrameMetrics: NativeFrameMetrics | null = null;

  private forcedKeyFrameEncoder: IosH264EncoderProcess | null = null;

  private forcedKeyFrameParser: H264AnnexBParser | null = null;

  private encoderIdrParser = new H264AnnexBParser();

  private encoderHasProducedIdr = false;
  constructor(
    private readonly options: IosH264SourceOptions,
    private readonly ffmpegClient: FfmpegClient,
    private readonly ffmpegPath: string,
    private readonly fps: number,
    private readonly timer: Timer,
    private readonly lifecycle: IosFramePipelineLifecycle,
  ) {
    this.pendingFrames = new LatestFrameQueue({
      maxFrameBytes: IOS_ENCODER_PENDING_FRAME_MAX_BYTES,
      now: () => timer.now(),
    });
  }
  stop(): void {
    const encoder = this.encoder;
    this.encoder = null;
    this.encoderSize = null;
    this.encoderBackpressured = false;
    this.pendingFrames.clear();
    this.latestLegacyFrame = null;
    this.forcedKeyFrameEncoder = null;
    this.forcedKeyFrameParser = null;
    encoder?.stdin.end();
    encoder?.kill("SIGTERM");
  }

  /** Snapshot of each bounded handoff from capture through VideoToolbox. */
  getFrameMetrics(): IosH264FrameMetrics {
    return {
      native: this.nativeFrameMetrics,
      helper: this.helperFrameMetrics,
      encoder: this.getEncoderFrameMetrics(),
    };
  }

  /**
   * Raw-path keyframe request: ffmpeg cannot be signalled for a mid-stream IDR
   * over a pipe, so restart the encoder (its first output is SPS/PPS + IDR).
   */
  requestRawKeyFrame(purpose: "viewer" | "probe"): boolean {
    const oldEncoder = this.encoder;
    const size = this.encoderSize;
    if (
      !this.lifecycle.isRunning() ||
      !oldEncoder ||
      !size ||
      !this.encoderHasProducedIdr ||
      this.forcedKeyFrameEncoder
    ) {
      return false;
    }
    const now = this.timer.now();
    if (now - this.lastForcedKeyFrameMs < IOS_FORCED_KEYFRAME_MIN_INTERVAL_MS) {
      return false;
    }
    this.lastForcedKeyFrameMs = now;
    logger.info("[IosH264Source] keyframe requested; restarting encoder to emit a fresh IDR");
    // Spawn the replacement first so the outgoing encoder's exit/error handlers
    // — all guarded by `this.encoder === encoder` — no-op instead of tearing the
    // source down as a fatal crash. Wait for the next fresh helper frame to
    // produce the replacement encoder's IDR. Replaying a cached frame here can
    // create client-visible media after capture has stalled, falsely keeping
    // downstream frame watchdogs alive.
    this.pendingFrames.clear(true);
    this.reportFrameMetrics();
    this.startEncoder(size, true);
    // A raw Simulator helper may be natively idle and unable to force a new frame.
    // Bootstrap a waiting viewer from cached BGRA, but never use it for a liveness probe.
    // Neither path reports a fresh producer frame.
    if (this.captureKind === "simulator" && purpose === "viewer" && this.latestLegacyFrame) {
      this.writeFrameToEncoder(this.latestLegacyFrame);
      this.writeFrameToEncoder(this.latestLegacyFrame);
    }
    // Reap the outgoing encoder on a bounded grace, escalating to SIGKILL, so a
    // slow or signal-ignoring h264_videotoolbox cannot linger as a zombie
    // holding the hardware encoder. Fire-and-forget: the replacement is already
    // live and every old-encoder handler is guarded by `this.encoder === encoder`.
    void this.reapOutgoingEncoder(oldEncoder);
    return true;
  }

  /**
   * End the outgoing encoder's stdin, SIGTERM it, and await its exit within
   * {@link IOS_ENCODER_RESTART_GRACE_MS}; if it has not exited by then, escalate
   * to SIGKILL. Mirrors {@link IosScreenCaptureHelper}'s shutdown discipline.
   */
  private async reapOutgoingEncoder(encoder: IosH264EncoderProcess): Promise<void> {
    let exited = false;
    const exitPromise = new Promise<void>((resolve) => {
      encoder.once("exit", () => {
        exited = true;
        resolve();
      });
    });
    encoder.stdin.end();
    encoder.kill("SIGTERM");

    const timedOut = Symbol("encoder reap timeout");
    try {
      await raceWithDeadline(exitPromise, {
        timer: this.timer,
        timeoutMs: IOS_ENCODER_RESTART_GRACE_MS,
        label: "Outgoing encoder reap",
        timeoutError: () => timedOut,
      });
    } catch (error) {
      if (error !== timedOut) {
        throw error;
      }
    }

    if (!exited) {
      logger.warn(
        `[IosH264Source] outgoing ffmpeg encoder did not exit within ${IOS_ENCODER_RESTART_GRACE_MS}ms after SIGTERM; escalating to SIGKILL`,
      );
      encoder.kill("SIGKILL");
    }
  }

  handleFrame(frame: DecodedFrame): void {
    if (!this.lifecycle.isActive()) {
      return;
    }
    const size = { width: frame.header.width, height: frame.header.height };
    const error = validateIosSourceFrameSize(size);
    if (error) {
      this.lifecycle.failIfRunning(error);
      return;
    }
    if (!frame.replayed) {
      this.lifecycle.reportLegacyIdleSupport();
      this.options.onSourceFrame?.();
      if (
        this.captureKind === "simulator" &&
        frame.pixels.length <= IOS_ENCODER_PENDING_FRAME_MAX_BYTES
      ) {
        this.latestLegacyFrame = frame;
      }
    }
    if (!this.encoder) {
      this.startEncoder(size);
    } else if (this.encoderBackpressured) {
      this.pendingFrames.enqueue(frame);
      this.reportFrameMetrics();
      return;
    } else if (
      this.encoderSize &&
      (this.encoderSize.width !== size.width || this.encoderSize.height !== size.height)
    ) {
      // A mid-stream size change (device rotation, the Swift helper's own
      // reconfigure) is a recoverable reconfigure, not a fatal error: restart
      // the encoder at the new geometry (a fresh SPS/PPS + IDR) rather than
      // tearing the whole source down. See issue #4768.
      this.reconfigureEncoderSize(size);
    }

    this.writeFrameToEncoder(frame);
  }

  /**
   * Restart the ffmpeg encoder at a new capture geometry, in place. ffmpeg's
   * `-s WxH` input size is fixed for the life of a process, so a size change
   * requires a fresh encoder — but only the encoder, not the capture helper.
   * The replacement begins its output with SPS/PPS + an IDR on the next frame,
   * which is exactly what a resolution change needs downstream. Mirrors the
   * on-demand restart in {@link requestKeyFrame}; the outgoing encoder's guarded
   * exit/error handlers no-op once `this.encoder` is replaced.
   */
  private reconfigureEncoderSize(newSize: EncoderSize): void {
    const previous = this.encoderSize;
    logger.info(
      `[IosH264Source] capture frame size changed from ${previous?.width}x${previous?.height} ` +
        `to ${newSize.width}x${newSize.height}; restarting encoder at the new size`,
    );
    const oldEncoder = this.encoder;
    // Queued frames carry the old geometry; drop them so the new encoder is not
    // fed a frame sized for the previous configuration.
    this.pendingFrames.clear(true);
    this.reportFrameMetrics();
    this.startEncoder(newSize);
    if (oldEncoder) {
      void this.reapOutgoingEncoder(oldEncoder);
    }
  }

  private writeFrameToEncoder(frame: DecodedFrame): void {
    const encoder = this.encoder;
    if (!encoder) {
      return;
    }
    const startedAt = this.timer.now();
    const accepted = encoder.stdin.write(tightlyPackBgraFrame(frame));
    this.lastOutputWriteDurationMs = Math.max(0, this.timer.now() - startedAt);
    this.outputWriteHighWaterDurationMs = Math.max(
      this.outputWriteHighWaterDurationMs,
      this.lastOutputWriteDurationMs,
    );
    if (accepted === false) {
      this.encoderBackpressured = true;
    }
    this.reportFrameMetrics();
  }

  private startEncoder(size: EncoderSize, awaitsForcedKeyFrame = false): void {
    const args = this.buildFfmpegArgs(size);
    logger.info(`[IosH264Source] starting ffmpeg encoder: ${this.ffmpegPath} ${args.join(" ")}`);
    const { process } = this.ffmpegClient.start({
      args,
      context: "iOS WebRTC H.264 encoder",
      stdio: ["pipe", "pipe", "pipe"],
    });
    // The argv above requests piped stdin/stdout/stderr; verify them before narrowing the
    // generic client process surface to the encoder contract used by this source.
    if (!hasPipedStdio<FfmpegProcess, IosH264EncoderProcess>(process)) {
      process.kill();
      throw new ActionableError("ffmpeg encoder started without piped stdio");
    }
    const encoder = process;
    this.encoder = encoder;
    this.encoderSize = size;
    this.encoderBackpressured = false;
    this.encoderIdrParser = new H264AnnexBParser();
    this.encoderHasProducedIdr = false;
    this.lastEncoderStderr = null;
    if (awaitsForcedKeyFrame) {
      this.forcedKeyFrameEncoder = encoder;
      this.forcedKeyFrameParser = new H264AnnexBParser();
    }

    encoder.stdout.on("data", (chunk) => {
      if (this.lifecycle.isActive() && this.encoder === encoder) {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        this.recordEncoderIdr(encoder, data);
        this.recordForcedKeyFrame(encoder, data);
        this.options.onData(data);
      }
    });
    encoder.stderr.on("data", (chunk) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8").trim() : String(chunk).trim();
      if (this.encoder === encoder && text.length > 0) {
        this.lastEncoderStderr = `${this.lastEncoderStderr ?? ""}\n${text}`.trim().slice(-2_048);
        logger.debug(`[IosH264Source] ffmpeg stderr: ${text}`);
      }
    });
    encoder.stdin.on("drain", () => {
      if (this.encoder === encoder) {
        this.encoderBackpressured = false;
        this.writePendingFrameToEncoder();
      }
    });
    encoder.stdin.on("error", (error) => {
      if (this.encoder === encoder) {
        this.lifecycle.failIfRunning(
          this.withEncoderDiagnostics(error instanceof Error ? error : new Error(String(error))),
        );
      }
    });
    encoder.once("error", (error) => {
      if (this.encoder === encoder) {
        this.lifecycle.failIfRunning(this.withEncoderDiagnostics(error));
      }
    });
    encoder.once("exit", (code, signal) => {
      if (this.encoder === encoder) {
        this.lifecycle.failIfRunning(
          this.withEncoderDiagnostics(new Error(`ffmpeg exited (code=${code}, signal=${signal})`)),
        );
      }
    });
  }

  private writePendingFrameToEncoder(): void {
    if (!this.lifecycle.isActive() || this.encoderBackpressured) {
      return;
    }
    const frame = this.pendingFrames.take();
    this.reportFrameMetrics();
    if (frame === null) {
      return;
    }
    const size = { width: frame.header.width, height: frame.header.height };
    if (
      this.encoderSize &&
      (this.encoderSize.width !== size.width || this.encoderSize.height !== size.height)
    ) {
      // A dequeued frame can also carry a new geometry; reconfigure rather than
      // fail (issue #4768).
      this.reconfigureEncoderSize(size);
    }
    this.writeFrameToEncoder(frame);
  }

  private getEncoderFrameMetrics(): H264EncoderFrameMetrics {
    return {
      ...this.pendingFrames.metrics(),
      outputWriteDurationMs: this.lastOutputWriteDurationMs,
      outputWriteHighWaterDurationMs: this.outputWriteHighWaterDurationMs,
    };
  }

  reportFrameMetrics(): void {
    this.options.onFrameMetrics?.(this.getFrameMetrics());
  }

  private withEncoderDiagnostics(error: Error): Error {
    const stderr = this.lastEncoderStderr;
    return stderr === null ? error : new Error(`${error.message}; stderr: ${stderr}`);
  }

  /**
   * The replacement encoder begins with SPS/PPS + IDR. Do not let a recurring
   * PLI replace it before that IDR arrives: VideoToolbox can take longer than
   * the PLI cadence to initialize under CI load. The shared incremental parser
   * preserves Annex-B boundaries across stdout chunks.
   */
  private recordForcedKeyFrame(encoder: IosH264EncoderProcess, chunk: Buffer): void {
    if (this.forcedKeyFrameEncoder !== encoder || !this.forcedKeyFrameParser) {
      return;
    }
    try {
      if (
        this.forcedKeyFrameParser.push(chunk).some(isKeyFrameNal) ||
        this.forcedKeyFrameParser.hasBufferedNalType(NAL_TYPE_IDR)
      ) {
        this.forcedKeyFrameEncoder = null;
        this.forcedKeyFrameParser = null;
      }
    } catch (error) {
      // The publisher separately treats malformed Annex-B media as a source
      // failure. Keep this recovery guard closed rather than restarting an
      // encoder whose replacement output we cannot prove contains an IDR.
      logger.debug(`[IosH264Source] could not parse forced-keyframe output: ${error}`);
    }
  }

  /** Track the initial IDR before allowing a PLI to recycle the warming encoder. */
  private recordEncoderIdr(encoder: IosH264EncoderProcess, chunk: Buffer): void {
    if (this.encoder !== encoder || this.encoderHasProducedIdr) {
      return;
    }
    try {
      this.encoderHasProducedIdr =
        this.encoderIdrParser.push(chunk).some(isKeyFrameNal) ||
        this.encoderIdrParser.hasBufferedNalType(NAL_TYPE_IDR);
    } catch (error) {
      // The RTP writer will surface malformed Annex-B separately. Leave this
      // gate closed so an unverified warming encoder is not recycled into PLI churn.
      logger.debug(
        `[IosH264Source] could not parse encoder output while awaiting initial IDR: ${error}`,
      );
    }
  }

  private buildFfmpegArgs(size: EncoderSize): string[] {
    const args = [
      "-hide_banner",
      "-loglevel",
      "warning",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "bgra",
      "-s",
      `${size.width}x${size.height}`,
      "-r",
      String(this.fps),
      "-i",
      "pipe:0",
    ];
    // Explicit sizes are validated before source creation by
    // webrtcStreamingConfig; otherwise shrink only for the Level 4.2 budget or
    // the requested quality preset's long-side cap.
    const levelScale = resolveIosEncoderScale(size);
    const scale =
      this.options.size ??
      (this.options.quality
        ? capToQualityPreset(levelScale ?? size, this.options.quality)
        : levelScale);
    if (scale) {
      args.push("-vf", `scale=${scale.width}:${scale.height}`);
    }
    args.push(
      "-an",
      "-c:v",
      "h264_videotoolbox",
      // Hosted macOS runners can exhaust the hardware encoder while Simulator
      // processes are active. Keep VideoToolbox as the encoder, but allow its
      // software implementation rather than repeatedly reconnecting forever.
      "-allow_sw",
      "1",
      "-profile:v",
      "baseline",
      "-level:v",
      "4.2",
      "-bf",
      "0",
      // Cap the keyframe interval at ~2s of *declared* rate. This periodic GOP
      // is the *fallback* recovery path; on-demand recovery goes through
      // requestKeyFrame() (an encoder restart), because ffmpeg cannot be
      // signalled to emit an IDR mid-stream over a pipe. The h264 muxer prepends
      // SPS/PPS to each keyframe, so every IDR is self-decodable.
      //
      // -g counts encoded frames, not seconds, and the helper delivers fewer
      // than `fps` whenever the screen is static (SimulatorCaptureSession drops
      // every non-.complete ScreenCaptureKit status) or the host is saturated.
      // The wall-clock interval is therefore `-g / delivered_fps`, which only
      // equals 2s when delivery keeps up with the request — which is exactly why
      // the on-demand restart path exists to bound recovery under a shortfall.
      "-g",
      String(Math.max(1, Math.round(this.fps * IOS_KEYFRAME_INTERVAL_SECONDS))),
      "-forced-idr",
      "1",
    );
    // Resolve the target encoder bitrate. An operator override
    // (`AUTOMOBILE_WEBRTC_BITRATE_KBPS`) always wins, on either capture kind.
    // Otherwise the resolution-derived default is applied *only* to a Simulator
    // target: #4349 justified the 0.1 bpp budget entirely from Simulator
    // screen-content measurements, so a physical device — whose higher-entropy
    // content 0.1 bpp may under-serve — falls back to VideoToolbox's own default
    // rather than inheriting a Simulator-scoped cap (#4375).
    //
    // Note on what this bounds: `-b:v` is an *average* (ABR) target for
    // h264_videotoolbox, not a peak ceiling — egress peaks above it by design.
    // The default therefore bounds *average* egress, which is the intended goal.
    // Bounding *peak* would require `-maxrate`/`-bufsize` (VideoToolbox
    // DataRateLimits), whose h264_videotoolbox support is ffmpeg-version-
    // dependent and unverified on our builds; that is deferred to a follow-up
    // rather than added speculatively (#4375).
    const encodedSize = scale ?? size;
    const explicitBitrateBps =
      this.options.bitrateBps && this.options.bitrateBps > 0 ? this.options.bitrateBps : undefined;
    // Explicit bitrate override > quality preset > resolution-aware Simulator default.
    const bitrateBps =
      explicitBitrateBps ??
      qualityPresetBitrateBps(this.options.quality) ??
      (this.captureKind === "simulator" ? defaultIosBitrateBps(encodedSize, this.fps) : undefined);
    if (bitrateBps !== undefined) {
      args.push("-b:v", String(Math.round(bitrateBps)));
    }
    args.push("-f", "h264", "pipe:1");
    return args;
  }
}

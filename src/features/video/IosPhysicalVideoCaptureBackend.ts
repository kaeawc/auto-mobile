import { ActionableError, type BootedDevice } from "../../models";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import { getFileSize, waitForExit, type ProcessTracker } from "../../utils/ChildProcessTracker";
import {
  DefaultHostCommandExecutor,
  type HostCommandExecutor,
} from "../../utils/HostCommandExecutor";
import {
  DefaultFfmpegClient,
  type FfmpegClient,
  type FfmpegProcess,
} from "../../utils/media/FfmpegClient";
import type { DecodedFrame } from "../screen-stream/frameProtocol";
import {
  IOSScreenCaptureHelper,
  type IosScreenCaptureHelperOptions,
} from "../screen-stream/IOSScreenCaptureHelper";
import { ScreenCaptureHelperProvider } from "../screen-stream/ScreenCaptureHelperProvider";
import {
  IOS_SCREEN_CAPTURE_HELPER_ENV,
  readScreenCaptureHelperEnvOverride,
  resolveIosScreenCaptureHelperPath,
} from "../screen-stream/screenCaptureHelperPath";
import type {
  RecordingHandle,
  RecordingResult,
  VideoCaptureBackend,
  VideoCaptureConfig,
} from "./VideoRecorderService";

/** Hardware H.264 encoder used whenever the host ffmpeg exposes it. */
export const VIDEOTOOLBOX_H264_ENCODER = "h264_videotoolbox";
/** Software fallback for an ffmpeg built without VideoToolbox. */
export const SOFTWARE_H264_ENCODER = "libx264";

/** Bytes per BGRA pixel — the helper's only raw pixel format. */
const BGRA_BYTES_PER_PIXEL = 4;

/** How long ffmpeg gets to finalize the MP4 (moov atom) after stdin closes. */
export const IOS_PHYSICAL_ENCODER_FINALIZE_TIMEOUT_MS = 30000;

/**
 * Ceiling on repeated frames used to hold a capture gap at its real duration.
 * Beyond this the recording is allowed to compress rather than write unbounded
 * duplicates of a multi-megabyte frame.
 */
const MAX_GAP_FILL_SECONDS = 2;

/** Stderr lines retained from the helper for failure diagnostics. */
const HELPER_STDERR_TAIL = 20;

/**
 * One entry of the helper's `--list-devices` JSON. Mirrors the Swift
 * `DeviceInfo` (`ios/screen-capture/Sources/ScreenCaptureCore/DeviceInfo.swift`).
 */
export interface CaptureDeviceInfo {
  uniqueID: string;
  localizedName: string;
  modelID: string;
  manufacturer: string;
}

/**
 * Enumerates the AVFoundation muxed capture devices the helper can see. The
 * `uniqueID` AVFoundation reports is *not* guaranteed to be spelled like the
 * AutoMobile UDID, and `--device-id` matches it exactly (see
 * `ScreenCaptureHelper/main.swift`), so the mapping has to be resolved here.
 */
export interface CaptureDeviceLister {
  list(binaryPath: string): Promise<CaptureDeviceInfo[]>;
}

/** Resolution seam for the signed `screen-capture-helper` binary. */
export interface ScreenCaptureHelperEnsurer {
  ensure(): Promise<string | null>;
}

/**
 * The slice of {@link IOSScreenCaptureHelper} this backend drives. Narrow on
 * purpose: a fake only has to emit frames and exit.
 */
export interface PhysicalIosCaptureHelper {
  start(): void | Promise<void>;
  stop(): Promise<unknown>;
  on(event: "frame", listener: (frame: DecodedFrame) => void): unknown;
  on(event: "stderr", listener: (line: string) => void): unknown;
  on(
    event: "exit",
    listener: (info: { code: number | null; signal: NodeJS.Signals | null }) => void,
  ): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export type PhysicalIosCaptureHelperFactory = (
  options: IosScreenCaptureHelperOptions,
) => PhysicalIosCaptureHelper;

export interface IosPhysicalVideoCaptureBackendOptions {
  ffmpegClient?: FfmpegClient;
  helperProvider?: ScreenCaptureHelperEnsurer;
  deviceLister?: CaptureDeviceLister;
  createHelper?: PhysicalIosCaptureHelperFactory;
  /** Injectable so the non-macOS rejection is testable on any CI host. */
  platformProvider?: () => NodeJS.Platform;
  /** Injectable so file-size reporting stays device- and disk-free in tests. */
  fileSize?: (filePath: string) => Promise<number | undefined>;
  encoderFinalizeTimeoutMs?: number;
  /** Env seam so the developer override can be exercised without touching process.env. */
  env?: NodeJS.ProcessEnv;
  /** Existence seam for the overridden helper path. */
  helperPathExists?: (candidate: string) => boolean;
}

interface IosPhysicalBackendHandle {
  kind: "ios-physical";
  helper: PhysicalIosCaptureHelper;
  state: CaptureState;
  config: VideoCaptureConfig;
}

/** Mutable capture bookkeeping shared between `start` and `stop`. */
interface CaptureState {
  encoder?: FfmpegProcess;
  encoderTracker?: ProcessTracker;
  /** Frame geometry locked from the first frame; later mismatches are dropped. */
  geometry?: { width: number; height: number };
  /** Encoder chosen up front so the first frame can spawn ffmpeg synchronously. */
  encoderName: string;
  /** Capture timestamp the next admitted frame must reach, for fps pacing. */
  nextFrameDueMs?: number;
  /** Frames discarded purely to hold the declared cadence (not a fault). */
  framesPacedOut: number;
  /** Repeated frames written to keep a capture gap at its real duration. */
  framesGapFilled: number;
  /** Last payload written, repeated across gap slots that precede a new frame. */
  lastPayload?: Buffer;
  /** Gap slots left unpadded, so the output is shorter than wall clock. */
  framesGapTruncated: number;
  framesWritten: number;
  framesDropped: number;
  helperStderr: string[];
  helperExit?: { code: number | null; signal: NodeJS.Signals | null };
  /** First error emitted by the helper process (spawn ENOENT/EACCES, etc.). */
  helperError?: Error;
  /** True once we asked the helper to stop, so its exit is expected. */
  stopRequested: boolean;
  /** Whether the observed exit happened after we asked the helper to stop. */
  helperExitWasRequested: boolean;
}

/**
 * `xcrun devicectl` has no screen-recording verb and `simctl io recordVideo` is
 * Simulator-only, so physical-iOS capture goes through the Swift
 * `screen-capture-helper`: CoreMediaIO exposes the USB-connected device as a
 * muxed `AVCaptureDevice`, the helper streams its BGRA frames to stdout, and
 * this backend pipes them into `ffmpeg -f rawvideo` for H.264 encoding.
 *
 * Structurally this mirrors {@link FfmpegVideoProcessingBackend}'s Android path
 * (`adb exec-out screenrecord -` → ffmpeg stdin); the difference is the input
 * format, and that raw frames carry no geometry, so ffmpeg cannot be spawned
 * until the first frame pins `-video_size` (issue #2504).
 */
export class IosPhysicalVideoCaptureBackend implements VideoCaptureBackend {
  private readonly ffmpegClient: FfmpegClient;
  private readonly helperProvider: ScreenCaptureHelperEnsurer;
  private readonly deviceLister: CaptureDeviceLister;
  private readonly createHelper: PhysicalIosCaptureHelperFactory;
  private readonly platformProvider: () => NodeJS.Platform;
  private readonly fileSize: (filePath: string) => Promise<number | undefined>;
  private readonly encoderFinalizeTimeoutMs: number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly helperPathExists?: (candidate: string) => boolean;

  constructor(options: IosPhysicalVideoCaptureBackendOptions = {}) {
    this.ffmpegClient = options.ffmpegClient ?? new DefaultFfmpegClient();
    this.helperProvider = options.helperProvider ?? ScreenCaptureHelperProvider.getInstance();
    this.deviceLister = options.deviceLister ?? new HelperCaptureDeviceLister();
    this.createHelper =
      options.createHelper ?? ((helperOptions) => new IOSScreenCaptureHelper(helperOptions));
    this.platformProvider = options.platformProvider ?? (() => process.platform);
    this.fileSize = options.fileSize ?? getFileSize;
    this.encoderFinalizeTimeoutMs =
      options.encoderFinalizeTimeoutMs ?? IOS_PHYSICAL_ENCODER_FINALIZE_TIMEOUT_MS;
    this.env = options.env ?? process.env;
    this.helperPathExists = options.helperPathExists;
  }

  async start(config: VideoCaptureConfig): Promise<RecordingHandle> {
    const device = config.device;
    if (!device) {
      throw new ActionableError("Device is required to start video recording.");
    }
    if (this.platformProvider() !== "darwin") {
      throw new ActionableError(
        "Physical iOS video recording requires macOS: the capture path uses CoreMediaIO/AVFoundation " +
          "through the screen-capture-helper, which only exists on macOS.",
      );
    }

    const { abortSignal } = config;
    throwIfCaptureStartAborted(abortSignal);
    const encoderName = await this.resolveEncoder();
    throwIfCaptureStartAborted(abortSignal);
    const binaryPath = await this.resolveHelperBinary();
    throwIfCaptureStartAborted(abortSignal);
    const uniqueId = await this.resolveCaptureUniqueId(binaryPath, device);
    throwIfCaptureStartAborted(abortSignal);

    const state: CaptureState = {
      encoderName,
      framesWritten: 0,
      framesDropped: 0,
      framesPacedOut: 0,
      framesGapFilled: 0,
      framesGapTruncated: 0,
      stopRequested: false,
      helperExitWasRequested: false,
      helperStderr: [],
    };
    const helper = this.createHelper({
      binaryPath,
      target: { kind: "device", deviceId: uniqueId },
    });

    helper.on("stderr", (line) => {
      state.helperStderr.push(line);
      if (state.helperStderr.length > HELPER_STDERR_TAIL) {
        state.helperStderr.shift();
      }
    });
    helper.on("exit", (info) => {
      state.helperExit = info;
      // Classify at the moment of exit: afterwards, `stopRequested` cannot tell
      // an exit we caused from one that raced our stop.
      state.helperExitWasRequested = state.stopRequested;
    });
    helper.on("error", (error) => {
      // A spawn failure (ENOENT/EACCES on the resolved binary) arrives here
      // asynchronously, after start() has already returned, and may never be
      // followed by an 'exit'. Keep the first one so stop() can report the real
      // cause instead of a misleading "connect and trust the device" message. An
      // unhandled 'error' listener would also crash the daemon.
      state.helperError ??= error instanceof Error ? error : new Error(String(error));
      logger.warn(`[IosPhysicalVideo] capture helper error: ${errorMessage(error)}`);
    });
    helper.on("frame", (frame) => this.onFrame(frame, state, config));

    try {
      await helper.start();
    } catch (error) {
      // The frame listener is already wired, so a helper that emitted a frame
      // before rejecting may have spawned ffmpeg. No handle is returned here, so
      // nothing else could ever stop it.
      await this.abandonStartedCapture(helper, state);
      throw error;
    }

    if (abortSignal?.aborted) {
      // Shutdown landed while the helper was spawning: tear it down here, or the
      // capture process outlives the recording that was never handed back.
      await this.abandonStartedCapture(helper, state);
      throwIfCaptureStartAborted(abortSignal);
    }

    return {
      recordingId: config.recordingId,
      outputPath: config.outputPath,
      startedAt: config.startedAt,
      backendHandle: {
        kind: "ios-physical",
        helper,
        state,
        config,
      } satisfies IosPhysicalBackendHandle,
    };
  }

  async stop(handle: RecordingHandle): Promise<RecordingResult> {
    const backendHandle = handle.backendHandle as IosPhysicalBackendHandle | undefined;
    if (!backendHandle || backendHandle.kind !== "ios-physical") {
      throw new Error("Missing backend handle for physical iOS video recording.");
    }
    const { helper, state, config } = backendHandle;

    state.stopRequested = true;
    await helper.stop();

    const encoder = state.encoder;
    if (!encoder) {
      throw new ActionableError(this.buildNoFramesMessage(state));
    }

    // Closing stdin is what makes ffmpeg write the moov atom; a SIGKILL here
    // would leave an unplayable file, so wait for a clean exit instead.
    encoder.stdin?.end();
    if (state.encoderTracker) {
      // `signal: null`: closing stdin is the finalize mechanism, so a SIGINT here
      // would race the moov write. The timeout still escalates to SIGKILL if the
      // encoder wedges, matching the iOS simulator stop discipline.
      await waitForExit(encoder, state.encoderTracker.exitPromise, {
        timeoutMs: this.encoderFinalizeTimeoutMs,
        signal: null,
      });
    }

    this.assertEncoderSucceeded(state, handle.outputPath);
    this.assertHelperSucceeded(state, handle.outputPath);

    const sizeBytes = await this.fileSize(handle.outputPath);
    this.logCaptureAccounting(state, config, handle);

    return {
      recordingId: handle.recordingId,
      outputPath: handle.outputPath,
      startedAt: handle.startedAt,
      endedAt: state.encoderTracker?.exitState.endedAt ?? new Date().toISOString(),
      sizeBytes,
      codec: "h264",
    };
  }

  async forceStop(handle: RecordingHandle): Promise<void> {
    const backendHandle = handle.backendHandle as IosPhysicalBackendHandle | undefined;
    if (!backendHandle || backendHandle.kind !== "ios-physical") {
      throw new Error("Missing backend handle for physical iOS video recording.");
    }
    await backendHandle.helper.stop();
    const encoder = backendHandle.state.encoder;
    if (encoder && encoder.exitCode === null && !encoder.killed) {
      encoder.kill("SIGKILL");
    }
  }

  private onFrame(frame: DecodedFrame, state: CaptureState, config: VideoCaptureConfig): void {
    const { width, height } = frame.header;
    if (!state.geometry) {
      state.geometry = { width, height };
      this.startEncoder(state, config, width, height);
    } else if (state.geometry.width !== width || state.geometry.height !== height) {
      // rawvideo has no per-frame geometry: a differently sized frame would be
      // read as a shifted picture for the rest of the file, so drop it.
      state.framesDropped += 1;
      return;
    }

    const encoder = state.encoder;
    if (!encoder?.stdin || encoder.stdin.writableEnded) {
      state.framesDropped += 1;
      return;
    }
    // Congestion is checked BEFORE admission on purpose. Frames arrive from an
    // event emitter, so there is no upstream backpressure to apply and buffering
    // would grow without bound — but consuming the pacing slot for a frame that
    // never reaches stdin would silently shorten the timeline. Dropping before
    // admission leaves the slot owed, so the next frame pads it as a gap.
    if (encoder.stdin.writableNeedDrain) {
      state.framesDropped += 1;
      return;
    }

    const copies = this.admitForPacing(frame, state, config.fps);
    if (copies === 0) {
      return;
    }

    this.writeFrameCopies(frame, state, encoder.stdin, copies);
  }

  /**
   * Write the frame into its own slot, preceded by repeats of the previous
   * picture for any slots the capture gap skipped. Padding with the NEW frame
   * would move a visual transition earlier than it actually happened.
   */
  private writeFrameCopies(
    frame: DecodedFrame,
    state: CaptureState,
    stdin: NonNullable<FfmpegProcess["stdin"]>,
    copies: number,
  ): void {
    const payload = packFrame(frame);
    const fillPayload = state.lastPayload ?? payload;
    for (let copy = 0; copy < copies; copy++) {
      const isCurrentFrameSlot = copy === copies - 1;
      // Stop padding the moment the encoder falls behind — gap fill must never
      // be the thing that congests it — but always emit the real frame.
      if (copy > 0 && !isCurrentFrameSlot && stdin.writableNeedDrain) {
        state.framesGapTruncated += copies - copy - 1;
        stdin.write(payload);
        state.framesWritten += 1;
        state.lastPayload = payload;
        return;
      }
      stdin.write(isCurrentFrameSlot ? payload : fillPayload);
      state.framesWritten += 1;
    }
    state.lastPayload = payload;
  }

  /**
   * Hold the declared cadence. AVFoundation device capture is deliberately not
   * FPS-throttled by the helper (`DeviceCaptureSession.deviceFPS` documents
   * this), so a device pushing 30 or 60 fps into a `-framerate 15` rawvideo
   * stream would timestamp every frame at 15 fps — the recording would play back
   * 2-4x slow and `-t` would cut it short. Admit a frame only once its capture
   * timestamp reaches the next scheduled slot.
   */
  private admitForPacing(frame: DecodedFrame, state: CaptureState, fps: number): number {
    const intervalMs = 1000 / fps;
    const timestampMs = frame.header.timestampMs;
    if (state.nextFrameDueMs === undefined) {
      state.nextFrameDueMs = timestampMs + intervalMs;
      return 1;
    }
    if (timestampMs < state.nextFrameDueMs) {
      state.framesPacedOut += 1;
      return 0;
    }

    // Slots that elapsed with nothing to encode: a helper stall, or a device
    // that idles while the screen is static. `-framerate` gives every written
    // frame a contiguous fixed-rate timestamp, so skipping those slots would
    // compress real time — a 5s freeze would play back in a fraction of a
    // second, and a duration-capped recording would end early. Repeat the frame
    // to keep the encoded timeline on wall clock.
    const missedSlots = Math.floor((timestampMs - state.nextFrameDueMs) / intervalMs);
    const maxGapFill = Math.ceil(fps * MAX_GAP_FILL_SECONDS);
    const gapFill = Math.min(missedSlots, maxGapFill);
    if (missedSlots > gapFill) {
      // Padding an arbitrarily long stall would write unbounded duplicate frames,
      // so very long gaps stay compressed; the recording is shorter than wall
      // clock by the excess, which the warning names.
      state.framesGapTruncated += missedSlots - gapFill;
    }
    state.framesGapFilled += gapFill;
    state.nextFrameDueMs = timestampMs + intervalMs;
    return gapFill + 1;
  }

  private startEncoder(
    state: CaptureState,
    config: VideoCaptureConfig,
    width: number,
    height: number,
  ): void {
    const args = buildRawVideoFfmpegArgs(config, width, height, state.encoderName);
    logger.info(
      `[IosPhysicalVideo] starting encoder: ${this.ffmpegClient.binaryPath} ${args.join(" ")}`,
    );
    const started = this.ffmpegClient.start({
      args,
      context: "physical iOS screen recording encoder",
      stdio: ["pipe", "pipe", "pipe"],
    });
    state.encoder = started.process;
    state.encoderTracker = started.tracker;
    started.process.stdin?.on("error", (error: Error) => {
      // ffmpeg exiting first closes stdin; the helper keeps writing until it is
      // stopped, so EPIPE here is expected rather than a fault to surface.
      logger.debug(`[IosPhysicalVideo] encoder stdin error (expected on encoder exit): ${error}`);
    });
  }

  /** One place for the per-recording frame accounting, all of it diagnostic. */
  private logCaptureAccounting(
    state: CaptureState,
    config: VideoCaptureConfig,
    handle: RecordingHandle,
  ): void {
    logger.info(
      `[IosPhysicalVideo] recording ${handle.recordingId} wrote ${state.framesWritten} frame(s) to ${handle.outputPath}.`,
    );
    if (state.framesDropped > 0) {
      logger.warn(
        `[IosPhysicalVideo] dropped ${state.framesDropped} frame(s) whose geometry differed from the locked ` +
          `${state.geometry?.width}x${state.geometry?.height} capture size, or arrived while the encoder was congested.`,
      );
    }
    if (state.framesPacedOut > 0) {
      logger.debug(
        `[IosPhysicalVideo] paced out ${state.framesPacedOut} frame(s) to hold the requested cadence.`,
      );
    }
    if (state.framesGapFilled > 0) {
      logger.debug(
        `[IosPhysicalVideo] repeated ${state.framesGapFilled} frame(s) to keep capture gaps at their real duration.`,
      );
    }
    if (state.framesGapTruncated > 0) {
      logger.warn(
        `[IosPhysicalVideo] ${state.framesGapTruncated} gap slot(s) were left unpadded, so the recording is ` +
          `about ${(state.framesGapTruncated / config.fps).toFixed(1)}s shorter than the wall-clock capture.`,
      );
    }
  }

  /**
   * A nonzero ffmpeg exit (full disk, rejected encoder settings) leaves a
   * truncated file behind. Returning a successful RecordingResult would let the
   * service archive it as complete, so surface the encoder's own stderr instead
   * — the simulator path checks its tracker the same way.
   */
  private assertEncoderSucceeded(state: CaptureState, outputPath: string): void {
    const exitState = state.encoderTracker?.exitState;
    if (!exitState) {
      return;
    }
    const failed =
      (exitState.exitCode !== undefined &&
        exitState.exitCode !== null &&
        exitState.exitCode !== 0) ||
      Boolean(exitState.signal);
    if (!failed) {
      return;
    }
    const stderr = state.encoderTracker?.stderr.join("").trim();
    throw new ActionableError(
      `FFmpeg failed to finalize the physical iOS recording at ${outputPath} ` +
        `(exitCode: ${exitState.exitCode ?? "null"}, signal: ${exitState.signal ?? "null"}).` +
        (stderr ? `\nffmpeg: ${stderr}` : ""),
    );
  }

  /**
   * A helper that terminated on its own truncates the capture: the device was
   * unplugged, the capture session died, or the process crashed. ffmpeg still
   * finalizes the frames it did receive and exits 0, so without this check a
   * partial recording would be archived as complete. Checked after the encoder
   * is finalized, so the file on disk stays playable for diagnosis.
   *
   * The discriminator is whether we had asked the helper to stop yet — not the
   * exit code. Our own `stop()` produces `{ code: null, signal: "SIGTERM" }`,
   * which is indistinguishable by shape from an external `SIGABRT` crash.
   */
  private assertHelperSucceeded(state: CaptureState, outputPath: string): void {
    const stderr = state.helperStderr.join("").trim();
    const stderrSuffix = stderr ? `\nscreen-capture-helper: ${stderr}` : "";

    if (state.helperError) {
      throw new ActionableError(
        `The iOS capture helper failed during the recording, so ${outputPath} is truncated: ` +
          `${errorMessage(state.helperError)}.${stderrSuffix}`,
      );
    }

    const exit = state.helperExit;
    if (!exit || state.helperExitWasRequested) {
      return;
    }
    const cause =
      exit.signal !== null ? `signal ${exit.signal}` : `exit code ${exit.code ?? "null"}`;
    throw new ActionableError(
      `The iOS capture helper terminated with ${cause} before the recording was stopped, so ` +
        `${outputPath} is truncated. The device was most likely unplugged or lost its capture ` +
        `session.${stderrSuffix}`,
    );
  }

  /** Stop a capture that was cancelled between spawn and handle hand-off. */
  private async abandonStartedCapture(
    helper: PhysicalIosCaptureHelper,
    state: CaptureState,
  ): Promise<void> {
    state.stopRequested = true;
    try {
      await helper.stop();
    } catch (error) {
      // Already-aborting path: report the leak risk but keep the abort as the
      // error the caller sees.
      logger.warn(
        `[IosPhysicalVideo] failed to stop the capture helper after an aborted start: ${errorMessage(error)}`,
      );
    }
    const encoder = state.encoder;
    if (encoder && encoder.exitCode === null && !encoder.killed) {
      encoder.kill("SIGKILL");
    }
  }

  /**
   * Doubles as the ffmpeg availability check. VideoToolbox is present on every
   * supported macOS host, but a self-built ffmpeg can lack it, so fall back to
   * software encoding rather than failing the recording.
   */
  private async resolveEncoder(): Promise<string> {
    let encoders: string[];
    try {
      encoders = (await this.ffmpegClient.probe()).encoders;
    } catch (error) {
      throw new ActionableError(
        "FFmpeg is not available. Please install FFmpeg to use video recording.\n" +
          "  macOS: brew install ffmpeg\n" +
          `Error: ${errorMessage(error)}`,
      );
    }
    if (encoders.includes(VIDEOTOOLBOX_H264_ENCODER)) {
      return VIDEOTOOLBOX_H264_ENCODER;
    }
    if (!encoders.includes(SOFTWARE_H264_ENCODER)) {
      // Blindly naming an absent encoder would only fail once the first frame
      // spawns ffmpeg, and stop() would then report "no frames captured" — the
      // wrong cause entirely. Fail here, before the helper is started.
      throw new ActionableError(
        `This FFmpeg build exposes neither ${VIDEOTOOLBOX_H264_ENCODER} nor ${SOFTWARE_H264_ENCODER}, ` +
          "so a physical iOS recording cannot be encoded. Install an FFmpeg with H.264 support (macOS: brew install ffmpeg).",
      );
    }
    logger.warn(
      `[IosPhysicalVideo] ${VIDEOTOOLBOX_H264_ENCODER} unavailable; falling back to software ${SOFTWARE_H264_ENCODER}.`,
    );
    return SOFTWARE_H264_ENCODER;
  }

  private buildNoFramesMessage(state: CaptureState): string {
    const stderr = state.helperStderr.join("").trim();
    if (state.helperError) {
      return (
        `The iOS capture helper could not be run, so no recording was produced: ${errorMessage(state.helperError)}.` +
        (stderr ? `\nscreen-capture-helper: ${stderr}` : "")
      );
    }
    const exit = state.helperExit
      ? ` (helper exited code=${state.helperExit.code ?? "null"} signal=${state.helperExit.signal ?? "null"})`
      : "";
    return (
      `No frames were captured from the physical iOS device${exit}, so no recording was produced. ` +
      "Connect the device over USB and accept the Trust This Computer prompt, then retry." +
      (stderr ? `\nscreen-capture-helper: ${stderr}` : "")
    );
  }

  private async resolveHelperBinary(): Promise<string> {
    // Daemon startup skips the release prefetch when the developer override is
    // set, so a local build must win over the pinned release asset — the same
    // order IosH264Source.resolveHelperPath() uses.
    const override = readScreenCaptureHelperEnvOverride(this.env);
    if (override) {
      return resolveIosScreenCaptureHelperPath(override, {
        env: this.env,
        exists: this.helperPathExists,
      });
    }

    const binaryPath = await this.helperProvider.ensure();
    if (!binaryPath) {
      throw new ActionableError(
        "Physical iOS video recording requires the signed screen-capture-helper from the matching GitHub Release, " +
          "which could not be resolved. For local development, build it with `bash scripts/ios/swift-build.sh` and " +
          `set ${IOS_SCREEN_CAPTURE_HELPER_ENV} to the resulting absolute path.`,
      );
    }
    return binaryPath;
  }

  /**
   * Map the AutoMobile UDID onto the AVFoundation `uniqueID` the helper matches
   * on. The two agree on most hardware, but the reported id has been observed
   * without the UDID's hyphen, so fall back to a normalized comparison and then
   * — only when exactly one device is attached — to that device.
   */
  private async resolveCaptureUniqueId(binaryPath: string, device: BootedDevice): Promise<string> {
    const devices = await this.deviceLister.list(binaryPath);
    if (devices.length === 0) {
      throw new ActionableError(
        `No muxed external capture devices found for ${device.deviceId}. Connect the iPhone/iPad over USB, ` +
          "accept the Trust This Computer prompt, and make sure it is not already being captured by QuickTime.",
      );
    }

    const exact = devices.find((candidate) => candidate.uniqueID === device.deviceId);
    if (exact) {
      return exact.uniqueID;
    }

    const wanted = normalizeUdid(device.deviceId);
    const normalized = devices.find((candidate) => normalizeUdid(candidate.uniqueID) === wanted);
    if (normalized) {
      return normalized.uniqueID;
    }

    if (devices.length === 1) {
      logger.warn(
        `[IosPhysicalVideo] capture device uniqueID ${devices[0].uniqueID} does not match ${device.deviceId}; ` +
          "using the only attached device.",
      );
      return devices[0].uniqueID;
    }

    const candidates = devices
      .map((candidate) => `${candidate.uniqueID} (${candidate.localizedName})`)
      .join(", ");
    throw new ActionableError(
      `Could not match device ${device.deviceId} to an AVFoundation capture device. Attached: ${candidates}. ` +
        "Disconnect the other devices, or record the matching UDID.",
    );
  }
}

/**
 * Matches the Android/iOS ffmpeg start paths: a daemon shutdown mid-start must
 * abort the recording rather than leave a capture process behind.
 */
function throwIfCaptureStartAborted(abortSignal: AbortSignal | undefined): void {
  if (abortSignal?.aborted) {
    throw new ActionableError("Physical iOS recording start was cancelled during shutdown.");
  }
}

/** Largest even value <= `value`, floored at 2 so a scale filter stays valid. */
function evenFloor(value: number): number {
  const floored = Math.floor(value);
  return Math.max(2, floored % 2 === 0 ? floored : floored - 1);
}

/** Lowercased, separator-free UDID for cross-vocabulary comparison. */
function normalizeUdid(value: string): string {
  return value.replace(/-/g, "").toLowerCase();
}

/**
 * Strip row padding so the buffer is exactly `width * height * 4` bytes. The
 * helper reports `bytesPerRow` from the IOSurface, which AVFoundation aligns up;
 * feeding the padded rows to `-f rawvideo` would skew every row of the picture.
 */
export function packFrame(frame: DecodedFrame): Buffer {
  const { width, height, bytesPerRow } = frame.header;
  const rowBytes = width * BGRA_BYTES_PER_PIXEL;
  if (bytesPerRow === rowBytes) {
    return frame.pixels;
  }
  const packed = Buffer.allocUnsafe(rowBytes * height);
  for (let row = 0; row < height; row++) {
    frame.pixels.copy(packed, row * rowBytes, row * bytesPerRow, row * bytesPerRow + rowBytes);
  }
  return packed;
}

/**
 * ffmpeg argv for the raw-BGRA input. Kept as a free function so the encoder
 * contract can be asserted without spawning anything.
 */
export function buildRawVideoFfmpegArgs(
  config: VideoCaptureConfig,
  width: number,
  height: number,
  encoderName: string,
): string[] {
  const args = [
    "-f",
    "rawvideo",
    "-pixel_format",
    "bgra",
    "-video_size",
    `${width}x${height}`,
    "-framerate",
    String(config.fps),
    "-i",
    "pipe:0",
  ];

  // yuv420p subsamples chroma 2x2, so FFmpeg refuses an odd width or height —
  // and iPhone panels really are odd (the 1179px-wide fixtures in this repo).
  // The raw input keeps its true geometry (`-video_size` describes the actual
  // byte layout and must not be rounded); evenness is imposed on the OUTPUT.
  const requested = config.resolution;
  if (requested) {
    args.push("-vf", `scale=${evenFloor(requested.width)}:${evenFloor(requested.height)}`);
  } else if (width % 2 !== 0 || height % 2 !== 0) {
    args.push("-vf", `scale=${evenFloor(width)}:${evenFloor(height)}`);
  }

  args.push("-c:v", encoderName);
  if (encoderName === SOFTWARE_H264_ENCODER) {
    args.push("-preset", "ultrafast");
  }
  args.push("-b:v", `${config.targetBitrateKbps}k`);
  args.push("-pix_fmt", "yuv420p");
  args.push("-movflags", "+faststart");

  if (config.maxDurationSeconds && config.maxDurationSeconds > 0) {
    args.push("-t", String(config.maxDurationSeconds));
  }

  args.push("-y", config.outputPath);
  return args;
}

/**
 * Production {@link CaptureDeviceLister}: runs the helper's `--list-devices`
 * mode, which prints the JSON device list to stdout and exits.
 */
export class HelperCaptureDeviceLister implements CaptureDeviceLister {
  constructor(
    private readonly executor: HostCommandExecutor = new DefaultHostCommandExecutor(),
    private readonly timeoutMs: number = 15000,
  ) {}

  async list(binaryPath: string): Promise<CaptureDeviceInfo[]> {
    const result = await this.executor.executeCommand(binaryPath, ["--list-devices"], {
      timeoutMs: this.timeoutMs,
    });
    return parseCaptureDeviceList(result.stdout);
  }
}

/** Parse the `--list-devices` envelope, tolerating a helper that lists nothing. */
export function parseCaptureDeviceList(stdout: string): CaptureDeviceInfo[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new ActionableError(
      `screen-capture-helper --list-devices returned unparseable output: ${errorMessage(error)}`,
    );
  }
  const devices = (parsed as { devices?: unknown } | null)?.devices;
  if (!Array.isArray(devices)) {
    throw new ActionableError(
      "screen-capture-helper --list-devices returned no `devices` array; the helper may be out of date.",
    );
  }
  return devices
    .map((entry) => entry as Partial<CaptureDeviceInfo> | null)
    .filter(
      (entry): entry is Partial<CaptureDeviceInfo> & { uniqueID: string } =>
        typeof entry?.uniqueID === "string" && entry.uniqueID.length > 0,
    )
    .map((entry) => ({
      uniqueID: entry.uniqueID,
      localizedName: entry.localizedName ?? entry.uniqueID,
      modelID: entry.modelID ?? "",
      manufacturer: entry.manufacturer ?? "",
    }));
}

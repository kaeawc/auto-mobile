import { ActionableError, type BootedDevice } from "../../models";
import {
  getFileSize,
  PROCESS_EXIT_TIMEOUT_MS,
  ProcessTeardownUnconfirmedError,
  waitForExit,
} from "../../utils/ChildProcessTracker";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { DefaultFfmpegClient, type FfmpegClient } from "../../utils/media/FfmpegClient";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { IosScreenCaptureHelper } from "../screen-stream/IosScreenCaptureHelper";
import { ScreenCaptureHelperProvider } from "../screen-stream/ScreenCaptureHelperProvider";
import type { DecodedEncodedVideo } from "../screen-stream/frameProtocol";
import {
  IOS_SCREEN_CAPTURE_HELPER_ENV,
  readScreenCaptureHelperEnvOverride,
  resolveIosScreenCaptureHelperPath,
} from "../screen-stream/screenCaptureHelperPath";
import { HelperCaptureDeviceLister } from "./HelperCaptureDeviceLister";
import {
  CaptureDeviceLister,
  CaptureState,
  IosPhysicalBackendHandle,
  IosPhysicalVideoCaptureBackendOptions,
  PhysicalIosCaptureHelper,
  PhysicalIosCaptureHelperFactory,
  ScreenCaptureHelperEnsurer,
} from "./IosPhysicalVideoCaptureTypes";
import {
  VideoCaptureFinalizationError,
  VideoCaptureStartCleanupError,
  type RecordingHandle,
  type RecordingResult,
  type VideoCaptureBackend,
  type VideoCaptureConfig,
} from "./VideoRecorderService";
import {
  buildDeviceEncodeSettings,
  buildEncodedCopyFfmpegArgs,
  HELPER_STDERR_TAIL,
  IOS_PHYSICAL_ENCODER_FINALIZE_TIMEOUT_MS,
  normalizeUdid,
} from "./iosPhysicalVideoEncoding";
export { parseCaptureDeviceList } from "./HelperCaptureDeviceLister";
export {
  type CaptureDeviceInfo,
  type CaptureDeviceLister,
  type IosPhysicalVideoCaptureBackendOptions,
  type PhysicalIosCaptureHelper,
  type PhysicalIosCaptureHelperFactory,
  type ScreenCaptureHelperEnsurer,
} from "./IosPhysicalVideoCaptureTypes";
export { buildDeviceEncodeSettings, buildEncodedCopyFfmpegArgs } from "./iosPhysicalVideoEncoding";

/**
 * `xcrun devicectl` has no screen-recording verb and `simctl io recordVideo` is
 * Simulator-only, so physical-iOS capture goes through the Swift
 * `screen-capture-helper`: CoreMediaIO exposes the USB-connected device as a
 * muxed `AVCaptureDevice`, and the helper encodes it to H.264 in-process
 * (`--encode h264`). This backend stream-copies those Annex-B records into an
 * MP4 with `ffmpeg -c copy`, so no pixels cross the pipe and ffmpeg never
 * re-encodes.
 *
 * Structurally this mirrors {@link FfmpegVideoProcessingBackend}'s Android path
 * (`adb exec-out screenrecord -` → ffmpeg stdin). ffmpeg is spawned at the first
 * keyframe, the earliest point a stream copy can start.
 */
export class IosPhysicalVideoCaptureBackend implements VideoCaptureBackend {
  private readonly ffmpegClient: FfmpegClient;
  private readonly helperProvider: ScreenCaptureHelperEnsurer;
  private readonly deviceLister: CaptureDeviceLister;
  private readonly createHelper: PhysicalIosCaptureHelperFactory;
  private readonly platformProvider: () => NodeJS.Platform;
  private readonly fileSize: (filePath: string) => Promise<number | undefined>;
  private readonly encoderFinalizeTimeoutMs: number;
  private readonly now: () => number;
  private readonly timer: Timer;
  private readonly env: NodeJS.ProcessEnv;
  private readonly helperPathExists?: (candidate: string) => boolean;

  constructor(options: IosPhysicalVideoCaptureBackendOptions = {}) {
    this.ffmpegClient = options.ffmpegClient ?? new DefaultFfmpegClient();
    this.helperProvider = options.helperProvider ?? ScreenCaptureHelperProvider.getInstance();
    this.deviceLister = options.deviceLister ?? new HelperCaptureDeviceLister();
    this.createHelper =
      options.createHelper ?? ((helperOptions) => new IosScreenCaptureHelper(helperOptions));
    this.platformProvider = options.platformProvider ?? (() => process.platform);
    this.fileSize = options.fileSize ?? getFileSize;
    this.encoderFinalizeTimeoutMs =
      options.encoderFinalizeTimeoutMs ?? IOS_PHYSICAL_ENCODER_FINALIZE_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.timer = options.timer ?? defaultTimer;
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
    await this.ensureFfmpegAvailable(abortSignal);
    throwIfCaptureStartAborted(abortSignal);
    const binaryPath = await this.resolveHelperBinary(abortSignal);
    throwIfCaptureStartAborted(abortSignal);
    const uniqueId = await this.resolveCaptureUniqueId(binaryPath, device, abortSignal);
    throwIfCaptureStartAborted(abortSignal);

    const state: CaptureState = {
      framesWritten: 0,
      framesDropped: 0,
      stopRequested: false,
      helperExitWasRequested: false,
      helperStderr: [],
    };
    const helper = this.createHelper({
      binaryPath,
      target: { kind: "device", deviceId: uniqueId, encode: buildDeviceEncodeSettings(config) },
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
      const spawnError = error as NodeJS.ErrnoException;
      // Node and Bun label deferred spawn failures with `spawn <executable>`.
      // kill/send/abort errors do not prove exit; never infer it from message text.
      if (
        spawnError.syscall?.startsWith("spawn ") &&
        ["ENOENT", "EACCES", "EAGAIN", "EMFILE", "ENFILE"].includes(spawnError.code ?? "") &&
        !state.encoder &&
        !state.helperExit
      ) {
        state.helperSpawnError ??= error;
      }
      logger.warn(`[IosPhysicalVideo] capture helper error: ${errorMessage(error)}`);
    });
    helper.on("encodedVideo", (video) => this.onEncodedVideo(video, state, config));

    const handle: RecordingHandle = {
      recordingId: config.recordingId,
      outputPath: config.outputPath,
      startedAt: config.startedAt,
      effectiveConfig: config,
      backendHandle: {
        kind: "ios-physical",
        helper,
        state,
        config,
      } satisfies IosPhysicalBackendHandle,
    };

    try {
      await waitForCaptureStart(Promise.resolve(helper.start()), abortSignal);
    } catch (error) {
      // The frame listener is already wired, so a helper that emitted a frame
      // before rejecting may have spawned ffmpeg. No handle is returned here, so
      // nothing else could ever stop it.
      try {
        await this.abandonStartedCapture(helper, state);
      } catch (cleanupError) {
        throw new VideoCaptureStartCleanupError(
          `Failed to clean up physical iOS recording after startup failed: ${errorMessage(cleanupError)}`,
          handle,
          { cause: error },
        );
      }
      throw error;
    }

    if (abortSignal?.aborted) {
      // Shutdown landed while the helper was spawning: tear it down here, or the
      // capture process outlives the recording that was never handed back.
      try {
        await this.abandonStartedCapture(helper, state);
      } catch (cleanupError) {
        throw new VideoCaptureStartCleanupError(
          `Failed to clean up physical iOS recording after startup was cancelled: ${errorMessage(cleanupError)}`,
          handle,
        );
      }
      throwIfCaptureStartAborted(abortSignal);
    }

    return handle;
  }

  async stop(handle: RecordingHandle): Promise<RecordingResult> {
    const backendHandle = handle.backendHandle as IosPhysicalBackendHandle | undefined;
    if (!backendHandle || backendHandle.kind !== "ios-physical") {
      throw new Error("Missing backend handle for physical iOS video recording.");
    }
    const { helper, state } = backendHandle;

    state.stopRequested = true;
    // Sample the clock BEFORE the helper shutdown: it SIGTERMs the capture
    // process and waits out a grace period, and padding to a post-shutdown
    // clock would encode that latency as trailing video the user never saw.
    const stopRequestedAtMs = this.now();
    try {
      await helper.stop();
      if (state.helperSpawnError) {
        throw new ActionableError(this.buildNoFramesMessage(state), {
          cause: state.helperSpawnError,
        });
      }
      if (!state.helperExit) {
        throw new ProcessTeardownUnconfirmedError(
          "Physical iOS capture helper exit was not observed; it may still be running.",
        );
      }

      return await this.finalizeStoppedRecording(handle, backendHandle, stopRequestedAtMs);
    } catch (error) {
      // helper.stop() can return after signaling without observing exit. An
      // observed exit or a structured failed spawn authorizes owner release.
      if (!state.helperExit && !state.helperSpawnError) {
        throw error;
      }
      throw await this.buildFinalizationError(state, error);
    }
  }

  private async buildFinalizationError(
    state: CaptureState,
    error: unknown,
  ): Promise<VideoCaptureFinalizationError> {
    try {
      if (state.encoder && state.encoderTracker) {
        await waitForExit(state.encoder, state.encoderTracker.exitPromise, {
          timeoutMs: 0,
          signal: "SIGKILL",
          timer: this.timer,
        });
      }
    } catch (cleanupError) {
      logger.warn(
        `[IosPhysicalVideo] Failed to clean up recording encoder: ${errorMessage(cleanupError)}`,
        cleanupError,
      );
    }
    return new VideoCaptureFinalizationError(
      state.helperSpawnError
        ? `Physical iOS capture never started. Start a new recording. ${this.buildNoFramesMessage(state)}`
        : `Physical iOS capture exited but the recording produced no usable video (zero bytes / finalization failed). Start a new recording. ${errorMessage(error)}`,
      { cause: state.helperSpawnError ?? error },
    );
  }

  private async finalizeStoppedRecording(
    handle: RecordingHandle,
    backendHandle: IosPhysicalBackendHandle,
    stopRequestedAtMs: number,
  ): Promise<RecordingResult> {
    const { state } = backendHandle;
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
        timer: this.timer,
      });
    }

    this.assertEncoderSucceeded(state, handle.outputPath);
    this.assertHelperSucceeded(state, handle.outputPath);

    const sizeBytes = await this.fileSize(handle.outputPath);
    if (!sizeBytes) {
      throw new ActionableError(
        "The finalized physical iOS recording is missing or contains zero bytes.",
      );
    }
    this.logCaptureAccounting(state, handle);

    return {
      recordingId: handle.recordingId,
      outputPath: handle.outputPath,
      startedAt: handle.startedAt,
      endedAt: new Date(stopRequestedAtMs).toISOString(),
      sizeBytes,
      codec: "h264",
    };
  }

  async forceStop(handle: RecordingHandle): Promise<void> {
    const backendHandle = handle.backendHandle as IosPhysicalBackendHandle | undefined;
    if (!backendHandle || backendHandle.kind !== "ios-physical") {
      throw new Error("Missing backend handle for physical iOS video recording.");
    }
    backendHandle.state.stopRequested = true;
    const cleanupOperations: Promise<unknown>[] = [backendHandle.helper.stop()];
    const encoder = backendHandle.state.encoder;
    if (encoder && backendHandle.state.encoderTracker) {
      cleanupOperations.push(
        waitForExit(encoder, backendHandle.state.encoderTracker.exitPromise, {
          timeoutMs: 0,
          forceKillTimeoutMs: PROCESS_EXIT_TIMEOUT_MS,
          signal: "SIGKILL",
          timer: this.timer,
        }),
      );
    } else if (encoder && encoder.exitCode === null) {
      encoder.kill("SIGKILL");
    }
    const results = await Promise.allSettled(cleanupOperations);
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Failed to fully stop physical iOS recording: ${failures.map(errorMessage).join("; ")}`,
      );
    }
  }

  /**
   * The encoded stream is muxed by stream copy, so ffmpeg can only join it at an
   * IDR: records before the first keyframe cannot be decoded and are dropped. The
   * first keyframe carries the SPS/PPS ffmpeg's raw H.264 demuxer needs to probe
   * the stream, so spawning waits for it.
   */
  private onEncodedVideo(
    video: DecodedEncodedVideo,
    state: CaptureState,
    config: VideoCaptureConfig,
  ): void {
    if (state.stopRequested && !state.encoder) {
      return;
    }
    if (!state.encoder) {
      if (!video.keyframe) {
        state.framesDropped += 1;
        return;
      }
      this.startEncoder(state, config);
    }
    const stdin = state.encoder?.stdin;
    if (!stdin || stdin.writableEnded) {
      state.framesDropped += 1;
      return;
    }
    stdin.write(video.payload);
    state.framesWritten += 1;
  }

  private startEncoder(state: CaptureState, config: VideoCaptureConfig): void {
    const args = buildEncodedCopyFfmpegArgs(config);
    logger.info(
      `[IosPhysicalVideo] starting muxer: ${this.ffmpegClient.binaryPath} ${args.join(" ")}`,
    );
    const started = this.ffmpegClient.start({
      args,
      context: "physical iOS screen recording muxer",
      stdio: ["pipe", "pipe", "pipe"],
    });
    state.encoder = started.process;
    state.encoderTracker = started.tracker;
    started.process.stdin?.on("error", (error: Error) => {
      // ffmpeg exiting first closes stdin; the helper keeps writing until it is
      // stopped, so EPIPE here is expected rather than a fault to surface.
      logger.debug(`[IosPhysicalVideo] muxer stdin error (expected on muxer exit): ${error}`);
    });
  }

  /** One place for the per-recording record accounting, all of it diagnostic. */
  private logCaptureAccounting(state: CaptureState, handle: RecordingHandle): void {
    logger.info(
      `[IosPhysicalVideo] recording ${handle.recordingId} wrote ${state.framesWritten} encoded record(s) to ${handle.outputPath}.`,
    );
    if (state.framesDropped > 0) {
      logger.debug(
        `[IosPhysicalVideo] dropped ${state.framesDropped} encoded record(s) that arrived before the first keyframe.`,
      );
    }
  }

  /**
   * ffmpeg is the only external prerequisite left on this path: the helper
   * encodes, so there is no encoder to select, only a binary that must exist.
   */
  private async ensureFfmpegAvailable(signal?: AbortSignal): Promise<void> {
    try {
      await waitForCaptureStart(this.ffmpegClient.probe({ signal }), signal);
    } catch (error) {
      throwIfCaptureStartAborted(signal);
      throw new ActionableError(
        "FFmpeg is not available. Please install FFmpeg to use video recording.\n" +
          "  macOS: brew install ffmpeg\n" +
          `Error: ${errorMessage(error)}`,
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
    await helper.stop();
    const cleanupOperations: Promise<unknown>[] = [];
    const encoder = state.encoder;
    if (encoder && state.encoderTracker) {
      cleanupOperations.push(
        waitForExit(encoder, state.encoderTracker.exitPromise, {
          timeoutMs: 0,
          forceKillTimeoutMs: PROCESS_EXIT_TIMEOUT_MS,
          signal: "SIGKILL",
          timer: this.timer,
        }),
      );
    } else if (encoder && encoder.exitCode === null) {
      encoder.kill("SIGKILL");
    }
    const results = await Promise.allSettled(cleanupOperations);
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Failed to abandon physical iOS recording start: ${failures.map(errorMessage).join("; ")}`,
      );
    }
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

  private async resolveHelperBinary(signal?: AbortSignal): Promise<string> {
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

    const binaryPath = await waitForCaptureStart(this.helperProvider.ensure(signal), signal);
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
  private async resolveCaptureUniqueId(
    binaryPath: string,
    device: BootedDevice,
    signal?: AbortSignal,
  ): Promise<string> {
    const devices = await waitForCaptureStart(this.deviceLister.list(binaryPath, signal), signal);
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

async function waitForCaptureStart<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfCaptureStartAborted(signal);
  if (!signal) {
    return operation;
  }
  const cancellation = new AbortController();
  const abortListener = () =>
    cancellation.abort(
      new ActionableError("Physical iOS recording start was cancelled during shutdown."),
    );
  signal.addEventListener("abort", abortListener, { once: true });
  try {
    return await raceWithDeadline(operation, {
      timer: defaultTimer,
      signal: cancellation.signal,
      label: "Physical iOS recording start",
    });
  } finally {
    if (abortListener) {
      signal.removeEventListener("abort", abortListener);
    }
  }
}

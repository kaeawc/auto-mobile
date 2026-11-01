import { platform } from "node:os";
import path from "node:path";
import { readProcessGenerationTokenForPid } from "../../daemon/daemonFiles";
import { ActionableError, type BootedDevice } from "../../models";
import {
  PROCESS_EXIT_TIMEOUT_MS,
  trackProcess,
  waitForExit,
  waitForSpawn,
  type ProcessTracker,
} from "../../utils/ChildProcessTracker";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import type { AdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import { defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import { errorMessage } from "../../utils/describeUnknownError";
import { selectLiveSimulatorDisplay } from "../../utils/ios-cmdline-tools/SimulatorDisplays";
import { logger } from "../../utils/logger";
import {
  DefaultFfmpegClient,
  type FfmpegClient,
  type FfmpegProcess,
} from "../../utils/media/FfmpegClient";
import { withRemainingBudget } from "../../utils/withRemainingBudget";
import { probeScreenrecordDisplayFlag } from "./AndroidRecordingDisplay";
import {
  FfmpegCapabilities,
  runWithinDeadline,
  throwIfRecordingStartAborted,
  type HardwareAccelInfo,
} from "./FfmpegCapabilities";
import type { FfmpegBackendHandle } from "./FfmpegRecordingHandle";
import { FfmpegRecordingPostProcessor } from "./FfmpegRecordingPostProcessor";
import {
  defaultLiveScreenPixels,
  type FfmpegVideoProcessingBackendDependencies,
  type LiveScreenPixels,
} from "./FfmpegVideoProcessingBackendDependencies";
import { createVideoSimCtl, type VideoSimCtl } from "./VideoSimCtl";
import {
  VideoCaptureFinalizationError,
  VideoCaptureStartCleanupError,
  type OrphanCaptureStopOptions,
  type RecordingHandle,
  type RecordingResult,
  type VideoCaptureBackend,
  type VideoCaptureConfig,
  type VideoCaptureTeardownDescriptor,
} from "./VideoRecorderService";
import { buildProcessFailureMessage, logProcessWarnings } from "./ffmpegDiagnostics";
import { buildFfmpegArgs } from "./ffmpegRecordingArgs";
import {
  defaultRecordingFileProbe,
  defaultRecordingFileRemover,
  type RecordingFileProbe,
  type RecordingFileRemover,
} from "./ffmpegRecordingFiles";
import {
  IOS_RECORDING_START_MESSAGES,
  IOS_RECORDING_START_TIMEOUT_MS,
  IOS_RECORDING_START_MAX_ATTEMPTS,
  waitForStderrMessage,
  waitWithinDeadline,
  forceStopStartingProcess,
  throwAndroidRecordingStartFailure,
} from "./ffmpegRecordingStartup";
import {
  defaultHostRecorderProcessControl,
  forceStopHostRecorder,
  type HostRecorderProcessControl,
} from "./hostRecorderTeardown";
import {
  defaultRecordingCodecProbe,
  probeDurationMs,
  type RecordingCodecProbe,
} from "./recordingCodec";

export * from "./ffmpegRecordingArgs";
export * from "./ffmpegRecordingFiles";
export * from "./ffmpegRecordingStartup";
export type { FfmpegBackendHandle } from "./FfmpegRecordingHandle";

export { buildFfmpegFailureMessage } from "./ffmpegDiagnostics";

export { PROCESS_EXIT_TIMEOUT_MS, waitForExit };
export type { ProcessTracker, StoppableProcess } from "../../utils/ChildProcessTracker";
// `xcrun simctl io ... recordVideo` only writes the MP4/MOV moov atom after it
// receives SIGINT. If we SIGKILL it before the flush finishes the on-disk file is
// truncated (often 0 bytes), and the downstream ffmpeg `-c copy` remux fails with
// "moov atom not found". On a loaded CI macOS runner the flush can take well over
// the generic 5s window, so the iOS stop path waits much longer before escalating
// to SIGKILL. In the normal case simctl exits within ~1s and we return immediately.
export const IOS_RECORDING_STOP_TIMEOUT_MS = 30000;
const IOS_LIVE_DISPLAY_PROBE_TIMEOUT_MS = 2000;
const IOS_RECORDING_START_CLEANUP_TIMEOUT_MS = 500;
// Budget for the terminal attempt's simulator-state probe. Nothing is waiting on
// the start deadline once the last attempt has failed, so the probe gets a budget a
// loaded host can actually deliver — `xcrun simctl list devices` regularly needs
// more than a few hundred milliseconds there, and a probe that times out reports
// nothing about the simulator at all (#6857).
const IOS_RECORDING_DIAGNOSTIC_TIMEOUT_MS = 3000;
// Budget for a between-attempt probe. That one still shares the start deadline with
// the pending retry, so it stays a small slice: enriching a failure must never
// starve the attempt that could still succeed.
const IOS_RECORDING_RETRY_DIAGNOSTIC_TIMEOUT_MS = 250;

export class FfmpegVideoProcessingBackend implements VideoCaptureBackend {
  // Overridable in tests so the retry path can be exercised without real waits.
  iosRecordingStartTimeoutMs: number = IOS_RECORDING_START_TIMEOUT_MS;
  iosRecordingStartMaxAttempts: number = IOS_RECORDING_START_MAX_ATTEMPTS;

  private readonly simctlFactory: (device: BootedDevice) => VideoSimCtl;
  private readonly ffmpegClient: FfmpegClient;
  private readonly codecProbe: RecordingCodecProbe;
  private readonly timer: Timer;
  private readonly captureFileRemover: RecordingFileRemover;
  private readonly liveScreenPixels: LiveScreenPixels;
  private readonly recordingFileProbe: RecordingFileProbe;
  private readonly readHostStartToken: (pid: number) => string | undefined;
  private readonly hostRecorderControl: HostRecorderProcessControl;
  constructor(
    private readonly adbFactory: AdbClientFactory = defaultAdbClientFactory,
    dependencies: FfmpegVideoProcessingBackendDependencies = {},
  ) {
    this.simctlFactory = dependencies.simctlFactory ?? createVideoSimCtl;
    this.ffmpegClient = dependencies.ffmpegClient ?? new DefaultFfmpegClient();
    this.timer = dependencies.timer ?? defaultTimer;
    this.liveScreenPixels = dependencies.liveScreenPixels ?? defaultLiveScreenPixels;
    const host = FfmpegVideoProcessingBackend.resolveHostSeams(dependencies);
    this.capabilities = new FfmpegCapabilities(
      this.ffmpegClient,
      host.platformProvider,
      this.timer,
      () => this.iosRecordingStartTimeoutMs,
    );
    this.codecProbe = host.codecProbe;
    this.captureFileRemover = host.captureFileRemover;
    this.recordingFileProbe = host.recordingFileProbe;
    this.readHostStartToken = host.readHostStartToken;
    this.hostRecorderControl = host.hostRecorderControl;
  }

  private static resolveHostSeams(dependencies: FfmpegVideoProcessingBackendDependencies) {
    return {
      platformProvider: dependencies.platformProvider ?? platform,
      codecProbe: dependencies.codecProbe ?? defaultRecordingCodecProbe,
      captureFileRemover: dependencies.captureFileRemover ?? defaultRecordingFileRemover,
      recordingFileProbe: dependencies.recordingFileProbe ?? defaultRecordingFileProbe,
      readHostStartToken: dependencies.readHostStartToken ?? readProcessGenerationTokenForPid,
      hostRecorderControl: dependencies.hostRecorderControl ?? defaultHostRecorderProcessControl,
    };
  }

  describeCaptureTeardown(handle: RecordingHandle): VideoCaptureTeardownDescriptor | undefined {
    const backendHandle = handle.backendHandle as FfmpegBackendHandle | undefined;
    if (backendHandle?.kind !== "ffmpeg" || backendHandle.platform !== "ios") {
      return undefined;
    }
    // Stop/finalization can describe this handle again after its PID has been recycled.
    if (backendHandle.captureTeardown) {
      return backendHandle.captureTeardown;
    }
    const hostPid = backendHandle.captureTracker.process.pid;
    const udid = backendHandle.config.device?.deviceId;
    try {
      const hostStartToken = hostPid === undefined ? undefined : this.readHostStartToken(hostPid);
      if (!hostPid || !hostStartToken || !udid) {
        logger.warn(
          "[FfmpegVideo] Cannot persist iOS host recorder teardown identity: pid, start token or udid unreadable",
        );
        return undefined;
      }
      backendHandle.captureTeardown = {
        kind: "ios-host-recorder",
        hostPid,
        hostStartToken,
        udid,
        capturePath: backendHandle.capturePath,
      };
      return backendHandle.captureTeardown;
    } catch (error) {
      logger.warn("[FfmpegVideo] Cannot read iOS host recorder start token", error);
      return undefined;
    }
  }

  async forceStopOrphanedCapture(
    _device: BootedDevice | undefined,
    descriptor: VideoCaptureTeardownDescriptor,
    options?: OrphanCaptureStopOptions,
  ): Promise<void> {
    if (descriptor.kind !== "ios-host-recorder") {
      throw new ActionableError("FFmpeg orphan teardown requires an iOS host recorder identity.");
    }
    await forceStopHostRecorder(
      descriptor,
      {
        control: this.hostRecorderControl,
        timer: this.timer,
      },
      options,
    );
  }

  async start(config: VideoCaptureConfig): Promise<RecordingHandle> {
    const device = config.device;
    if (!device) {
      throw new ActionableError("Device is required to start video recording.");
    }
    const iosStartDeadlineMs =
      device.platform === "ios" ? this.timer.now() + this.iosRecordingStartTimeoutMs : undefined;
    await this.ensureFfmpegAvailable(
      iosStartDeadlineMs,
      device.platform === "ios" ? config.abortSignal : undefined,
    );

    if (device.platform === "android") {
      return this.startAndroid(device, config);
    }

    if (device.platform === "ios") {
      return this.startIos(device, config, iosStartDeadlineMs!);
    }

    throw new ActionableError(`Unsupported platform for video recording: ${device.platform}`);
  }

  async stop(handle: RecordingHandle): Promise<RecordingResult> {
    const backendHandle = handle.backendHandle as FfmpegBackendHandle | undefined;
    if (!backendHandle) {
      throw new Error("Missing backend handle for FFmpeg video recording.");
    }

    // A fulfilled tracked exit promise proves capture teardown; signaling alone
    // does not. Leave failures from this wait outside the terminal path.
    await waitForExit(
      backendHandle.captureTracker.process,
      backendHandle.captureTracker.exitPromise,
      {
        timeoutMs:
          backendHandle.platform === "ios"
            ? IOS_RECORDING_STOP_TIMEOUT_MS
            : PROCESS_EXIT_TIMEOUT_MS,
        timer: this.timer,
      },
    );

    try {
      const { outputPath, warnings } = await this.finalizeCaptureOutput(backendHandle, handle);
      const sizeBytes = await this.recordingFileProbe.size(outputPath);
      if (!sizeBytes) {
        throw new ActionableError("The finalized recording is missing or contains zero bytes.");
      }
      // Probe the produced codec: the iOS copy path can preserve HEVC.
      const codec = await this.codecProbe.codec(outputPath);
      const videoDurationMs = await probeDurationMs(this.codecProbe, outputPath);
      if (outputPath !== backendHandle.capturePath) {
        await this.removeRawCapture(backendHandle.capturePath);
      }
      logProcessWarnings("capture", backendHandle.captureTracker);
      if (backendHandle.ffmpegTracker) {
        logProcessWarnings("ffmpeg", backendHandle.ffmpegTracker);
      }
      return {
        recordingId: handle.recordingId,
        outputPath,
        startedAt: handle.startedAt,
        endedAt: backendHandle.captureTracker.exitState.endedAt ?? new Date().toISOString(),
        sizeBytes,
        codec,
        videoDurationMs,
        ...(warnings.length > 0 && { warnings }),
      };
    } catch (error) {
      throw await this.buildFinalizationError(backendHandle, error);
    }
  }

  /**
   * Produces the final output once capture has exited: iOS post-processes the raw capture
   * (which may end with the raw capture returned instead, #10188); Android waits for its
   * encoder. The raw capture is returned, never deleted, when it is the output.
   */
  private async finalizeCaptureOutput(
    backendHandle: FfmpegBackendHandle,
    handle: RecordingHandle,
  ): Promise<{ outputPath: string; warnings: string[] }> {
    if (backendHandle.platform === "ios") {
      const outcome = await this.postProcessRecording(backendHandle);
      return outcome.kind === "kept-raw"
        ? {
            outputPath: backendHandle.capturePath ?? handle.outputPath,
            warnings: [outcome.warning],
          }
        : { outputPath: handle.outputPath, warnings: [] };
    }
    if (backendHandle.ffmpegTracker) {
      await waitForExit(
        backendHandle.ffmpegTracker.process,
        backendHandle.ffmpegTracker.exitPromise,
        { timer: this.timer },
      );
    }
    return { outputPath: handle.outputPath, warnings: [] };
  }

  private postProcessRecording(backendHandle: FfmpegBackendHandle) {
    return new FfmpegRecordingPostProcessor({
      ffmpegClient: this.ffmpegClient,
      timer: this.timer,
      recordingFileProbe: this.recordingFileProbe,
      captureFileRemover: this.captureFileRemover,
      codecProbe: this.codecProbe,
      detectHardwareAccel: () => this.detectHardwareAccel(),
    }).postProcessRecording(backendHandle);
  }

  private async removeRawCapture(capturePath: string | undefined): Promise<void> {
    if (!capturePath) {
      return;
    }
    try {
      await this.captureFileRemover.remove(capturePath);
    } catch (error) {
      logger.warn(`[FfmpegVideo] Failed to remove raw recording: ${errorMessage(error)}`, error);
    }
  }

  private async buildFinalizationError(
    backendHandle: FfmpegBackendHandle,
    error: unknown,
  ): Promise<VideoCaptureFinalizationError> {
    // Capture is gone, so release its owner, but preserve recoverable raw bytes.
    const cleanupError = await this.cleanupStartingTrackers(
      [backendHandle.ffmpegTracker].filter(
        (tracker): tracker is ProcessTracker => tracker !== undefined,
      ),
    );
    if (cleanupError) {
      logger.warn(
        `[FfmpegVideo] Failed to clean up recording encoder: ${errorMessage(cleanupError)}`,
        cleanupError,
      );
    }
    let retainedCapturePath = backendHandle.capturePath;
    if (retainedCapturePath) {
      try {
        const rawSize = await this.recordingFileProbe.size(retainedCapturePath);
        if (rawSize === null || rawSize === 0) {
          await this.captureFileRemover.remove(retainedCapturePath);
          retainedCapturePath = undefined;
        }
      } catch (cleanupError) {
        logger.warn(
          `[FfmpegVideo] Could not inspect or remove raw recording; retaining ${retainedCapturePath}: ${errorMessage(cleanupError)}`,
          cleanupError,
        );
      }
    }
    return new VideoCaptureFinalizationError(
      retainedCapturePath
        ? `Capture exited but finalization failed. Raw capture retained at ${retainedCapturePath}. ${errorMessage(error)}`
        : `Capture exited but the recording produced no usable video (zero bytes / finalization failed). Start a new recording. ${errorMessage(error)}`,
      { cause: error, retainedCapturePath },
    );
  }

  async forceStop(handle: RecordingHandle): Promise<void> {
    const backendHandle = handle.backendHandle as FfmpegBackendHandle | undefined;
    if (!backendHandle) {
      throw new Error("Missing backend handle for FFmpeg video recording.");
    }

    const trackers = [backendHandle.ffmpegTracker, backendHandle.captureTracker].filter(
      (tracker): tracker is ProcessTracker => tracker !== undefined,
    );
    const results = await Promise.allSettled(
      trackers.map(async (tracker) => {
        await waitForExit(tracker.process, tracker.exitPromise, {
          timeoutMs: 0,
          forceKillTimeoutMs: PROCESS_EXIT_TIMEOUT_MS,
          signal: "SIGKILL",
          timer: this.timer,
        });
      }),
    );
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure) {
      throw failure.reason;
    }
  }

  private async startAndroid(
    device: BootedDevice,
    config: VideoCaptureConfig,
  ): Promise<RecordingHandle> {
    const adb = this.adbFactory.create(device);

    const screenrecordArgs = ["exec-out", "screenrecord"];
    if (config.physicalDisplayId !== undefined) {
      screenrecordArgs.push("--display-id", config.physicalDisplayId);
    }
    screenrecordArgs.push("-");

    logger.info(`[FfmpegVideo] Starting screenrecord: ${screenrecordArgs.join(" ")}`);

    let captureProcess = await adb.spawn(screenrecordArgs);
    let captureTracker = trackProcess(captureProcess);
    let warning: string | undefined;
    if (config.physicalDisplayId !== undefined && device.apiLevel === undefined) {
      if (await probeScreenrecordDisplayFlag(captureTracker, this.timer)) {
        warning = "Android screenrecord rejected --display-id; recording the default display.";
        logger.warn(`[FfmpegVideo] ${warning}`);
        captureProcess = await adb.spawn(["exec-out", "screenrecord", "-"]);
        captureTracker = trackProcess(captureProcess);
      }
    }
    let ffmpegProcess: FfmpegProcess | undefined;
    let ffmpegTracker: ProcessTracker | undefined;
    const forceStopStartingProcesses = () => {
      forceStopStartingProcess(captureProcess);
      forceStopStartingProcess(ffmpegProcess);
    };
    const abortStartingCapture = () => forceStopStartingProcesses();
    config.abortSignal?.addEventListener("abort", abortStartingCapture, { once: true });

    try {
      throwIfRecordingStartAborted(config.abortSignal, "Android");

      captureProcess.stderr.on("data", (chunk) => {
        const text = chunk.toString();
        logger.info(`[FfmpegVideo] screenrecord stderr: ${text.trim()}`);
      });

      let bytesReceived = 0;
      captureProcess.stdout.on("data", (chunk) => {
        bytesReceived += chunk.length;
        if (bytesReceived % (1024 * 100) === 0) {
          logger.info(`[FfmpegVideo] Received ${bytesReceived} bytes from screenrecord`);
        }
      });

      logger.info(`[FfmpegVideo] screenrecord process spawned`);

      const hwAccel = await this.detectHardwareAccel();
      throwIfRecordingStartAborted(config.abortSignal, "Android");
      const ffmpegArgs = buildFfmpegArgs(config, hwAccel, { type: "pipe" });
      throwIfRecordingStartAborted(config.abortSignal, "Android");

      logger.info(
        `[FfmpegVideo] Starting ffmpeg: ${this.ffmpegClient.binaryPath} ${ffmpegArgs.join(" ")}`,
      );

      const startedFfmpeg = this.ffmpegClient.start({
        args: ffmpegArgs,
        context: "Android screen recording encoder",
        stdio: ["pipe", "pipe", "pipe"],
      });
      ffmpegProcess = startedFfmpeg.process;
      ffmpegTracker = startedFfmpeg.tracker;
      throwIfRecordingStartAborted(config.abortSignal, "Android");

      this.ffmpegClient.pipe({
        source: captureProcess.stdout,
        destination: ffmpegProcess.stdin,
        context: "Android screen recording",
        processes: [captureProcess, ffmpegProcess],
      });
      logger.info(`[FfmpegVideo] Piped screenrecord stdout to ffmpeg stdin`);

      await waitForSpawn(ffmpegProcess);
      logger.info(`[FfmpegVideo] ffmpeg process spawned`);

      const backendHandle: FfmpegBackendHandle = {
        kind: "ffmpeg",
        platform: "android",
        captureTracker,
        ffmpegTracker,
        config,
      };

      return {
        recordingId: config.recordingId,
        outputPath: config.outputPath,
        startedAt: config.startedAt,
        warning,
        physicalDisplayId: warning ? undefined : config.physicalDisplayId,
        backendHandle,
      };
    } catch (error) {
      forceStopStartingProcesses();
      const cleanupError = await this.cleanupStartingTrackers([
        captureTracker,
        ...(ffmpegTracker ? [ffmpegTracker] : []),
      ]);
      if (cleanupError) {
        throw new VideoCaptureStartCleanupError(
          `Failed to clean up Android recording after startup failed: ${errorMessage(cleanupError)}`,
          {
            recordingId: config.recordingId,
            outputPath: config.outputPath,
            startedAt: config.startedAt,
            backendHandle: {
              kind: "ffmpeg",
              platform: "android",
              captureTracker,
              ffmpegTracker,
              config,
            } satisfies FfmpegBackendHandle,
          },
          { cause: error },
        );
      }
      return throwAndroidRecordingStartFailure(error, config.abortSignal);
    } finally {
      config.abortSignal?.removeEventListener("abort", abortStartingCapture);
    }
  }

  private async cleanupStartingTrackers(trackers: ProcessTracker[]): Promise<unknown | undefined> {
    const results = await Promise.allSettled(
      trackers.map((tracker) =>
        waitForExit(tracker.process, tracker.exitPromise, {
          timeoutMs: 0,
          forceKillTimeoutMs: PROCESS_EXIT_TIMEOUT_MS,
          signal: "SIGKILL",
          timer: this.timer,
        }),
      ),
    );
    const failures = results
      .map((result, index) => ({ result, tracker: trackers[index] }))
      .filter(
        (outcome): outcome is { result: PromiseRejectedResult; tracker: ProcessTracker } =>
          outcome.result.status === "rejected" && outcome.tracker.process.pid !== undefined,
      )
      .map((outcome) => outcome.result.reason);
    return failures.length > 0
      ? new AggregateError(failures, "Failed to reap recording startup processes")
      : undefined;
  }

  private async recordingDisplayArg(
    simctl: VideoSimCtl,
    device: BootedDevice,
    deadlineMs: number,
  ): Promise<string | undefined> {
    const remainingMs = deadlineMs - this.timer.now();
    if (remainingMs <= 0) {
      return undefined;
    }
    let displays: Awaited<ReturnType<VideoSimCtl["enumerateDisplays"]>>;
    try {
      const probeBudgetMs = Math.min(remainingMs, IOS_LIVE_DISPLAY_PROBE_TIMEOUT_MS);
      displays = await runWithinDeadline(
        (signal) => simctl.enumerateDisplays(device.deviceId, probeBudgetMs, signal),
        this.timer.now() + probeBudgetMs,
        this.timer,
        { timeoutMessage: "Timed out enumerating iOS simulator recording displays" },
      );
    } catch (error) {
      // Older simctl versions may not expose enumerate; preserve their recording command.
      logger.warn(`Unable to enumerate iOS simulator recording displays: ${errorMessage(error)}`);
      return undefined;
    }
    if (displays.length === 0) {
      logger.warn(
        `Unable to select the live recording display for ${device.name}: no Integrated screens found`,
      );
      return undefined;
    }
    if (displays.length === 1) {
      return undefined;
    }
    try {
      const probeBudgetMs = Math.min(
        deadlineMs - this.timer.now(),
        IOS_LIVE_DISPLAY_PROBE_TIMEOUT_MS,
      );
      if (probeBudgetMs <= 0) {
        logger.warn(
          `Unable to select the live recording display for ${device.name}: start deadline expired`,
        );
        return undefined;
      }
      const live = await runWithinDeadline(
        () => this.liveScreenPixels(device, probeBudgetMs),
        this.timer.now() + probeBudgetMs,
        this.timer,
        { timeoutMessage: "Timed out probing the live iOS simulator display" },
      );
      const selected = live ? selectLiveSimulatorDisplay(displays, live.width, live.height) : null;
      if (selected?.name) {
        return selected.name;
      }
      logger.warn(
        `Unable to select the live recording display for ${device.name}: no uniquely matching Integrated screen with a Device Name`,
      );
      return undefined;
    } catch (error) {
      logger.warn(
        `Unable to select the live recording display for ${device.name}: ${errorMessage(error)}`,
      );
      return undefined;
    }
  }

  private recordingCommandArgs(
    deviceId: string,
    displayArg: string | undefined,
    capturePath: string,
  ): string[] {
    return [
      "io",
      deviceId,
      "recordVideo",
      ...(displayArg ? [`--display=${displayArg}`] : []),
      capturePath,
    ];
  }

  private async startIos(
    device: BootedDevice,
    config: VideoCaptureConfig,
    startDeadlineMs: number,
  ): Promise<RecordingHandle> {
    throwIfRecordingStartAborted(config.abortSignal, "iOS");
    if (this.timer.now() >= startDeadlineMs) {
      throw new ActionableError(
        `Failed to start iOS recording within ${this.iosRecordingStartTimeoutMs}ms.`,
      );
    }
    const simctl = this.simctlFactory(device);
    const available = await runWithinDeadline(
      async (signal) =>
        await simctl.isAvailable({
          timeoutMs: Math.max(0, startDeadlineMs - this.timer.now()),
          signal,
        }),
      startDeadlineMs,
      this.timer,
      {
        callerSignal: config.abortSignal,
        timeoutMessage: `Timed out checking simctl availability within ${this.iosRecordingStartTimeoutMs}ms`,
      },
    );
    throwIfRecordingStartAborted(config.abortSignal, "iOS");
    if (this.timer.now() >= startDeadlineMs) {
      throw new ActionableError(
        `Failed to start iOS recording within ${this.iosRecordingStartTimeoutMs}ms.`,
      );
    }
    if (!available) {
      throw new ActionableError("simctl is not available. Install Xcode command line tools.");
    }

    const displayArg = await this.recordingDisplayArg(simctl, device, startDeadlineMs);

    const captureBaseName = `${config.recordingId}-raw`;

    const maxAttempts = Math.max(1, this.iosRecordingStartMaxAttempts);
    const attemptFailures: string[] = [];
    let previousCapturePath: string | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      throwIfRecordingStartAborted(config.abortSignal, "iOS");
      const remainingBeforeSpawn = startDeadlineMs - this.timer.now();
      if (remainingBeforeSpawn <= 0) {
        break;
      }
      // Give every attempt its own capture file. `simctl io ... recordVideo` creates
      // the target *before* it emits the "Recording started" handshake, so an attempt
      // we killed for missing that handshake leaves a partial .mov behind — and simctl
      // refuses to record over an existing file (exit 17, "cannot save recorded video
      // output into a file that already exists"). Reusing one path made the retry
      // depend on unlinking that partial before the dying capture process could
      // recreate it; losing that race exit-17'd the retry and failed the whole start
      // (issue #6851). A per-attempt path is immune regardless of cleanup timing —
      // the retry never targets the first attempt's leftover. Attempt 1 keeps the
      // bare `<id>-raw.mov` name so the common first-try success path is unchanged.
      const capturePath = path.join(
        config.outputDirectory,
        attempt === 1 ? `${captureBaseName}.mov` : `${captureBaseName}-attempt${attempt}.mov`,
      );
      const args = this.recordingCommandArgs(device.deviceId, displayArg, capturePath);
      if (previousCapturePath !== undefined) {
        // Best-effort disk hygiene only: drop the prior attempt's partial so retries
        // don't leak `.mov` files. Correctness no longer depends on this succeeding —
        // the unique path above already prevents the exit-17 collision.
        await this.removeStaleCapture(previousCapturePath);
      }
      previousCapturePath = capturePath;
      const captureProcess = await simctl.startCommandArgs(args, {
        stdio: ["ignore", "ignore", "pipe"],
      });
      const captureTracker = trackProcess(captureProcess);
      let spawned = false;

      try {
        throwIfRecordingStartAborted(config.abortSignal, "iOS");
        await waitWithinDeadline(
          waitForSpawn(captureProcess),
          startDeadlineMs,
          this.timer,
          `Timed out waiting for simctl to spawn within ${this.iosRecordingStartTimeoutMs}ms`,
        );
        spawned = true;
        const attemptsRemaining = maxAttempts - attempt + 1;
        const remainingMs = Math.max(0, startDeadlineMs - this.timer.now());
        const reservedCleanupMs =
          Math.min(IOS_RECORDING_START_CLEANUP_TIMEOUT_MS, remainingMs) * attemptsRemaining;
        const handshakeTimeoutMs = Math.max(
          0,
          Math.floor((remainingMs - reservedCleanupMs) / attemptsRemaining),
        );
        await waitForStderrMessage(
          captureTracker,
          IOS_RECORDING_START_MESSAGES,
          handshakeTimeoutMs,
          { signal: config.abortSignal, timer: this.timer },
        );

        const backendHandle: FfmpegBackendHandle = {
          kind: "ffmpeg",
          platform: "ios",
          captureTracker,
          capturePath,
          config,
        };

        return {
          recordingId: config.recordingId,
          outputPath: config.outputPath,
          startedAt: config.startedAt,
          // simctl writes the raw .mov; `outputPath` exists only after stop's post-process.
          liveCapturePath: capturePath,
          backendHandle,
        };
      } catch (error) {
        const failedAttempt = await this.describeFailedIosStartAttempt({
          attempt,
          captureTracker,
          config,
          device,
          error,
          maxAttempts,
          simctl,
          spawned,
          startDeadlineMs,
        });
        attemptFailures.push(failedAttempt.description);
        if (failedAttempt.cleanupError) {
          const message = buildProcessFailureMessage(
            `Failed to clean up iOS recording after startup failed: ${failedAttempt.description}`,
            "xcrun simctl",
            args,
            { tracker: captureTracker },
          );
          throw new VideoCaptureStartCleanupError(
            message,
            {
              recordingId: config.recordingId,
              outputPath: config.outputPath,
              startedAt: config.startedAt,
              backendHandle: {
                kind: "ffmpeg",
                platform: "ios",
                captureTracker,
                capturePath,
                config,
              } satisfies FfmpegBackendHandle,
            },
            { cause: failedAttempt.cleanupError },
          );
        }

        if (attempt >= maxAttempts) {
          throw new ActionableError(
            buildProcessFailureMessage(
              `Failed to start iOS recording after ${maxAttempts} attempt(s): ${attemptFailures.join(" | ")}`,
              "xcrun simctl",
              args,
              { tracker: captureTracker },
            ),
          );
        }
      }
    }

    throw new ActionableError(
      `Failed to start iOS recording within ${this.iosRecordingStartTimeoutMs}ms` +
        (attemptFailures.length > 0 ? `: ${attemptFailures.join(" | ")}` : "."),
    );
  }

  private async removeStaleCapture(capturePath: string): Promise<void> {
    try {
      await this.captureFileRemover.remove(capturePath);
    } catch (error) {
      // Best-effort: the remover already treats a missing file as success, so a
      // failure here is unexpected but must not mask the retry — if the stale file
      // really does block it, simctl surfaces its own error on the next spawn.
      logger.warn(
        `[FfmpegVideo] Failed to remove stale iOS capture ${capturePath}: ${errorMessage(error)}`,
        error,
      );
    }
  }

  private async describeFailedIosStartAttempt(input: {
    attempt: number;
    captureTracker: ProcessTracker;
    config: VideoCaptureConfig;
    device: BootedDevice;
    error: unknown;
    maxAttempts: number;
    simctl: VideoSimCtl;
    spawned: boolean;
    startDeadlineMs: number;
  }): Promise<{ description: string; cleanupError?: unknown }> {
    const stopError = await this.cleanupFailedIosStart(input.captureTracker, input.startDeadlineMs);
    const descriptionPrefix = `attempt ${input.attempt}/${input.maxAttempts}: ${input.error}`;
    if (!input.spawned && input.captureTracker.process.pid === undefined) {
      throw new ActionableError(`Failed to start iOS recording: ${input.error}`);
    }
    if (stopError) {
      return {
        description: `${descriptionPrefix}; cleanup failed: ${errorMessage(stopError)}`,
        cleanupError: stopError,
      };
    }
    if (input.config.abortSignal?.aborted) {
      throw new ActionableError("iOS recording start was cancelled during shutdown.");
    }
    if (!input.spawned) {
      throw new ActionableError(`Failed to start iOS recording: ${input.error}`);
    }

    const diagnostics = await this.diagnoseFailedIosStart(
      input.simctl,
      input.device,
      input.startDeadlineMs,
      { isFinalAttempt: input.attempt >= input.maxAttempts, abortSignal: input.config.abortSignal },
    );
    logger.warn(
      `[FfmpegVideo] iOS recording start attempt ${input.attempt}/${input.maxAttempts} failed: ${input.error} (${diagnostics})`,
    );
    return { description: `${descriptionPrefix}; ${diagnostics}` };
  }

  private async cleanupFailedIosStart(
    captureTracker: ProcessTracker,
    startDeadlineMs: number,
  ): Promise<unknown | undefined> {
    const cleanupTimeoutMs = Math.max(
      0,
      Math.min(IOS_RECORDING_START_CLEANUP_TIMEOUT_MS, startDeadlineMs - this.timer.now()),
    );
    try {
      await waitForExit(captureTracker.process, captureTracker.exitPromise, {
        timeoutMs: cleanupTimeoutMs,
        forceKillTimeoutMs: 0,
        timer: this.timer,
        signal: "SIGKILL",
      });
      return undefined;
    } catch (error) {
      return error;
    }
  }

  private async diagnoseFailedIosStart(
    simctl: VideoSimCtl,
    device: BootedDevice,
    startDeadlineMs: number,
    { isFinalAttempt, abortSignal }: { isFinalAttempt: boolean; abortSignal?: AbortSignal },
  ): Promise<string> {
    if (isFinalAttempt) {
      // No retry is left to protect, so the probe is deliberately NOT clipped to the
      // (usually exhausted) start deadline. Clipping it meant the one attempt whose
      // diagnostics matter most reported "startup budget exhausted" and never looked.
      return await this.captureSimulatorDiagnostics(
        simctl,
        device,
        IOS_RECORDING_DIAGNOSTIC_TIMEOUT_MS,
        abortSignal,
      );
    }
    const diagnosticBudgetMs = Math.max(
      0,
      Math.min(IOS_RECORDING_RETRY_DIAGNOSTIC_TIMEOUT_MS, startDeadlineMs - this.timer.now()),
    );
    return diagnosticBudgetMs > 0
      ? await this.captureSimulatorDiagnostics(simctl, device, diagnosticBudgetMs, abortSignal)
      : "simulator state unknown: start budget reserved for the pending retry";
  }

  /**
   * Best-effort snapshot of the target simulator's state, used only to enrich a
   * start-timeout failure. Never throws: a diagnostics failure must not mask the
   * original recording error.
   */
  private async captureSimulatorDiagnostics(
    simctl: VideoSimCtl,
    device: BootedDevice,
    timeoutMs: number,
    abortSignal: AbortSignal | undefined,
  ): Promise<string> {
    const budgetMs = Math.min(IOS_RECORDING_DIAGNOSTIC_TIMEOUT_MS, timeoutMs);
    const probeStartedAtMs = this.timer.now();
    try {
      const result = await withRemainingBudget(
        probeStartedAtMs + budgetMs,
        this.timer,
        abortSignal,
        async (signal, remainingMs) =>
          await simctl.executeCommandArgs(
            ["list", "devices", device.deviceId],
            remainingMs,
            signal,
          ),
      );
      const text = (result.stdout || result.stderr || "").replace(/\s+/g, " ").trim();
      return text ? `simulator state: ${text.slice(0, 500)}` : "simulator state: (empty)";
    } catch (error) {
      if (abortSignal?.aborted) {
        // Shutdown cancellation is expected here and must not mask the original start failure.
        logger.debug("[FfmpegVideo] Simulator state probe cancelled by shutdown");
        return "simulator state probe cancelled by shutdown";
      }
      const reason = errorMessage(error);
      // This best-effort probe must not replace the original recording-start error.
      logger.debug(`[FfmpegVideo] Simulator state probe failed: ${reason}`);
      // A probe that burned its whole budget says nothing about the simulator — only
      // that the host was too busy to answer in time. Reporting that as "unavailable"
      // reads like a definitive "the simulator is gone" and sent the triage of #6857
      // after the probe instead of the handshake timeout that actually failed the start.
      if (this.timer.now() - probeStartedAtMs >= budgetMs) {
        return `simulator state unknown: state probe exceeded its ${budgetMs}ms budget (host may be loaded): ${reason}`;
      }
      return `simulator state unavailable: ${reason}`;
    }
  }
  private readonly capabilities: FfmpegCapabilities;
  detectHardwareAccel(): Promise<HardwareAccelInfo> {
    return this.capabilities.detectHardwareAccel();
  }
  ensureFfmpegAvailable(deadlineMs?: number, abortSignal?: AbortSignal): Promise<void> {
    return this.capabilities.ensureFfmpegAvailable(deadlineMs, abortSignal);
  }
}

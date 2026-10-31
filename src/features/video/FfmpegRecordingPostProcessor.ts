import { ActionableError } from "../../models";
import { toActionableError } from "../../models/ActionableError";
import { getRequestContext } from "../../utils/AbortContext";
import {
  ProcessTeardownUnconfirmedError,
  trackProcess,
  waitForExit,
  waitForSpawn,
} from "../../utils/ChildProcessTracker";
import type { Timer } from "../../utils/SystemTimer";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { FfmpegClient } from "../../utils/media/FfmpegClient";
import type { HardwareAccelInfo } from "./FfmpegCapabilities";
import type { FfmpegBackendHandle } from "./FfmpegRecordingHandle";
import { PostProcessOutOfTimeError } from "./PostProcessOutOfTimeError";
import type { VideoCaptureConfig } from "./VideoRecorderService";
import {
  assertFfmpegOutputReady,
  buildFfmpegFailureMessage,
  buildProcessFailureMessage,
  isFailedExitState,
} from "./ffmpegDiagnostics";
import {
  buildFfmpegArgs,
  ffmpegPostProcessBudgetMs,
  boundPostProcessBudgetToRequest,
  FFMPEG_REENCODE_MAX_BUDGET_MS,
  FFMPEG_UNATTENDED_REENCODE_MAX_BUDGET_MS,
} from "./ffmpegRecordingArgs";
import {
  waitForRecordingFileReady,
  type RecordingFileProbe,
  type RecordingFileRemover,
} from "./ffmpegRecordingFiles";
import type { RecordingCodecProbe } from "./recordingCodec";
/** What iOS post-processing produced: the processed output, or the raw capture kept instead. */
type PostProcessOutcome = { kind: "processed" } | { kind: "kept-raw"; warning: string };
interface FfmpegRecordingPostProcessorDependencies {
  ffmpegClient: FfmpegClient;
  timer: Timer;
  recordingFileProbe: RecordingFileProbe;
  captureFileRemover: RecordingFileRemover;
  codecProbe: RecordingCodecProbe;
  detectHardwareAccel: () => Promise<HardwareAccelInfo>;
}

/** Finalizes an iOS raw capture using the backend's injected process, file and time seams. */
export class FfmpegRecordingPostProcessor {
  private readonly ffmpegClient: FfmpegClient;
  private readonly timer: Timer;
  private readonly recordingFileProbe: RecordingFileProbe;
  private readonly captureFileRemover: RecordingFileRemover;
  private readonly codecProbe: RecordingCodecProbe;
  private readonly detectHardwareAccel: () => Promise<HardwareAccelInfo>;

  constructor(dependencies: FfmpegRecordingPostProcessorDependencies) {
    this.ffmpegClient = dependencies.ffmpegClient;
    this.timer = dependencies.timer;
    this.recordingFileProbe = dependencies.recordingFileProbe;
    this.captureFileRemover = dependencies.captureFileRemover;
    this.codecProbe = dependencies.codecProbe;
    this.detectHardwareAccel = dependencies.detectHardwareAccel;
  }

  async postProcessRecording(backendHandle: FfmpegBackendHandle): Promise<PostProcessOutcome> {
    const capturePath = backendHandle.capturePath;
    if (!capturePath) {
      throw new ActionableError("Missing iOS capture path for FFmpeg processing.");
    }

    // simctl finalizes the moov atom on SIGINT, but the flush + filesystem write
    // can lag behind process exit on a loaded runner. Poll for a stable, non-empty
    // file before failing, so a momentarily-missing file is not a hard error (#2730).
    try {
      await waitForRecordingFileReady(capturePath, {
        timer: this.timer,
        probe: this.recordingFileProbe,
      });
    } catch (error) {
      const reason = errorMessage(error);
      throw new ActionableError(
        buildProcessFailureMessage(
          `iOS recording file missing at ${capturePath}: ${reason}`,
          "xcrun simctl",
          [
            "io",
            backendHandle.config.device?.deviceId ?? "(unknown-device)",
            "recordVideo",
            capturePath,
          ],
          { tracker: backendHandle.captureTracker, outputPath: capturePath },
        ),
      );
    }

    try {
      await this.runFfmpegPostProcess(backendHandle, capturePath);
      return { kind: "processed" };
    } catch (error) {
      if (error instanceof ProcessTeardownUnconfirmedError) {
        // ffmpeg may still be running against the files: nothing is safe to hand back.
        throw error;
      }
      return this.keepRawCaptureAfterPostProcessFailure(backendHandle, capturePath, error);
    }
  }

  /**
   * ffmpeg could not produce the processed output (it failed, ran out of its time, or left
   * no usable file). When the raw capture is itself playable, return it with a warning
   * instead of failing the stop and discarding the recording (#10188); the partial output
   * ffmpeg left behind is removed so only one file is offered. A raw capture that is not
   * playable (the recorder was killed before it wrote the moov atom) is no recording: the
   * original error is rethrown so the stop reports a finalization failure.
   */
  private async keepRawCaptureAfterPostProcessFailure(
    backendHandle: FfmpegBackendHandle,
    capturePath: string,
    error: unknown,
  ): Promise<PostProcessOutcome> {
    await this.removePartialPostProcessOutput(backendHandle.config.outputPath);
    if (!(await this.isRawCaptureUsable(backendHandle, capturePath))) {
      logger.warn(
        `[FfmpegVideo] iOS post-processing failed and the raw capture is not playable: ${errorMessage(error)}`,
        error,
      );
      throw error;
    }
    logger.warn(
      `[FfmpegVideo] iOS post-processing did not finish; keeping the unprocessed capture: ${errorMessage(error)}`,
      error,
    );
    const reason = errorMessage(error).split("\n")[0];
    const what =
      error instanceof PostProcessOutOfTimeError
        ? "post-processing ran out of time"
        : "post-processing failed";
    return {
      kind: "kept-raw",
      warning:
        `iOS ${what} (${reason}); returning the unprocessed simulator capture, which has not ` +
        "been remuxed or scaled to the requested resolution.",
    };
  }

  private async removePartialPostProcessOutput(outputPath: string): Promise<void> {
    try {
      await this.captureFileRemover.remove(outputPath);
    } catch (removeError) {
      logger.warn(
        `[FfmpegVideo] Failed to remove the partial post-processed output: ${errorMessage(removeError)}`,
        removeError,
      );
    }
  }

  /**
   * Whether the raw simulator capture can be offered as the recording: the recorder must
   * have been stopped by its signal rather than killed past its stop timeout (simctl writes
   * the moov atom at the end, so a killed one leaves nothing playable), and the repo's
   * container probe must find the video track in it.
   */
  private async isRawCaptureUsable(
    backendHandle: FfmpegBackendHandle,
    capturePath: string,
  ): Promise<boolean> {
    if (backendHandle.captureTracker.exitState.signal === "SIGKILL") {
      return false;
    }
    try {
      return (await this.codecProbe.codec(capturePath)) !== undefined;
    } catch (error) {
      logger.warn(
        `[FfmpegVideo] Could not probe the raw capture ${capturePath}: ${errorMessage(error)}`,
        error,
      );
      return false;
    }
  }

  private async runFfmpegPostProcess(
    backendHandle: FfmpegBackendHandle,
    capturePath: string,
  ): Promise<void> {
    // ffmpeg is attempted with whatever time the stop has (a request with none left skips it).
    const budgetMs = this.requestBoundedPostProcessBudgetMs(backendHandle.config);
    const hwAccel = await this.detectHardwareAccel();
    const ffmpegArgs = buildFfmpegArgs(backendHandle.config, hwAccel, {
      type: "file",
      path: capturePath,
    });

    logger.info(
      `[FfmpegVideo] Starting ffmpeg post-process: ${this.ffmpegClient.binaryPath} ${ffmpegArgs.join(" ")}`,
    );

    const { process: ffmpegProcess } = this.ffmpegClient.start({
      args: ffmpegArgs,
      context: "iOS recording post-processing",
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      await waitForSpawn(ffmpegProcess);
    } catch (error) {
      throw toActionableError(error, `Failed to start FFmpeg post-processing`);
    }

    const ffmpegTracker = trackProcess(ffmpegProcess);
    backendHandle.ffmpegTracker = ffmpegTracker;

    await waitForExit(ffmpegProcess, ffmpegTracker.exitPromise, {
      timeoutMs: budgetMs,
      signal: null,
      timer: this.timer,
    });

    if (isFailedExitState(ffmpegTracker.exitState)) {
      const { exitCode, signal } = ffmpegTracker.exitState;
      // Nothing else signals ffmpeg here: a SIGKILL is waitForExit escalating past its budget.
      if (signal === "SIGKILL") {
        throw new PostProcessOutOfTimeError(
          buildFfmpegFailureMessage(
            this.ffmpegClient.binaryPath,
            `FFmpeg post-processing timed out after ${budgetMs}ms`,
            ffmpegArgs,
            { tracker: ffmpegTracker },
          ),
        );
      }
      throw new ActionableError(
        buildFfmpegFailureMessage(
          this.ffmpegClient.binaryPath,
          `FFmpeg post-processing failed (exit ${exitCode ?? `signal ${signal}`})`,
          ffmpegArgs,
          { tracker: ffmpegTracker },
        ),
      );
    }

    await assertFfmpegOutputReady(backendHandle.config.outputPath, ffmpegArgs, ffmpegTracker, {
      recordingFileProbe: this.recordingFileProbe,
      binaryPath: this.ffmpegClient.binaryPath,
    });
  }

  /**
   * The post-process budget. A stop made by a live tool request is cut to what is left of
   * that request; a stop outside any request context (timer-driven, device disconnect,
   * teardown) has only its own budget, with the lower unattended ceiling. Throws when the
   * request has no time left, which the caller turns into the raw-capture fallback.
   */
  private requestBoundedPostProcessBudgetMs(config: VideoCaptureConfig): number {
    const request = getRequestContext();
    const budgetMs = ffmpegPostProcessBudgetMs(
      config,
      this.recordedSeconds(config),
      request ? FFMPEG_REENCODE_MAX_BUDGET_MS : FFMPEG_UNATTENDED_REENCODE_MAX_BUDGET_MS,
    );
    const deadlineMs = request?.getDeadlineMs?.();
    const boundedMs = boundPostProcessBudgetToRequest(
      budgetMs,
      deadlineMs === undefined ? undefined : deadlineMs - this.timer.now(),
    );
    if (boundedMs === undefined) {
      throw new PostProcessOutOfTimeError("the stop request has no time left for post-processing");
    }
    return boundedMs;
  }

  /** Seconds the recording has been running, or undefined when its start time is unusable. */
  private recordedSeconds(config: VideoCaptureConfig): number | undefined {
    const startedAtMs = Date.parse(config.startedAt);
    return Number.isNaN(startedAtMs) ? undefined : (this.timer.now() - startedAtMs) / 1000;
  }
}

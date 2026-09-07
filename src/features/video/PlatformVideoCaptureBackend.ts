import { errorMessage } from "../../utils/describeUnknownError";
import { ActionableError, BootedDevice } from "../../models";
import { defaultTimer } from "../../utils/SystemTimer";
import type { Timer } from "../../utils/SystemTimer";
import { defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { logger } from "../../utils/logger";
import {
  createExitTracker,
  getFileSize,
  PROCESS_EXIT_TIMEOUT_MS,
  type ProcessExitState,
  type TrackedChildProcess,
  waitForExit,
} from "../../utils/ChildProcessTracker";
import type {
  RecordingHandle,
  RecordingResult,
  VideoCaptureBackend,
  VideoCaptureConfig,
} from "./VideoRecorderService";
import { ANDROID_SCREENRECORD_MAX_SECONDS } from "./androidScreenrecord";
import { defaultRecordingCodecProbe, type RecordingCodecProbe } from "./recordingCodec";

interface AndroidBackendHandle {
  kind: "android";
  process: TrackedChildProcess;
  exitState: ProcessExitState;
  exitPromise: Promise<void>;
  stderr: string[];
  device: BootedDevice;
  deviceTempPath: string;
}

type BackendHandle = AndroidBackendHandle;

// A stop that follows immediately after start races `screenrecord`'s own file
// flush on the device: pulling before the on-device MP4 is finalized fails
// with a raw `adb pull failed with exit code 1` and orphans the recording
// (issue #6291). Poll the device-side file size until it stops growing (or
// the attempts run out) before ever attempting the pull, and retry the pull
// itself a bounded number of times in case finalization is still racing it.
const DEVICE_FILE_FINALIZE_POLL_ATTEMPTS = 5;
const DEVICE_FILE_FINALIZE_POLL_INTERVAL_MS = 300;
const PULL_MAX_ATTEMPTS = 3;
const PULL_RETRY_DELAY_MS = 500;

export function clampBitrateKbps(config: VideoCaptureConfig): number {
  const maxBitrateKbps = Math.max(0, Math.floor(config.maxThroughputMbps * 1000));
  if (!maxBitrateKbps) {
    return config.targetBitrateKbps;
  }

  return Math.min(config.targetBitrateKbps, maxBitrateKbps);
}

/**
 * Platform-native video capture backend.
 *
 * Android recordings use `adb shell screenrecord` on the device. iOS recordings
 * are intentionally NOT handled here: {@link HybridVideoCaptureBackend} routes
 * every iOS device to `FfmpegVideoProcessingBackend`, whose `startIos` drives
 * `simctl … recordVideo` with the SIGINT + moov-atom flush + materialization wait
 * that a robust iOS capture needs. The former platform-native `simctl recordVideo`
 * branch here spawned the recorder with all stdio ignored, so a failed recording
 * surfaced only an exit code with no stderr to diagnose it — and it was unreachable
 * in production. It was removed rather than hardened (issue #4773); iOS callers are
 * rejected explicitly so a future mis-wire fails loudly instead of silently.
 */
export class PlatformVideoCaptureBackend implements VideoCaptureBackend {
  constructor(
    private readonly adbFactory: AdbClientFactory = defaultAdbClientFactory,
    private readonly timer: Timer = defaultTimer,
    // Injectable so the codec label can be asserted from synthetic files without
    // producing real recordings (#4965).
    private readonly codecProbe: RecordingCodecProbe = defaultRecordingCodecProbe,
  ) {}

  async start(config: VideoCaptureConfig): Promise<RecordingHandle> {
    const device = config.device;
    if (!device) {
      throw new ActionableError("Device is required to start video recording.");
    }

    if (device.platform === "android") {
      return this.startAndroid(device, config);
    }

    if (device.platform === "ios") {
      throw new ActionableError(
        "iOS video recording is not handled by PlatformVideoCaptureBackend. " +
          "Route iOS devices through FfmpegVideoProcessingBackend (HybridVideoCaptureBackend does this automatically).",
      );
    }

    throw new ActionableError(`Unsupported platform for video recording: ${device.platform}`);
  }

  async stop(handle: RecordingHandle): Promise<RecordingResult> {
    const backendHandle = handle.backendHandle as BackendHandle | undefined;
    if (!backendHandle || backendHandle.kind !== "android") {
      throw new Error("Missing backend handle for video recording.");
    }

    logger.info(`[VideoCapture] Stopping recording ${handle.recordingId}`);

    // Stop screenrecord on the *device* with SIGINT first. If we only SIGINT the host
    // `adb shell screenrecord` process, ADB can drop the session before the device writes
    // the MP4 moov atom — leading to tiny/corrupt files that show a single frozen frame.
    // NOTE: pkill -2 signals *all* screenrecord processes on the device. This is fine for
    // single-recording usage but would interfere with concurrent recordings on the same device.
    const adbForStop = this.adbFactory.create(backendHandle.device);
    try {
      const pk = await adbForStop.executeCommand("shell pkill -2 screenrecord", 8000);
      logger.info(
        `[VideoCapture] Device pkill -2 screenrecord completed (out=${pk.stdout.trim().slice(0, 120)} err=${pk.stderr.trim().slice(0, 160)})`,
      );
    } catch (error) {
      logger.warn(
        `[VideoCapture] Device-side pkill -2 screenrecord failed; will rely on host SIGINT: ${errorMessage(error)}`,
      );
    }

    // Wait for the host adb process to exit now that remote screenrecord should have finalized
    const gracefulExitTimeout = 10000;
    let timeoutId: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<void>((resolve) => {
      timeoutId = this.timer.setTimeout(() => {
        if (backendHandle.process.exitCode === null && !backendHandle.process.killed) {
          logger.info(`[VideoCapture] Sending SIGINT to host adb after pkill wait`);
          backendHandle.process.kill("SIGINT");
        }
        resolve();
      }, gracefulExitTimeout);
    });

    await Promise.race([backendHandle.exitPromise, timeoutPromise]);
    if (timeoutId) {
      // Disarm through the injected timer, not the global clearTimeout. Once
      // the host adb has exited the 10 s SIGINT callback is stale; leaving it
      // armed (as global clearTimeout would, since the handle came from
      // this.timer.setTimeout) fires a SIGINT after the recording finished
      // (issue #4170).
      this.timer.clearTimeout(timeoutId);
    }

    if (backendHandle.process.exitCode === null) {
      logger.warn(`[VideoCapture] screenrecord still running after SIGINT; sending SIGKILL`);
      backendHandle.process.kill("SIGKILL");
      await backendHandle.exitPromise;
    } else {
      await backendHandle.exitPromise;
    }

    logger.info(
      `[VideoCapture] Process exited with code: ${backendHandle.exitState.exitCode}, signal: ${backendHandle.exitState.signal}`,
    );

    // Give screenrecord extra time to finalize the file on device
    // Even though the process has exited, file writes may still be in progress
    logger.info(`[VideoCapture] Waiting 1 second for file to finalize on device`);
    await this.timer.sleep(1000);

    const adb = this.adbFactory.create(backendHandle.device);

    // A stop immediately after start can still race the finalize wait above:
    // poll the device-side file size until it stops growing before pulling
    // (issue #6291). Best-effort — an unstable size after the budget just
    // means "pull it anyway and let the retry loop below absorb a transient
    // failure".
    await this.waitForDeviceFileToFinalize(adb, backendHandle.deviceTempPath);

    // Pull the file from the device
    logger.info(
      `[VideoCapture] Pulling file from device: ${backendHandle.deviceTempPath} -> ${handle.outputPath}`,
    );
    const pullArgs = ["pull", backendHandle.deviceTempPath, handle.outputPath];
    try {
      await this.pullRecordingFileWithRetry(adb, pullArgs, handle.recordingId);
    } finally {
      // Always clean up the /sdcard temp file, even when the pull failed —
      // otherwise a failed pull leaks the temp recording on the device on
      // every stop (issue #4170).
      logger.info(`[VideoCapture] Cleaning up temp file on device`);
      const rmArgs = ["shell", "rm", backendHandle.deviceTempPath];
      try {
        const rmProcess = await adb.spawn(rmArgs);

        await new Promise<void>((resolve) => {
          rmProcess.once("exit", () => {
            logger.info(`[VideoCapture] Temp file cleaned up`);
            resolve();
          });
          rmProcess.once("error", (err) => {
            logger.warn(`[VideoCapture] Failed to clean up temp file: ${err}`);
            resolve();
          });
        });
      } catch (err) {
        logger.warn(`[VideoCapture] Failed to clean up temp file: ${err}`);
      }
    }

    const sizeBytes = await getFileSize(handle.outputPath);
    logger.info(`[VideoCapture] Final file size: ${sizeBytes} bytes`);
    // Absolute host path leaks the local username; keep it diagnostic-only.
    logger.debug(`[VideoCapture] Output file at ${handle.outputPath}`);

    // Android `screenrecord` emits H.264, so this path was coincidentally
    // correct — but probe the finalized file rather than trusting a constant, so
    // the two backends stay honest through the same seam (#4965).
    const codec = await this.codecProbe.codec(handle.outputPath);

    if (backendHandle.exitState.exitCode && backendHandle.exitState.exitCode !== 0) {
      logger.warn(
        `[VideoCapture] Recording exited with code ${backendHandle.exitState.exitCode}: ${backendHandle.stderr.join("")}`,
      );
    }

    if (backendHandle.stderr.length > 0) {
      logger.info(`[VideoCapture] Stderr output: ${backendHandle.stderr.join("")}`);
    }

    return {
      recordingId: handle.recordingId,
      outputPath: handle.outputPath,
      startedAt: handle.startedAt,
      endedAt: backendHandle.exitState.endedAt ?? new Date().toISOString(),
      sizeBytes,
      codec,
    };
  }

  /**
   * Reads the on-device file's size via `stat`. Returns 0 (never throws) when
   * the file is missing or the command fails — both just mean "not finalized
   * yet" to the poll loop above, not a hard error.
   */
  private async readDeviceFileSizeBytes(adb: AdbExecutor, deviceTempPath: string): Promise<number> {
    try {
      const result = await adb.executeCommand(
        `shell stat -c %s ${deviceTempPath}`,
        5000,
        undefined,
        true,
      );
      const parsed = Number.parseInt(result.stdout.trim(), 10);
      return Number.isFinite(parsed) ? parsed : 0;
    } catch (error) {
      // A missing/unreadable file here just means "not finalized yet"; the
      // poll loop and the pull retry below absorb it.
      logger.debug(
        `[VideoCapture] Failed to stat device file ${deviceTempPath}: ${errorMessage(error)}`,
      );
      return 0;
    }
  }

  /**
   * Waits for the on-device recording file to stop growing before the caller
   * pulls it (issue #6291: a stop that lands right after start races
   * `screenrecord`'s own flush, so pulling too early sees a missing/empty
   * file and `adb pull` exits 1). Best-effort: if the size never visibly
   * stabilizes within the attempt budget, falls through and lets the caller
   * pull anyway — the pull retry loop covers a transient failure.
   */
  private async waitForDeviceFileToFinalize(
    adb: AdbExecutor,
    deviceTempPath: string,
  ): Promise<void> {
    let lastSize = -1;
    for (let attempt = 0; attempt < DEVICE_FILE_FINALIZE_POLL_ATTEMPTS; attempt++) {
      const size = await this.readDeviceFileSizeBytes(adb, deviceTempPath);
      if (size > 0 && size === lastSize) {
        logger.info(`[VideoCapture] Device file finalized at ${size} bytes`);
        return;
      }
      lastSize = size;
      await this.timer.sleep(DEVICE_FILE_FINALIZE_POLL_INTERVAL_MS);
    }
    logger.warn(
      `[VideoCapture] Device file ${deviceTempPath} did not visibly stabilize after ` +
        `${DEVICE_FILE_FINALIZE_POLL_ATTEMPTS} checks; pulling anyway`,
    );
  }

  /** Spawns `adb pull` once and settles on the process's exit code. */
  private async pullRecordingFile(adb: AdbExecutor, pullArgs: string[]): Promise<void> {
    const pullProcess = await adb.spawn(pullArgs);
    await new Promise<void>((resolve, reject) => {
      pullProcess.once("exit", (code) => {
        if (code === 0) {
          logger.info(`[VideoCapture] File pulled successfully`);
          resolve();
        } else {
          reject(new Error(`adb pull failed with exit code ${code}`));
        }
      });
      pullProcess.once("error", (err) => reject(err));
    });
  }

  /**
   * Retries a failed pull a bounded number of times (issue #6291: finalization
   * can still be racing the first attempt even after the wait above) before
   * surfacing a genuine failure as an {@link ActionableError} instead of the
   * raw `adb pull failed with exit code N` — the raw exec error was leaking
   * straight to the MCP client with no recovery hint.
   */
  private async pullRecordingFileWithRetry(
    adb: AdbExecutor,
    pullArgs: string[],
    recordingId: string,
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= PULL_MAX_ATTEMPTS; attempt++) {
      try {
        await this.pullRecordingFile(adb, pullArgs);
        return;
      } catch (error) {
        lastError = error;
        logger.warn(
          `[VideoCapture] adb pull attempt ${attempt}/${PULL_MAX_ATTEMPTS} failed for recording ` +
            `${recordingId}: ${errorMessage(error)}`,
        );
        if (attempt < PULL_MAX_ATTEMPTS) {
          await this.timer.sleep(PULL_RETRY_DELAY_MS);
        }
      }
    }
    throw new ActionableError(
      `Failed to pull video recording ${recordingId} from device after ${PULL_MAX_ATTEMPTS} attempts: ` +
        `${errorMessage(lastError)}`,
      { cause: lastError },
    );
  }

  async forceStop(handle: RecordingHandle): Promise<void> {
    const backendHandle = handle.backendHandle as BackendHandle | undefined;
    if (!backendHandle || backendHandle.kind !== "android") {
      throw new Error("Missing backend handle for video recording.");
    }

    const hostReapOutcome = waitForExit(backendHandle.process, backendHandle.exitPromise, {
      timeoutMs: 0,
      forceKillTimeoutMs: PROCESS_EXIT_TIMEOUT_MS,
      signal: "SIGKILL",
      timer: this.timer,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    // Do not wait for a potentially wedged device command before killing the
    // directly owned adb process. Shutdown has a short outer deadline.
    const adb = this.adbFactory.create(backendHandle.device);
    const failures: string[] = [];
    try {
      await adb.executeCommand("shell pkill -9 screenrecord", 8000);
    } catch (error) {
      logger.warn(`[VideoCapture] Device-side force-stop failed: ${error}`);
      failures.push(`screenrecord force-stop failed: ${errorMessage(error)}`);
    }
    try {
      await adb.execute(["shell", "rm", "-f", backendHandle.deviceTempPath], {
        timeoutMs: 8000,
      });
    } catch (error) {
      logger.warn(`[VideoCapture] Device temp-file cleanup failed: ${error}`);
      failures.push(`device temp-file cleanup failed: ${errorMessage(error)}`);
    }
    const hostReapError = await hostReapOutcome;
    if (hostReapError) {
      failures.push(`host adb process cleanup failed: ${errorMessage(hostReapError)}`);
    }
    if (failures.length > 0) {
      throw new ActionableError(
        `Failed to fully discard Android recording ${handle.recordingId}: ${failures.join("; ")}`,
      );
    }
  }

  private async startAndroid(
    device: BootedDevice,
    config: VideoCaptureConfig,
  ): Promise<RecordingHandle> {
    const adb = this.adbFactory.create(device);
    const bitrateKbps = clampBitrateKbps(config);
    const bitrateBps = Math.max(1, Math.round(bitrateKbps * 1000));
    const timeLimitSeconds = this.resolveAndroidTimeLimit(config.maxDurationSeconds);

    if (config.maxDurationSeconds && config.maxDurationSeconds > ANDROID_SCREENRECORD_MAX_SECONDS) {
      logger.warn(
        `[VideoCapture] Android screenrecord caps at ${ANDROID_SCREENRECORD_MAX_SECONDS}s; requested ${config.maxDurationSeconds}s.`,
      );
    }

    // Android screenrecord doesn't support stdout on all versions
    // Record to a temp file on the device, then pull it
    const deviceTempPath = `/sdcard/auto-mobile-${config.recordingId}.mp4`;

    const args = [
      "shell",
      "screenrecord",
      "--bit-rate",
      String(bitrateBps),
      "--time-limit",
      String(timeLimitSeconds),
    ];

    if (config.resolution) {
      args.push("--size", `${config.resolution.width}x${config.resolution.height}`);
    }

    args.push(deviceTempPath);

    logger.info(`[VideoCapture] Starting Android recording`);
    // The argv, device temp path and host output path embed the recording id
    // and local username; keep them diagnostic-only.
    logger.debug(`[VideoCapture] Screenrecord argv: ${args.join(" ")}`);
    logger.debug(`[VideoCapture] Device temp path: ${deviceTempPath}`);
    logger.debug(`[VideoCapture] Output path: ${config.outputPath}`);
    logger.info(
      `[VideoCapture] Bitrate: ${bitrateKbps}kbps (${bitrateBps}bps), Time limit: ${timeLimitSeconds}s`,
    );

    // A recording owns its process after this method returns. The request signal
    // must bound only startup, not kill an accepted recording after its caller
    // has moved on to post-tool auditing.
    const process = await adb.spawn(args, {
      signal: config.abortSignal,
      abortSignalScope: "startup",
    });
    const abortStartup = () => process.kill("SIGTERM");
    config.abortSignal?.addEventListener("abort", abortStartup, { once: true });
    if (config.abortSignal?.aborted) {
      abortStartup();
    }
    const stderr: string[] = [];
    const { exitState, exitPromise } = createExitTracker(process, stderr);

    const backendHandle: AndroidBackendHandle = {
      kind: "android",
      process,
      exitState,
      exitPromise,
      stderr,
      device,
      deviceTempPath,
    };
    config.abortSignal?.removeEventListener("abort", abortStartup);
    return {
      recordingId: config.recordingId,
      outputPath: config.outputPath,
      startedAt: config.startedAt,
      backendHandle,
    };
  }

  private resolveAndroidTimeLimit(maxDurationSeconds?: number): number {
    if (maxDurationSeconds && maxDurationSeconds > 0) {
      return Math.min(maxDurationSeconds, ANDROID_SCREENRECORD_MAX_SECONDS);
    }

    return ANDROID_SCREENRECORD_MAX_SECONDS;
  }
}

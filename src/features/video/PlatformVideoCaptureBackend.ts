import { spawn } from "node:child_process";
import path from "node:path";
import { promises as fsPromises } from "node:fs";
import { pathExists } from "../../utils/filesystem/DefaultFileSystem";
import { ActionableError, BootedDevice } from "../../models";
import { defaultTimer } from "../../utils/SystemTimer";
import type { Timer } from "../../utils/SystemTimer";
import { defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { logger } from "../../utils/logger";
import {
  createExitTracker,
  getFileSize,
  PROCESS_EXIT_TIMEOUT_MS,
  waitForExit,
  waitForSpawn,
  type ProcessExitState,
  type TrackedChildProcess,
} from "../../utils/ChildProcessTracker";
import type {
  RecordingHandle,
  RecordingResult,
  VideoCaptureBackend,
  VideoCaptureConfig,
} from "./VideoRecorderService";
import { ANDROID_SCREENRECORD_MAX_SECONDS } from "./androidScreenrecord";

interface AndroidBackendHandle {
  kind: "android";
  process: TrackedChildProcess;
  exitState: ProcessExitState;
  exitPromise: Promise<void>;
  stderr: string[];
  device: BootedDevice;
  deviceTempPath: string;
}

interface IosBackendHandle {
  kind: "ios";
  process: TrackedChildProcess;
  exitState: ProcessExitState;
  exitPromise: Promise<void>;
  stderr: string[];
  rawOutputPath: string;
  outputPath: string;
  resolution?: { width: number; height: number };
}

type BackendHandle = AndroidBackendHandle | IosBackendHandle;

function clampBitrateKbps(config: VideoCaptureConfig): number {
  const maxBitrateKbps = Math.max(0, Math.floor(config.maxThroughputMbps * 1000));
  if (!maxBitrateKbps) {
    return config.targetBitrateKbps;
  }

  return Math.min(config.targetBitrateKbps, maxBitrateKbps);
}

export class PlatformVideoCaptureBackend implements VideoCaptureBackend {
  constructor(
    private readonly adbFactory: AdbClientFactory = defaultAdbClientFactory,
    private readonly timer: Timer = defaultTimer
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
      return this.startIos(device, config);
    }

    throw new ActionableError(`Unsupported platform for video recording: ${device.platform}`);
  }

  async stop(handle: RecordingHandle): Promise<RecordingResult> {
    const backendHandle = handle.backendHandle as BackendHandle | undefined;
    if (!backendHandle) {
      throw new Error("Missing backend handle for video recording.");
    }

    logger.info(`[VideoCapture] Stopping recording ${handle.recordingId}`);

    if (backendHandle.kind === "android") {
      // Stop screenrecord on the *device* with SIGINT first. If we only SIGINT the host
      // `adb shell screenrecord` process, ADB can drop the session before the device writes
      // the MP4 moov atom — leading to tiny/corrupt files that show a single frozen frame.
      // NOTE: pkill -2 signals *all* screenrecord processes on the device. This is fine for
      // single-recording usage but would interfere with concurrent recordings on the same device.
      const adbForStop = this.adbFactory.create(backendHandle.device);
      try {
        const pk = await adbForStop.executeCommand("shell pkill -2 screenrecord", 8000);
        logger.info(
          `[VideoCapture] Device pkill -2 screenrecord completed (out=${pk.stdout.trim().slice(0, 120)} err=${pk.stderr.trim().slice(0, 160)})`
        );
      } catch (error) {
        logger.warn(
          `[VideoCapture] Device-side pkill -2 screenrecord failed; will rely on host SIGINT: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      // Wait for the host adb process to exit now that remote screenrecord should have finalized
      const gracefulExitTimeout = 10000;
      let timeoutId: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<void>(resolve => {
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
        clearTimeout(timeoutId);
      }

      if (backendHandle.process.exitCode === null && !backendHandle.process.killed) {
        logger.warn(`[VideoCapture] screenrecord still running after SIGINT; sending SIGKILL`);
        backendHandle.process.kill("SIGKILL");
        await backendHandle.exitPromise;
      } else {
        await backendHandle.exitPromise;
      }

      logger.info(`[VideoCapture] Process exited with code: ${backendHandle.exitState.exitCode}, signal: ${backendHandle.exitState.signal}`);

      // Give screenrecord extra time to finalize the file on device
      // Even though the process has exited, file writes may still be in progress
      logger.info(`[VideoCapture] Waiting 1 second for file to finalize on device`);
      await this.timer.sleep(1000);
    } else {
      await waitForExit(backendHandle.process, backendHandle.exitPromise, {
        timeoutMs: PROCESS_EXIT_TIMEOUT_MS,
      });
      logger.info(
        `[VideoCapture] Process exited with code: ${backendHandle.exitState.exitCode}, signal: ${backendHandle.exitState.signal}`
      );
    }

    if (backendHandle.kind === "android") {
      // Pull the file from the device
      logger.info(`[VideoCapture] Pulling file from device: ${backendHandle.deviceTempPath} -> ${handle.outputPath}`);
      const adb = this.adbFactory.create(backendHandle.device);
      const pullArgs = ["pull", backendHandle.deviceTempPath, handle.outputPath];
      const pullProcess = await adb.spawn(pullArgs);

      await new Promise<void>((resolve, reject) => {
        pullProcess.once("exit", code => {
          if (code === 0) {
            logger.info(`[VideoCapture] File pulled successfully`);
            resolve();
          } else {
            reject(new Error(`adb pull failed with exit code ${code}`));
          }
        });
        pullProcess.once("error", err => reject(err));
      });

      // Clean up temp file on device
      logger.info(`[VideoCapture] Cleaning up temp file on device`);
      const rmArgs = ["shell", "rm", backendHandle.deviceTempPath];
      const rmProcess = await adb.spawn(rmArgs);

      await new Promise<void>(resolve => {
        rmProcess.once("exit", () => {
          logger.info(`[VideoCapture] Temp file cleaned up`);
          resolve();
        });
        rmProcess.once("error", err => {
          logger.warn(`[VideoCapture] Failed to clean up temp file: ${err}`);
          resolve(); // Don't fail the whole operation if cleanup fails
        });
      });
    } else {
      await this.finalizeIosRecording(backendHandle);
    }

    const sizeBytes = await getFileSize(handle.outputPath);
    logger.info(`[VideoCapture] Final file size: ${sizeBytes} bytes at ${handle.outputPath}`);

    const codec = "h264";

    if (backendHandle.exitState.exitCode && backendHandle.exitState.exitCode !== 0) {
      logger.warn(
        `[VideoCapture] Recording exited with code ${backendHandle.exitState.exitCode}: ${backendHandle.stderr.join("")}`
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

  private async startAndroid(
    device: BootedDevice,
    config: VideoCaptureConfig
  ): Promise<RecordingHandle> {
    const adb = this.adbFactory.create(device);
    const bitrateKbps = clampBitrateKbps(config);
    const bitrateBps = Math.max(1, Math.round(bitrateKbps * 1000));
    const timeLimitSeconds = this.resolveAndroidTimeLimit(config.maxDurationSeconds);

    if (config.maxDurationSeconds && config.maxDurationSeconds > ANDROID_SCREENRECORD_MAX_SECONDS) {
      logger.warn(
        `[VideoCapture] Android screenrecord caps at ${ANDROID_SCREENRECORD_MAX_SECONDS}s; requested ${config.maxDurationSeconds}s.`
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

    logger.info(`[VideoCapture] Starting Android recording: ${args.join(" ")}`);
    logger.info(`[VideoCapture] Device temp path: ${deviceTempPath}`);
    logger.info(`[VideoCapture] Output path: ${config.outputPath}`);
    logger.info(`[VideoCapture] Bitrate: ${bitrateKbps}kbps (${bitrateBps}bps), Time limit: ${timeLimitSeconds}s`);

    const process = await adb.spawn(args);

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

    return {
      recordingId: config.recordingId,
      outputPath: config.outputPath,
      startedAt: config.startedAt,
      backendHandle,
    };
  }

  private async startIos(
    device: BootedDevice,
    config: VideoCaptureConfig
  ): Promise<RecordingHandle> {
    const simctl = new SimCtlClient(device);
    const available = await simctl.isAvailable();
    if (!available) {
      throw new ActionableError("simctl is not available. Install Xcode command line tools.");
    }

    const rawOutputPath = config.resolution
      ? path.join(config.outputDirectory, `raw-${config.fileName}`)
      : config.outputPath;

    const args = [
      "simctl",
      "io",
      device.deviceId,
      "recordVideo",
      "--codec",
      "h264",
      "--force",
      rawOutputPath,
    ];

    const process = spawn("xcrun", args, { stdio: ["ignore", "ignore", "ignore"] });

    try {
      await waitForSpawn(process);
    } catch (error) {
      throw new ActionableError(`Failed to start iOS recording: ${error}`);
    }

    const stderr: string[] = [];
    const { exitState, exitPromise } = createExitTracker(process, stderr);

    const backendHandle: IosBackendHandle = {
      kind: "ios",
      process,
      exitState,
      exitPromise,
      stderr,
      rawOutputPath,
      outputPath: config.outputPath,
      resolution: config.resolution,
    };

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

  private async finalizeIosRecording(handle: IosBackendHandle): Promise<void> {
    const needsScale = Boolean(handle.resolution);
    if (!needsScale) {
      if (handle.rawOutputPath !== handle.outputPath) {
        await this.replaceOutputFile(handle.rawOutputPath, handle.outputPath);
      }
      return;
    }

    const resolution = handle.resolution!;
    const ffmpegAvailable = await this.isFfmpegAvailable();
    if (!ffmpegAvailable) {
      logger.warn("[VideoCapture] FFmpeg not available; keeping original iOS recording.");
      await this.replaceOutputFile(handle.rawOutputPath, handle.outputPath);
      return;
    }

    try {
      await this.scaleWithFfmpeg(handle.rawOutputPath, handle.outputPath, resolution);
      await fsPromises.rm(handle.rawOutputPath, { recursive: true, force: true });
    } catch (error) {
      logger.warn(`[VideoCapture] Failed to scale iOS recording: ${error}`);
      await this.replaceOutputFile(handle.rawOutputPath, handle.outputPath);
    }
  }

  private async replaceOutputFile(sourcePath: string, destinationPath: string): Promise<void> {
    if (sourcePath === destinationPath) {
      return;
    }

    const sourceExists = await pathExists(sourcePath);
    if (!sourceExists) {
      logger.warn(`[VideoCapture] Missing iOS recording at ${sourcePath}`);
      return;
    }

    await fsPromises.rm(destinationPath, { recursive: true, force: true });
    await fsPromises.rename(sourcePath, destinationPath);
  }

  private async isFfmpegAvailable(): Promise<boolean> {
    return new Promise(resolve => {
      const process = spawn("ffmpeg", ["-version"], { stdio: ["ignore", "pipe", "pipe"] });
      process.once("error", () => resolve(false));
      process.once("exit", code => resolve(code === 0));
    });
  }

  private async scaleWithFfmpeg(
    inputPath: string,
    outputPath: string,
    resolution: { width: number; height: number }
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const args = [
        "-y",
        "-i",
        inputPath,
        "-vf",
        `scale=${resolution.width}:${resolution.height}`,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        outputPath,
      ];

      const process = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";

      process.stderr.on("data", chunk => {
        stderr += chunk.toString();
      });

      process.once("error", error => reject(error));
      process.once("exit", code => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(stderr || `ffmpeg exited with code ${code}`));
        }
      });
    });
  }
}

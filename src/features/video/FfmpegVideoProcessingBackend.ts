import { errorMessage } from "../../utils/describeUnknownError";
import { platform } from "node:os";
import path from "node:path";
import { promises as fsPromises } from "node:fs";
import { pathExists } from "../../utils/filesystem/DefaultFileSystem";
import { ActionableError, type BootedDevice } from "../../models";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { exponentialBackoff, normalizeBackoff, type BackoffInput } from "../../utils/Backoff";
import { defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import { SimCtlClient, type SimCtl } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { logger } from "../../utils/logger";
import { defaultRecordingCodecProbe, type RecordingCodecProbe } from "./recordingCodec";
import {
  DefaultFfmpegClient,
  type FfmpegClient,
  type FfmpegProbeResult,
  type FfmpegProcess,
} from "../../utils/media/FfmpegClient";
import {
  getFileSize,
  PROCESS_EXIT_TIMEOUT_MS,
  trackProcess,
  waitForExit,
  waitForSpawn,
  type ProcessExitState,
  type ProcessTracker,
  type StoppableProcess,
} from "../../utils/ChildProcessTracker";
import type {
  RecordingHandle,
  RecordingResult,
  VideoCaptureBackend,
  VideoCaptureConfig,
} from "./VideoRecorderService";

export { PROCESS_EXIT_TIMEOUT_MS, waitForExit };
export type { ProcessTracker, StoppableProcess };
// `xcrun simctl io ... recordVideo` only writes the MP4/MOV moov atom after it
// receives SIGINT. If we SIGKILL it before the flush finishes the on-disk file is
// truncated (often 0 bytes), and the downstream ffmpeg `-c copy` remux fails with
// "moov atom not found". On a loaded CI macOS runner the flush can take well over
// the generic 5s window, so the iOS stop path waits much longer before escalating
// to SIGKILL. In the normal case simctl exits within ~1s and we return immediately.
export const IOS_RECORDING_STOP_TIMEOUT_MS = 30000;
// Even after the `simctl recordVideo` process has fully exited, the raw `.mov`
// can lag behind on a loaded CI runner: the moov-atom flush and the filesystem
// write are not guaranteed to be visible the instant the process exits, so a
// single `stat` immediately after `waitForExit` can momentarily see the file
// missing or 0 bytes and hard-fail. We poll (bounded, with backoff) for the file
// to exist, be non-empty, and have a stable size before handing it to ffmpeg.
export const IOS_RECORDING_FILE_READY_TIMEOUT_MS = 15000;
const IOS_RECORDING_FILE_READY_INITIAL_BACKOFF_MS = 100;
const IOS_RECORDING_FILE_READY_MAX_BACKOFF_MS = 1000;
const FFMPEG_POST_PROCESS_TIMEOUT_MS = 60000;
export const IOS_RECORDING_START_TIMEOUT_MS = 5000;
const IOS_RECORDING_START_CLEANUP_TIMEOUT_MS = 500;
// A cold or loaded simulator can silently miss the very first `recordVideo`
// start handshake (#4076): simctl produces no "Recording started" and no error,
// and the single attempt times out. Retry the start a bounded number of times
// before failing, capturing simulator state on each miss so a genuine wedge is
// diagnosable rather than surfacing as a bare timeout.
const IOS_RECORDING_START_MAX_ATTEMPTS = 2;
const IOS_RECORDING_DIAGNOSTIC_TIMEOUT_MS = 5000;
// `simctl` emits this only after processing its first video frame. The earlier
// "Defaulting to display" diagnostic proves only display selection, which can
// still produce a zero-byte capture on a cold simulator.
const IOS_RECORDING_START_MESSAGES = ["Recording started"];

interface HardwareAccelInfo {
  encoder: string;
  available: boolean;
  description: string;
}

type FfmpegInput = { type: "pipe" } | { type: "file"; path: string };

type FfmpegDiagnosticsTracker = Pick<ProcessTracker, "exitState" | "stderr">;
type ProcessDiagnosticsTracker = Pick<ProcessTracker, "exitState" | "stderr">;

function isFailedExitCode(exitCode: number | null | undefined): boolean {
  return exitCode !== undefined && exitCode !== 0;
}

function isFailedExitState(exitState: ProcessExitState): boolean {
  return (
    isFailedExitCode(exitState.exitCode) ||
    (exitState.signal !== undefined && exitState.signal !== null)
  );
}

interface FfmpegBackendHandle {
  kind: "ffmpeg";
  platform: "android" | "ios";
  captureTracker: ProcessTracker;
  ffmpegTracker?: ProcessTracker;
  capturePath?: string;
  config: VideoCaptureConfig;
}

/**
 * Minimal filesystem surface for probing a recording file's size. Returns the
 * size in bytes, or `null` when the file does not yet exist. Narrowed so the
 * readiness poll can be unit-tested with a fake instead of a real `stat`.
 */
export interface RecordingFileProbe {
  size(filePath: string): Promise<number | null>;
}

const defaultRecordingFileProbe: RecordingFileProbe = {
  async size(filePath: string): Promise<number | null> {
    try {
      const stats = await fsPromises.stat(filePath);
      return stats.size;
    } catch (error) {
      // ENOENT is expected while ffmpeg hasn't created the output file yet;
      // null lets the readiness poll keep waiting instead of erroring out.
      logger.debug(
        `src/features/video/FfmpegVideoProcessingBackend.ts recording file stat failed: ${error}`,
        error,
      );
      return null;
    }
  },
};

export interface WaitForRecordingFileOptions {
  probe?: RecordingFileProbe;
  timeoutMs?: number;
  backoff?: BackoffInput;
  timer?: Timer;
}

/**
 * Wait for a `simctl recordVideo` raw capture file to fully materialize after the
 * recorder process has exited. Polls with backoff until the file exists, is
 * non-empty, and its size has stopped changing between two consecutive probes
 * (so we never hand a still-flushing/truncated file to ffmpeg). Throws a
 * diagnostic error on timeout describing what was actually observed
 * (never appeared / stayed empty / never stabilized) instead of failing on the
 * first missing-file glance.
 */
export async function waitForRecordingFileReady(
  filePath: string,
  options: WaitForRecordingFileOptions = {},
): Promise<number> {
  const probe = options.probe ?? defaultRecordingFileProbe;
  const timer = options.timer ?? defaultTimer;
  const timeoutMs = options.timeoutMs ?? IOS_RECORDING_FILE_READY_TIMEOUT_MS;
  const backoff = normalizeBackoff(
    options.backoff ??
      exponentialBackoff({
        initialDelayMs: IOS_RECORDING_FILE_READY_INITIAL_BACKOFF_MS,
        maxDelayMs: IOS_RECORDING_FILE_READY_MAX_BACKOFF_MS,
      }),
  );

  const deadline = timer.now() + timeoutMs;
  let attempt = 0;
  let everExisted = false;
  let previousSize: number | null = null;

  for (;;) {
    attempt++;
    const size = await probe.size(filePath);
    if (size !== null) {
      everExisted = true;
      // A non-empty file whose size matches the previous probe has finished flushing.
      if (size > 0 && size === previousSize) {
        return size;
      }
    }
    previousSize = size;

    if (timer.now() >= deadline) {
      const observed = !everExisted
        ? "never appeared"
        : previousSize === null
          ? "disappeared after appearing"
          : previousSize === 0
            ? "stayed empty (0 bytes)"
            : `stopped at ${previousSize} bytes but never stabilized`;
      throw new Error(
        `iOS recording file not ready at ${filePath} after ${timeoutMs}ms (${attempt} probes): ${observed}`,
      );
    }

    await timer.sleep(backoff.delayForAttempt(attempt));
  }
}

function stderrMessages(messages: string | string[]): string[] {
  return Array.isArray(messages) ? messages : [messages];
}

async function waitWithinDeadline<T>(
  operation: Promise<T>,
  deadlineMs: number,
  timer: Timer,
  timeoutMessage: string,
): Promise<T> {
  const remainingMs = Math.max(0, deadlineMs - timer.now());
  let timeoutId: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = timer.setTimeout(() => reject(new Error(timeoutMessage)), remainingMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timeoutId) {
      timer.clearTimeout(timeoutId);
    }
  }
}

async function runWithinDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  deadlineMs: number,
  timer: Timer,
  callerSignal: AbortSignal | undefined,
  timeoutMessage: string,
): Promise<T> {
  callerSignal?.throwIfAborted();
  const deadlineController = new AbortController();
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, deadlineController.signal])
    : deadlineController.signal;
  const timeoutError = new Error(timeoutMessage);
  const remainingMs = Math.max(0, deadlineMs - timer.now());
  let rejectOnAbort: ((reason?: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = reject;
  });
  const onAbort = () => rejectOnAbort?.(signal.reason ?? timeoutError);
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) {
    onAbort();
  }
  const operationPromise = operation(signal);
  const timeoutId = timer.setTimeout(() => deadlineController.abort(timeoutError), remainingMs);

  try {
    return await Promise.race([operationPromise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
    timer.clearTimeout(timeoutId);
  }
}

function hasStderrMessage(
  tracker: Pick<ProcessTracker, "stderr">,
  messages: string | string[],
): boolean {
  const stderr = tracker.stderr.join("");
  return stderrMessages(messages).some((message) => stderr.includes(message));
}

export function containsIosRecordingStartMessage(stderr: string): boolean {
  return IOS_RECORDING_START_MESSAGES.some((message) => stderr.includes(message));
}

export interface WaitForStderrMessageOptions {
  timer?: Timer;
  signal?: AbortSignal;
}

/**
 * Pipe the capture process's stdout into the encoder's stdin, attaching an
 * error handler to both streams first.
 *
 * `.pipe()` alone routes destination write errors nowhere. If the ffmpeg
 * encoder exits or crashes mid-recording (bad codec args, OOM), its stdin
 * closes while the still-running `screenrecord` capture keeps writing into it,
 * producing an unhandled stream `'error'` (EPIPE / ERR_STREAM_WRITE_AFTER_END)
 * that can crash the daemon. A broken encoder pipe is expected on abnormal
 * encoder exit, so we log at debug and swallow (error-handling strategy 3).
 */
export function pipeCaptureToEncoder(
  source: NodeJS.ReadableStream | null,
  dest: NodeJS.WritableStream | null,
): void {
  if (!source || !dest) {
    throw new ActionableError(
      "Cannot pipe screenrecord output to ffmpeg: capture stdout or encoder stdin stream is unavailable",
    );
  }
  dest.on("error", (error: Error) => {
    // Encoder stdin closing (EPIPE) is expected when ffmpeg exits before capture stops.
    logger.debug(`[FfmpegVideo] encoder stdin stream error (expected on encoder exit): ${error}`);
  });
  source.on("error", (error: Error) => {
    // Capture stdout erroring after the encoder pipe closed is likewise expected.
    logger.debug(`[FfmpegVideo] capture stdout stream error: ${error}`);
  });
  source.pipe(dest);
}

export async function waitForStderrMessage(
  tracker: ProcessTracker,
  messages: string | string[],
  timeoutMs: number,
  options: WaitForStderrMessageOptions = {},
): Promise<void> {
  const expected = stderrMessages(messages);
  const expectedDescription = expected.join(" or ");
  const timer = options.timer ?? defaultTimer;

  if (hasStderrMessage(tracker, expected)) {
    return;
  }
  if (
    tracker.exitState.endedAt !== undefined ||
    (tracker.process.exitCode !== null && tracker.process.exitCode !== undefined) ||
    (tracker.process.signalCode !== null && tracker.process.signalCode !== undefined)
  ) {
    throw new Error(`Process exited before ${expectedDescription}`);
  }
  options.signal?.throwIfAborted();
  const stderrStream = tracker.process.stderr;
  if (!stderrStream) {
    throw new Error(`Cannot wait for ${expectedDescription}: process stderr is not captured`);
  }

  let timeoutId: NodeJS.Timeout | undefined;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      stderrStream.off("data", onData);
      tracker.process.off("exit", onExit);
      tracker.process.off("error", onError);
      options.signal?.removeEventListener("abort", onAbort);
      if (timeoutId) {
        timer.clearTimeout(timeoutId);
      }
    };
    const complete = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback();
    };
    const onData = () => {
      if (hasStderrMessage(tracker, expected)) {
        complete(resolve);
      }
    };
    const onExit = () => {
      complete(() => reject(new Error(`Process exited before ${expectedDescription}`)));
    };
    const onError = (error: Error) => {
      complete(() => reject(error));
    };
    const onAbort = () => {
      complete(() => reject(options.signal?.reason ?? new Error("Recording start was cancelled.")));
    };

    stderrStream.on("data", onData);
    tracker.process.once("exit", onExit);
    tracker.process.once("error", onError);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    onData();
    timeoutId = timer.setTimeout(() => {
      if (hasStderrMessage(tracker, expected)) {
        complete(resolve);
        return;
      }
      complete(() => reject(new Error(`Timed out waiting for ${expectedDescription}`)));
    }, timeoutMs);
  });
}

function forceStopStartingProcess(process: StoppableProcess | undefined): void {
  if (process && process.exitCode === null && !process.killed) {
    process.kill("SIGKILL");
  }
}

function throwIfRecordingStartAborted(
  abortSignal: AbortSignal | undefined,
  platformName: "Android" | "iOS",
): void {
  if (abortSignal?.aborted) {
    throw new ActionableError(`${platformName} recording start was cancelled during shutdown.`);
  }
}

function throwAndroidRecordingStartFailure(
  error: unknown,
  abortSignal: AbortSignal | undefined,
): never {
  throwIfRecordingStartAborted(abortSignal, "Android");
  logger.error(`[FfmpegVideo] Failed to start Android recording: ${error}`);
  throw new ActionableError(`Failed to start Android recording: ${error}`);
}

export class FfmpegVideoProcessingBackend implements VideoCaptureBackend {
  private hwAccelCache: Map<string, HardwareAccelInfo> = new Map();
  private ffmpegProbeResult: FfmpegProbeResult | undefined;
  // Overridable in tests so the retry path can be exercised without real waits.
  private readonly iosRecordingStartTimeoutMs: number = IOS_RECORDING_START_TIMEOUT_MS;
  private readonly iosRecordingStartMaxAttempts: number = IOS_RECORDING_START_MAX_ATTEMPTS;

  constructor(
    private readonly adbFactory: AdbClientFactory = defaultAdbClientFactory,
    private readonly simctlFactory: (device: BootedDevice) => SimCtl = (device) =>
      new SimCtlClient(device),
    private readonly ffmpegClient: FfmpegClient = new DefaultFfmpegClient(),
    // Injectable so hardware-accel detection can be tested for every OS branch on
    // any CI host, rather than only the branch matching the runner's platform.
    private readonly platformProvider: () => NodeJS.Platform = platform,
    // Injectable so the codec label can be asserted from synthetic files without
    // producing real recordings (#4965).
    private readonly codecProbe: RecordingCodecProbe = defaultRecordingCodecProbe,
    private readonly timer: Timer = defaultTimer,
  ) {}

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

    if (backendHandle.platform === "android") {
      await waitForExit(
        backendHandle.captureTracker.process,
        backendHandle.captureTracker.exitPromise,
      );

      if (backendHandle.ffmpegTracker) {
        await waitForExit(
          backendHandle.ffmpegTracker.process,
          backendHandle.ffmpegTracker.exitPromise,
        );
      }
    } else {
      // iOS: simctl writes the moov atom only after SIGINT, so give it a generous
      // window to finalize the file before escalating to SIGKILL. A premature
      // SIGKILL truncates the raw .mov and breaks the ffmpeg `-c copy` remux.
      await waitForExit(
        backendHandle.captureTracker.process,
        backendHandle.captureTracker.exitPromise,
        { timeoutMs: IOS_RECORDING_STOP_TIMEOUT_MS },
      );
      await this.postProcessRecording(backendHandle);
    }

    const sizeBytes = await getFileSize(handle.outputPath);
    // Report what was actually produced. The iOS `-c copy` fast path preserves
    // the simctl source (HEVC on modern hardware), while the re-encode branches
    // emit H.264 — a single constant mislabeled the common case (#4965).
    const codec = await this.codecProbe.codec(handle.outputPath);

    this.logProcessWarnings("capture", backendHandle.captureTracker);
    if (backendHandle.ffmpegTracker) {
      this.logProcessWarnings("ffmpeg", backendHandle.ffmpegTracker);
    }

    return {
      recordingId: handle.recordingId,
      outputPath: handle.outputPath,
      startedAt: handle.startedAt,
      endedAt: backendHandle.captureTracker.exitState.endedAt ?? new Date().toISOString(),
      sizeBytes,
      codec,
    };
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

    const screenrecordArgs = ["exec-out", "screenrecord", "-"];

    logger.info(`[FfmpegVideo] Starting screenrecord: ${screenrecordArgs.join(" ")}`);

    const captureProcess = await adb.spawn(screenrecordArgs);
    let ffmpegProcess: FfmpegProcess | undefined;
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
      const ffmpegArgs = await this.buildFfmpegArgs(config, hwAccel, { type: "pipe" });
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

      const captureTracker = trackProcess(captureProcess);
      const ffmpegTracker = trackProcess(ffmpegProcess);

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
        backendHandle,
      };
    } catch (error) {
      forceStopStartingProcesses();
      return throwAndroidRecordingStartFailure(error, config.abortSignal);
    } finally {
      config.abortSignal?.removeEventListener("abort", abortStartingCapture);
    }
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
      config.abortSignal,
      `Timed out checking simctl availability within ${this.iosRecordingStartTimeoutMs}ms`,
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

    const capturePath = path.join(config.outputDirectory, `${config.recordingId}-raw.mov`);

    const args = ["io", device.deviceId, "recordVideo", capturePath];

    const maxAttempts = Math.max(1, this.iosRecordingStartMaxAttempts);
    const attemptFailures: string[] = [];

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      throwIfRecordingStartAborted(config.abortSignal, "iOS");
      const remainingBeforeSpawn = startDeadlineMs - this.timer.now();
      if (remainingBeforeSpawn <= 0) {
        break;
      }
      const captureProcess = await simctl.startCommandArgs(args, {
        stdio: ["ignore", "ignore", "pipe"],
      });
      const captureTracker = trackProcess(captureProcess);
      let spawned = false;

      try {
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
          backendHandle,
        };
      } catch (error) {
        attemptFailures.push(
          await this.describeFailedIosStartAttempt({
            attempt,
            captureTracker,
            config,
            device,
            error,
            maxAttempts,
            simctl,
            spawned,
            startDeadlineMs,
          }),
        );

        if (attempt >= maxAttempts) {
          throw new ActionableError(
            this.buildProcessFailureMessage(
              `Failed to start iOS recording after ${maxAttempts} attempt(s): ${attemptFailures.join(" | ")}`,
              "xcrun simctl",
              args,
              captureTracker,
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

  private async describeFailedIosStartAttempt(input: {
    attempt: number;
    captureTracker: ProcessTracker;
    config: VideoCaptureConfig;
    device: BootedDevice;
    error: unknown;
    maxAttempts: number;
    simctl: SimCtl;
    spawned: boolean;
    startDeadlineMs: number;
  }): Promise<string> {
    const stopError = await this.cleanupFailedIosStart(input.captureTracker, input.startDeadlineMs);
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
    );
    logger.warn(
      `[FfmpegVideo] iOS recording start attempt ${input.attempt}/${input.maxAttempts} failed: ${input.error} (${diagnostics})`,
    );
    const cleanupSuffix = stopError ? `; cleanup failed: ${stopError}` : "";
    return `attempt ${input.attempt}/${input.maxAttempts}: ${input.error}${cleanupSuffix}; ${diagnostics}`;
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
    simctl: SimCtl,
    device: BootedDevice,
    startDeadlineMs: number,
  ): Promise<string> {
    const diagnosticBudgetMs = Math.max(0, Math.min(250, startDeadlineMs - this.timer.now()));
    return diagnosticBudgetMs > 0
      ? await this.captureSimulatorDiagnostics(simctl, device, diagnosticBudgetMs)
      : "simulator state unavailable: startup budget exhausted";
  }

  /**
   * Best-effort snapshot of the target simulator's state, used only to enrich a
   * start-timeout failure. Never throws: a diagnostics failure must not mask the
   * original recording error.
   */
  private async captureSimulatorDiagnostics(
    simctl: SimCtl,
    device: BootedDevice,
    timeoutMs: number,
  ): Promise<string> {
    try {
      const result = await simctl.executeCommandArgs(
        ["list", "devices", device.deviceId],
        Math.min(IOS_RECORDING_DIAGNOSTIC_TIMEOUT_MS, timeoutMs),
      );
      const text = (result.stdout || result.stderr || "").replace(/\s+/g, " ").trim();
      return text ? `simulator state: ${text.slice(0, 500)}` : "simulator state: (empty)";
    } catch (error) {
      const reason = errorMessage(error);
      return `simulator state unavailable: ${reason}`;
    }
  }

  private async postProcessRecording(backendHandle: FfmpegBackendHandle): Promise<void> {
    const capturePath = backendHandle.capturePath;
    if (!capturePath) {
      throw new ActionableError("Missing iOS capture path for FFmpeg processing.");
    }

    // simctl finalizes the moov atom on SIGINT, but the flush + filesystem write
    // can lag behind process exit on a loaded runner. Poll for a stable, non-empty
    // file before failing, so a momentarily-missing file is not a hard error (#2730).
    try {
      await waitForRecordingFileReady(capturePath);
    } catch (error) {
      const reason = errorMessage(error);
      throw new ActionableError(
        this.buildProcessFailureMessage(
          `iOS recording file missing at ${capturePath}: ${reason}`,
          "xcrun simctl",
          [
            "io",
            backendHandle.config.device?.deviceId ?? "(unknown-device)",
            "recordVideo",
            capturePath,
          ],
          backendHandle.captureTracker,
          capturePath,
        ),
      );
    }

    const hwAccel = await this.detectHardwareAccel();
    const ffmpegArgs = await this.buildFfmpegArgs(backendHandle.config, hwAccel, {
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
      throw new ActionableError(`Failed to start FFmpeg post-processing: ${error}`);
    }

    const ffmpegTracker = trackProcess(ffmpegProcess);
    backendHandle.ffmpegTracker = ffmpegTracker;

    await waitForExit(ffmpegProcess, ffmpegTracker.exitPromise, {
      timeoutMs: FFMPEG_POST_PROCESS_TIMEOUT_MS,
      signal: null,
    });

    if (isFailedExitState(ffmpegTracker.exitState)) {
      throw new ActionableError(
        this.buildFfmpegFailureMessage("FFmpeg post-processing failed", ffmpegArgs, ffmpegTracker),
      );
    }

    await this.assertFfmpegOutputReady(backendHandle.config.outputPath, ffmpegArgs, ffmpegTracker);

    try {
      await fsPromises.rm(capturePath, { recursive: true, force: true });
    } catch (error) {
      logger.warn(`[FfmpegVideo] Failed to remove raw recording ${capturePath}: ${error}`);
    }
  }

  private async buildFfmpegArgs(
    config: VideoCaptureConfig,
    hwAccel: HardwareAccelInfo,
    input: FfmpegInput,
  ): Promise<string[]> {
    const args: string[] = [];

    if (input.type === "pipe") {
      args.push("-f", "mp4", "-i", "pipe:0");
    } else {
      args.push("-i", input.path);

      if (!config.resolution) {
        args.push("-c", "copy");
        args.push("-movflags", "+faststart");
        // Keep the iOS simulator fast stream-copy remux while honoring explicit duration caps.
        if (config.maxDurationSeconds && config.maxDurationSeconds > 0) {
          args.push("-t", String(config.maxDurationSeconds));
        }
        args.push("-y");
        args.push(config.outputPath);
        return args;
      }
    }

    args.push("-r", String(config.fps));

    if (config.resolution) {
      args.push("-vf", `scale=${config.resolution.width}:${config.resolution.height}`);
    }

    if (hwAccel.available) {
      args.push("-c:v", hwAccel.encoder);
      logger.info(`[FfmpegVideo] Using hardware acceleration: ${hwAccel.description}`);
    } else {
      args.push("-c:v", "libx264");
      args.push("-preset", "ultrafast");
      logger.warn(
        `[FfmpegVideo] Hardware acceleration unavailable, falling back to software encoding`,
      );
    }

    args.push("-b:v", `${config.targetBitrateKbps}k`);
    args.push("-maxrate", `${config.targetBitrateKbps}k`);
    args.push("-bufsize", `${config.targetBitrateKbps * 2}k`);

    args.push("-profile:v", "baseline");
    args.push("-level", "3.0");
    args.push("-pix_fmt", "yuv420p");

    args.push("-movflags", "+faststart");

    if (config.maxDurationSeconds && config.maxDurationSeconds > 0) {
      args.push("-t", String(config.maxDurationSeconds));
    }

    args.push("-y");
    args.push(config.outputPath);

    return args;
  }

  private async detectHardwareAccel(): Promise<HardwareAccelInfo> {
    const os = this.platformProvider();
    const cacheKey = os;

    if (this.hwAccelCache.has(cacheKey)) {
      return this.hwAccelCache.get(cacheKey)!;
    }

    let result: HardwareAccelInfo;

    if (os === "darwin") {
      result = await this.detectVideoToolbox();
    } else if (os === "linux") {
      result = await this.detectLinuxHwAccel();
    } else {
      result = {
        encoder: "libx264",
        available: false,
        description: `Unsupported platform: ${os}`,
      };
    }

    this.hwAccelCache.set(cacheKey, result);
    return result;
  }

  private async detectVideoToolbox(): Promise<HardwareAccelInfo> {
    try {
      const encoders = await this.listEncoders();
      const hasVideoToolbox = encoders.some((enc) => enc.includes("h264_videotoolbox"));

      if (hasVideoToolbox) {
        return {
          encoder: "h264_videotoolbox",
          available: true,
          description: "macOS VideoToolbox (hardware acceleration)",
        };
      }

      return {
        encoder: "libx264",
        available: false,
        description: "VideoToolbox not available",
      };
    } catch (error) {
      logger.warn(`[FfmpegVideo] Failed to detect VideoToolbox: ${error}`);
      return {
        encoder: "libx264",
        available: false,
        description: "VideoToolbox detection failed",
      };
    }
  }

  private async detectLinuxHwAccel(): Promise<HardwareAccelInfo> {
    try {
      const encoders = await this.listEncoders();

      const nvencAvailable = encoders.some((enc) => enc.includes("h264_nvenc"));
      if (nvencAvailable) {
        return {
          encoder: "h264_nvenc",
          available: true,
          description: "NVIDIA NVENC (hardware acceleration)",
        };
      }

      const vaapiAvailable = encoders.some((enc) => enc.includes("h264_vaapi"));
      if (vaapiAvailable) {
        return {
          encoder: "h264_vaapi",
          available: true,
          description: "VAAPI (hardware acceleration)",
        };
      }

      return {
        encoder: "libx264",
        available: false,
        description: "No hardware acceleration available (VAAPI/NVENC not found)",
      };
    } catch (error) {
      logger.warn(`[FfmpegVideo] Failed to detect Linux HW accel: ${error}`);
      return {
        encoder: "libx264",
        available: false,
        description: "Hardware acceleration detection failed",
      };
    }
  }

  private async listEncoders(): Promise<string[]> {
    return (await this.probeFfmpeg()).encoders;
  }

  private async ensureFfmpegAvailable(
    deadlineMs?: number,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    try {
      await this.checkFfmpegVersion(deadlineMs, abortSignal);
    } catch (error) {
      throwIfRecordingStartAborted(abortSignal, "iOS");
      throw new ActionableError(
        `FFmpeg is not available. Please install FFmpeg to use video recording.\n` +
          `  macOS: brew install ffmpeg\n` +
          `  Linux: apt-get install ffmpeg or yum install ffmpeg\n` +
          `Error: ${error}`,
      );
    }
  }

  private async checkFfmpegVersion(deadlineMs?: number, abortSignal?: AbortSignal): Promise<void> {
    const { version } = await this.probeFfmpeg(deadlineMs, abortSignal);
    logger.debug(`[FfmpegVideo] Found FFmpeg ${version}`);
  }

  private async probeFfmpeg(
    deadlineMs?: number,
    abortSignal?: AbortSignal,
  ): Promise<FfmpegProbeResult> {
    if (this.ffmpegProbeResult) {
      return this.ffmpegProbeResult;
    }
    const probe =
      deadlineMs === undefined
        ? this.ffmpegClient.probe()
        : runWithinDeadline(
            async (signal) =>
              await this.ffmpegClient.probe({
                timeoutMs: Math.max(0, deadlineMs - this.timer.now()),
                signal,
              }),
            deadlineMs,
            this.timer,
            abortSignal,
            `Timed out checking FFmpeg availability within ${this.iosRecordingStartTimeoutMs}ms`,
          );
    const result = await probe;
    this.ffmpegProbeResult = result;
    return result;
  }

  private async assertFfmpegOutputReady(
    outputPath: string,
    args: string[],
    tracker: FfmpegDiagnosticsTracker,
  ): Promise<void> {
    const outputExists = await pathExists(outputPath);
    if (!outputExists) {
      throw new ActionableError(
        this.buildFfmpegFailureMessage("FFmpeg output file missing", args, tracker, outputPath),
      );
    }

    const sizeBytes = await getFileSize(outputPath);
    if (!sizeBytes || sizeBytes <= 0) {
      throw new ActionableError(
        this.buildFfmpegFailureMessage("FFmpeg output file is empty", args, tracker, outputPath),
      );
    }
  }

  private buildFfmpegFailureMessage(
    summary: string,
    args: string[],
    tracker: FfmpegDiagnosticsTracker,
    outputPath?: string,
  ): string {
    const details = [
      summary,
      outputPath ? `output: ${outputPath}` : undefined,
      `command: ${this.ffmpegClient.binaryPath} ${args.join(" ")}`,
      `exitCode: ${tracker.exitState.exitCode ?? "null"}`,
      `signal: ${tracker.exitState.signal ?? "null"}`,
      `stderr:\n${tracker.stderr.join("").trim() || "(empty)"}`,
    ].filter((line): line is string => Boolean(line));

    return details.join("\n");
  }

  private buildProcessFailureMessage(
    summary: string,
    command: string,
    args: string[],
    tracker: ProcessDiagnosticsTracker,
    outputPath?: string,
  ): string {
    const details = [
      summary,
      outputPath ? `output: ${outputPath}` : undefined,
      `command: ${command} ${args.join(" ")}`,
      `exitCode: ${tracker.exitState.exitCode ?? "null"}`,
      `signal: ${tracker.exitState.signal ?? "null"}`,
      `stderr:\n${tracker.stderr.join("").trim() || "(empty)"}`,
    ].filter((line): line is string => Boolean(line));

    return details.join("\n");
  }

  private logProcessWarnings(label: string, tracker: ProcessTracker): void {
    if (isFailedExitCode(tracker.exitState.exitCode)) {
      logger.warn(
        `[FfmpegVideo] ${label} exited with code ${tracker.exitState.exitCode}: ${tracker.stderr.join("")}`,
      );
    }

    if (tracker.stderr.length > 0) {
      logger.info(`[FfmpegVideo] ${label} stderr: ${tracker.stderr.join("")}`);
    }
  }
}

import { errorMessage } from "../../utils/describeUnknownError";
import { ActionableError, BootedDevice, ExecResult } from "../../models";
import { defaultTimer } from "../../utils/SystemTimer";
import type { Timer } from "../../utils/SystemTimer";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { runOutsideRequestContext } from "../../utils/AbortContext";
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
  ForceStopOptions,
  RecordingHandle,
  RecordingResult,
  VideoCaptureBackend,
  VideoCaptureConfig,
} from "./VideoRecorderService";
import { capBitrateKbps, VideoCaptureFinalizationError } from "./VideoRecorderService";
import { ANDROID_SCREENRECORD_MAX_SECONDS } from "./androidScreenrecord";
import {
  buildPidReportingScreenrecordArgs,
  isOwnRecorderCmdline,
  trackDeviceRecorderPid,
  type DeviceRecorderPid,
} from "./androidRecorderPid";
import { defaultRecordingCodecProbe, type RecordingCodecProbe } from "./recordingCodec";
import {
  probeScreenrecordDisplayFlag,
  resolveAndroidRecordingDisplay,
} from "./AndroidRecordingDisplay";

interface AndroidBackendHandle {
  kind: "android";
  process: TrackedChildProcess;
  exitState: ProcessExitState;
  exitPromise: Promise<void>;
  stderr: string[];
  device: BootedDevice;
  deviceTempPath: string;
  /**
   * The recorder's device-side pid, learned from the launch shell's first stdout line.
   * Absent or unresolved means stop/force-stop fall back to signalling by name.
   */
  devicePid?: DeviceRecorderPid;
  /**
   * Set by the first `stop`, which also records whether the host recorder process had
   * already exited abnormally at that moment. A retried stop must not mistake the exit this
   * backend's own SIGINT/SIGKILL caused for a crash, so this is recorded, not inferred.
   */
  stopRequested?: boolean;
  exitedBeforeStop?: boolean;
}

const gracefulExitTimeout = new Error("Video capture graceful exit deadline elapsed");

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
// Budget for each of the two device commands (own-process check, then kill) that
// signal the recorder by pid.
const SIGNAL_RECORDER_COMMAND_TIMEOUT_MS = 4000;
// Bound for the whole failed-start cleanup (cmdline probe, kill, temp-file removal). It runs
// detached from the request that started the recording, so it needs its own limit.
const FAILED_START_CLEANUP_TIMEOUT_MS = 10000;
// How long a fresh recorder must stay alive before `start` reports a recording (#10186).
// A recorder that cannot run (an unsupported `--size`, no encoder, a device that dropped
// off adb, a full /sdcard) exits promptly, but how promptly was not measured on a device;
// this is a deliberately short bound that costs every healthy start this much latency. A
// failure that takes longer is still reported at stop, with the recorder's exit and stderr.
const SCREENRECORD_STARTUP_SETTLE_MS = 300;
// The recorder can run for minutes, so the stderr kept for diagnostics is bounded to its
// most recent output, and an error message carries only the tail of it.
const SCREENRECORD_STDERR_MAX_CHARS = 8192;
const SCREENRECORD_STDERR_REPORT_CHARS = 1000;
// Node may report `exit` before the last stderr chunk is read; wait this long for the pipe to end.
const SCREENRECORD_STDERR_DRAIN_MS = 100;
const DEVICE_RECORDING_PATH_PATTERN = /\/sdcard\/auto-mobile-[^\s'":]+\.mp4/g;
const STDERR_TRACKER_OPTIONS = { maxStderrChars: SCREENRECORD_STDERR_MAX_CHARS };

/**
 * Describes a recorder exit that is not a normal finish, or undefined when the recorder is
 * still running or exited 0 (its own time limit, or a clean stop). Built from the tool's
 * own exit state and stderr only, never from the launch command line.
 */
function describeAbnormalExit(exitState: ProcessExitState, stderr: string[]): string | undefined {
  const code = exitState.exitCode;
  const failedWithCode = code !== undefined && code !== null && code !== 0;
  if (!failedWithCode && !exitState.signal) {
    return undefined;
  }
  const how = exitState.signal ? `signal ${exitState.signal}` : `code ${code}`;
  const at = exitState.endedAt ? ` at ${exitState.endedAt}` : "";
  // screenrecord can quote its output file; the device temp path stays diagnostic-only.
  const detail = stderr
    .join("")
    .replace(DEVICE_RECORDING_PATH_PATTERN, "<device recording file>")
    .trim()
    .slice(-SCREENRECORD_STDERR_REPORT_CHARS);
  return `exited${at} with ${how}${detail ? `: ${detail}` : ""}`;
}

/** Best-effort: lets stderr that trails the exit event arrive before it is quoted in an error. */
async function waitForStderrDrain(
  stderrStream: {
    readableEnded?: boolean;
    destroyed?: boolean;
    once(event: "end" | "close", listener: () => void): unknown;
  } | null,
  timer: Timer,
): Promise<void> {
  if (!stderrStream || stderrStream.readableEnded || stderrStream.destroyed) {
    return;
  }
  const drained = new Promise<void>((resolve) => {
    stderrStream.once("end", resolve);
    stderrStream.once("close", resolve);
  });
  const drainTimeout = new Error("screenrecord stderr drain timed out");
  try {
    await raceWithDeadline(drained, {
      timer,
      timeoutMs: SCREENRECORD_STDERR_DRAIN_MS,
      label: "screenrecord stderr drain",
      timeoutError: () => drainTimeout,
    });
  } catch (error) {
    if (error !== drainTimeout) {
      throw error;
    }
    // Whatever stderr arrived is still reported; a pipe that stays open must not hold start.
    logger.debug("[VideoCapture] screenrecord stderr did not end before the drain deadline");
  }
}

/** What a start needs from its backend beyond the adb client: time and failed-start cleanup. */
interface ScreenrecordStartHooks {
  timer: Timer;
  /**
   * Called when the start fails after the recorder was launched, with the device pid the
   * launch shell reported (possibly still unknown). Best-effort: it must not throw.
   */
  cleanupFailedStart(devicePid: DeviceRecorderPid): Promise<void>;
}

async function startScreenrecordProcess(
  adb: Pick<AdbExecutor, "spawn">,
  screenrecordArgv: string[],
  config: VideoCaptureConfig,
  device: BootedDevice,
  physicalDisplayId: string | undefined,
  { timer, cleanupFailedStart }: ScreenrecordStartHooks,
): Promise<{
  process: TrackedChildProcess;
  exitState: ProcessExitState;
  exitPromise: Promise<void>;
  stderr: string[];
  devicePid: DeviceRecorderPid;
  warning?: string;
  physicalDisplayId?: string;
}> {
  let process = await adb.spawn(buildPidReportingScreenrecordArgs(screenrecordArgv), {
    signal: config.abortSignal,
    abortSignalScope: "startup",
  });
  let devicePid = trackDeviceRecorderPid(process.stdout);
  const abortStartup = () => process.kill("SIGTERM");
  config.abortSignal?.addEventListener("abort", abortStartup, { once: true });
  try {
    if (config.abortSignal?.aborted) {
      abortStartup();
    }
    let stderr: string[] = [];
    let { exitState, exitPromise } = createExitTracker(process, stderr, STDERR_TRACKER_OPTIONS);
    let warning: string | undefined;
    let effectivePhysicalId = physicalDisplayId;
    const displayRejected = await probeScreenrecordDisplayFlag(
      { exitPromise, exitState, stderr },
      timer,
      SCREENRECORD_STARTUP_SETTLE_MS,
    );
    if (displayRejected && physicalDisplayId !== undefined && device.apiLevel === undefined) {
      warning = "Android screenrecord rejected --display-id; recording the default display.";
      logger.warn(`[VideoCapture] ${warning}`);
      process = await adb.spawn(
        buildPidReportingScreenrecordArgs(
          screenrecordArgv.filter(
            (arg, index) =>
              arg !== "--display-id" && screenrecordArgv[index - 1] !== "--display-id",
          ),
        ),
        { signal: config.abortSignal, abortSignalScope: "startup" },
      );
      devicePid = trackDeviceRecorderPid(process.stdout);
      stderr = [];
      ({ exitState, exitPromise } = createExitTracker(process, stderr, STDERR_TRACKER_OPTIONS));
      effectivePhysicalId = undefined;
      await probeScreenrecordDisplayFlag(
        { exitPromise, exitState, stderr },
        timer,
        SCREENRECORD_STARTUP_SETTLE_MS,
      );
    }
    if (describeAbnormalExit(exitState, stderr)) {
      // An aborted start killed the recorder itself; report the cancellation, not a crash.
      config.abortSignal?.throwIfAborted();
      await waitForStderrDrain(process.stderr, timer);
      // Described again after the drain so stderr that trailed the exit is included.
      throw new ActionableError(
        `Android screenrecord ${describeAbnormalExit(exitState, stderr)} within ${SCREENRECORD_STARTUP_SETTLE_MS} ms of launch, so no recording was started.`,
      );
    }
    return {
      process,
      exitState,
      exitPromise,
      stderr,
      devicePid,
      warning,
      physicalDisplayId: effectivePhysicalId,
    };
  } catch (error) {
    // The recorder runs on the device, so a dead host `adb shell` (a dropped transport, an
    // adb server restart) does not mean it stopped. No handle is returned, so nothing would
    // ever stop it or remove its temp file; do it here.
    await cleanupFailedStart(devicePid);
    throw error;
  } finally {
    config.abortSignal?.removeEventListener("abort", abortStartup);
  }
}

export function clampBitrateKbps(config: VideoCaptureConfig): number {
  return capBitrateKbps(config.targetBitrateKbps, config.maxThroughputMbps);
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

    // Whether the host recorder had already died when the FIRST stop arrived (#10186). It is
    // recorded once so a retried stop, which sees the exit this backend's own SIGINT/SIGKILL
    // caused, does not read it as a crash. It never skips the device stop or the pull: the
    // host process dying (an adb server restart, a dropped transport) does not mean the
    // device recorder did, and a recorder that wrote a complete file before dying is still
    // a recording.
    if (!backendHandle.stopRequested) {
      backendHandle.stopRequested = true;
      backendHandle.exitedBeforeStop =
        describeAbnormalExit(backendHandle.exitState, backendHandle.stderr) !== undefined;
    }

    // Stop screenrecord on the *device* with SIGINT first. If we only SIGINT the host
    // `adb shell screenrecord` process, ADB can drop the session before the device writes
    // the MP4 moov atom — leading to tiny/corrupt files that show a single frozen frame.
    // The recorder's own device pid is signalled when known; only a recording whose pid
    // could not be learned falls back to `pkill -2 screenrecord`, which signals *all*
    // recorders on the device and would interfere with concurrent recordings.
    const adbForStop = this.adbFactory.create(backendHandle.device);
    await this.requestDeviceRecorderStop(adbForStop, backendHandle);

    // Wait for the host adb process to exit now that remote screenrecord should have finalized
    try {
      await raceWithDeadline(backendHandle.exitPromise, {
        timer: this.timer,
        timeoutMs: 10000,
        label: "Video capture graceful exit",
        timeoutError: () => gracefulExitTimeout,
        onTimeout: () => {
          if (backendHandle.process.exitCode === null && !backendHandle.process.killed) {
            logger.info(`[VideoCapture] Sending SIGINT to host adb after pkill wait`);
            backendHandle.process.kill("SIGINT");
          }
        },
      });
    } catch (error) {
      if (error !== gracefulExitTimeout) {
        throw error;
      }
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

    const adb = this.adbFactory.create(backendHandle.device);
    let retainDeviceFile = false;
    try {
      try {
        // Give screenrecord extra time to finalize the file on device. Even
        // though the process has exited, file writes may still be in progress.
        logger.info(`[VideoCapture] Waiting 1 second for file to finalize on device`);
        await this.timer.sleep(1000);
        retainDeviceFile = !(await this.waitForDeviceFileToFinalize(adb, backendHandle));
        if (retainDeviceFile) {
          throw new ActionableError(
            `Device recording ${handle.recordingId} did not finish writing before the finalization deadline. ` +
              "The device copy was retained; try stopping the recording again before retrying the pull.",
          );
        }

        logger.info(
          `[VideoCapture] Pulling file from device: ${backendHandle.deviceTempPath} -> ${handle.outputPath}`,
        );
        await this.pullRecordingFileWithRetry(
          adb,
          ["pull", backendHandle.deviceTempPath, handle.outputPath],
          handle.recordingId,
        );
      } finally {
        await this.cleanupDeviceRecording(adb, backendHandle, retainDeviceFile);
      }

      const sizeBytes = await getFileSize(handle.outputPath);
      if (!sizeBytes) {
        throw new ActionableError("The pulled recording is missing or contains zero bytes.");
      }
      logger.info(`[VideoCapture] Final file size: ${sizeBytes} bytes`);
      logger.debug(`[VideoCapture] Output file at ${handle.outputPath}`);
      const codec = await this.codecProbe.codec(handle.outputPath);
      const videoDurationMs = await this.codecProbe.durationMs?.(handle.outputPath);

      this.logRecordingExit(backendHandle);
      const earlyExit = this.earlyExitDescription(backendHandle);
      return {
        recordingId: handle.recordingId,
        outputPath: handle.outputPath,
        startedAt: handle.startedAt,
        endedAt: backendHandle.exitState.endedAt ?? new Date().toISOString(),
        sizeBytes,
        codec,
        ...(videoDurationMs !== undefined && { videoDurationMs }),
        ...(earlyExit && {
          warnings: [
            `The Android recorder ${earlyExit} before the stop was requested; the recording may end sooner than requested.`,
          ],
        }),
      };
    } catch (error) {
      // This point is reached only after awaiting the tracked host exit above.
      // Artifact finalization cannot revive that process, so make the proof
      // available to the ownership layer instead of retaining a dead handle.
      throw this.finalizationError(backendHandle, retainDeviceFile, error);
    }
  }

  /** What the recorder's exit looked like, when it had died before the first stop was requested. */
  private earlyExitDescription(backendHandle: AndroidBackendHandle): string | undefined {
    return backendHandle.exitedBeforeStop
      ? describeAbnormalExit(backendHandle.exitState, backendHandle.stderr)
      : undefined;
  }

  private finalizationError(
    backendHandle: AndroidBackendHandle,
    retainDeviceFile: boolean,
    error: unknown,
  ): VideoCaptureFinalizationError {
    const earlyExit = this.earlyExitDescription(backendHandle);
    if (earlyExit && !retainDeviceFile) {
      // Nothing usable could be pulled from a recorder that had already died: say why it
      // died rather than burying it under the pull failure, which stays in the log.
      logger.warn(
        `[VideoCapture] No usable recording after the recorder exited early: ${errorMessage(error)}`,
        error,
      );
      return new VideoCaptureFinalizationError(
        `Android recorder ${earlyExit}, before the stop was requested, so the recording produced no usable video. Start a new recording.`,
        { cause: error, retainOwnership: false },
      );
    }
    return new VideoCaptureFinalizationError(
      retainDeviceFile
        ? `Android capture exited but finalization failed: ${errorMessage(error)}`
        : `Android capture exited but the recording produced no usable video (zero bytes / finalization failed). Start a new recording. ${errorMessage(error)}`,
      { cause: error, retainOwnership: retainDeviceFile },
    );
  }

  private async requestDeviceRecorderStop(
    adb: AdbExecutor,
    backendHandle: AndroidBackendHandle,
  ): Promise<void> {
    const pid = backendHandle.devicePid?.pid;
    try {
      if (pid !== undefined) {
        const outcome = await this.signalDeviceRecorder(adb, backendHandle, pid, 2);
        logger.info(`[VideoCapture] Device recorder pid ${pid} SIGINT: ${outcome}`);
        return;
      }
      const pk = await adb.executeCommand("shell pkill -2 screenrecord", 8000);
      logger.info(
        `[VideoCapture] Device pkill -2 screenrecord completed (out=${pk.stdout.trim().slice(0, 120)} err=${pk.stderr.trim().slice(0, 160)})`,
      );
    } catch (error) {
      logger.warn(
        `[VideoCapture] Device-side SIGINT of screenrecord failed; will rely on host SIGINT: ${errorMessage(error)}`,
      );
    }
  }

  /**
   * Signals exactly this recording's device-side recorder. The pid is verified to still
   * be our `screenrecord` (same unique output file) right before the kill so a reused
   * pid is never signalled; a pid that is gone or no longer ours reports "not-ours".
   */
  private async signalDeviceRecorder(
    adb: AdbExecutor,
    backendHandle: Pick<AndroidBackendHandle, "deviceTempPath">,
    pid: number,
    signal: 2 | 9,
  ): Promise<"signalled" | "not-ours"> {
    const probe = await this.readDeviceRecorderCmdline(adb, pid);
    if (!isOwnRecorderCmdline(probe.stdout, backendHandle.deviceTempPath)) {
      logger.warn(
        `[VideoCapture] Device pid ${pid} is no longer this recording's screenrecord; not signalling it`,
      );
      return "not-ours";
    }
    await adb.executeCommand(`shell kill -${signal} ${pid}`, SIGNAL_RECORDER_COMMAND_TIMEOUT_MS);
    return "signalled";
  }

  /**
   * Reads `/proc/<pid>/cmdline`. `; true` keeps the exit status 0 when the process is
   * gone (no /proc entry), so only a transport failure throws.
   */
  private readDeviceRecorderCmdline(adb: AdbExecutor, pid: number): Promise<ExecResult> {
    return adb.executeCommand(
      `shell 'cat /proc/${pid}/cmdline 2>/dev/null; true'`,
      SIGNAL_RECORDER_COMMAND_TIMEOUT_MS,
      undefined,
      true,
    );
  }

  /** Returns a failure description, or undefined when the recorder was handled or skipped. */
  private async forceKillDeviceRecorder(
    adb: AdbExecutor,
    backendHandle: AndroidBackendHandle,
    recordingId: string,
    options?: ForceStopOptions,
  ): Promise<string | undefined> {
    const pid = backendHandle.devicePid?.pid;
    if (pid === undefined && options?.deviceWide === false) {
      // Without our pid, `pkill -9 screenrecord` would signal every recorder on the
      // device, and the device may now belong to another session. The host `adb shell`
      // reap and our uniquely named temp file's removal are the only scoped cleanup.
      logger.warn(
        `[VideoCapture] Skipping device-wide screenrecord kill for ${recordingId}; its device pid is unknown so the device-side recorder may run until its own time limit`,
      );
      return undefined;
    }
    try {
      if (pid === undefined) {
        await adb.executeCommand("shell pkill -9 screenrecord", 8000);
      } else {
        await this.signalDeviceRecorder(adb, backendHandle, pid, 9);
      }
      return undefined;
    } catch (error) {
      logger.warn(`[VideoCapture] Device-side force-stop failed: ${errorMessage(error)}`);
      return `screenrecord force-stop failed: ${errorMessage(error)}`;
    }
  }

  private async cleanupDeviceRecording(
    adb: AdbExecutor,
    backendHandle: Pick<AndroidBackendHandle, "deviceTempPath">,
    retainDeviceFile: boolean,
  ): Promise<void> {
    // An empty or still-growing file may have a device-side writer
    // even after the host adb exits. Keep that copy and owner recoverable.
    if (retainDeviceFile) {
      logger.warn(
        `[VideoCapture] Retaining unstable device file ${backendHandle.deviceTempPath} for recovery`,
      );
    } else {
      logger.info(`[VideoCapture] Cleaning up temp file on device`);
      const rmArgs = ["shell", "rm", backendHandle.deviceTempPath];
      try {
        const rmProcess = await adb.spawn(rmArgs);
        await new Promise<void>((resolve) => {
          rmProcess.once("exit", (code) => {
            if (code === 0) {
              logger.info(`[VideoCapture] Temp file cleaned up`);
            } else {
              logger.warn(
                `[VideoCapture] Failed to clean up temp file: rm exited with code ${code}`,
              );
            }
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
  }

  private logRecordingExit(backendHandle: AndroidBackendHandle): void {
    if (backendHandle.exitState.exitCode && backendHandle.exitState.exitCode !== 0) {
      logger.warn(
        `[VideoCapture] Recording exited with code ${backendHandle.exitState.exitCode}: ${backendHandle.stderr.join("")}`,
      );
    }
    if (backendHandle.stderr.length > 0) {
      logger.info(`[VideoCapture] Stderr output: ${backendHandle.stderr.join("")}`);
    }
  }

  /**
   * Reads the on-device file's size via `stat`. Returns null when the result
   * cannot be observed, which is distinct from a confirmed zero-byte file.
   */
  private async readDeviceFileSizeBytes(
    adb: AdbExecutor,
    deviceTempPath: string,
  ): Promise<number | null> {
    try {
      const result = await adb.executeCommand(
        `shell stat -c %s ${deviceTempPath}`,
        5000,
        undefined,
        true,
      );
      const parsed = Number.parseInt(result.stdout.trim(), 10);
      return Number.isFinite(parsed) ? parsed : null;
    } catch (error) {
      // A missing/unreadable file here just means "not finalized yet"; the
      // poll loop and the pull retry below absorb it.
      logger.debug(
        `[VideoCapture] Failed to stat device file ${deviceTempPath}: ${errorMessage(error)}`,
      );
      return null;
    }
  }

  /**
   * Waits for the on-device recording file to stop growing before the caller
   * pulls it (issue #6291: a stop that lands right after start races
   * `screenrecord`'s own flush, so pulling too early sees a missing/empty
   * file and `adb pull` exits 1). Best-effort: if the size never visibly
   * stabilizes within the attempt budget. A file observed growing but never
   * stable is retained on the device because a successful `adb pull` can still
   * produce a truncated MP4. If the file cannot be observed at all, preserve
   * the existing bounded pull retry as the only recovery path.
   */
  private async waitForDeviceFileToFinalize(
    adb: AdbExecutor,
    backendHandle: AndroidBackendHandle,
  ): Promise<boolean> {
    const deviceTempPath = backendHandle.deviceTempPath;
    let lastSize = -1;
    let observedFile = false;
    let observedNonEmptyFile = false;
    for (let attempt = 0; attempt < DEVICE_FILE_FINALIZE_POLL_ATTEMPTS; attempt++) {
      const size = await this.readDeviceFileSizeBytes(adb, deviceTempPath);
      observedFile ||= size !== null;
      observedNonEmptyFile ||= size !== null && size > 0;
      if (size !== null && size > 0 && size === lastSize) {
        logger.info(`[VideoCapture] Device file finalized at ${size} bytes`);
        return true;
      }
      lastSize = size ?? -1;
      await this.timer.sleep(DEVICE_FILE_FINALIZE_POLL_INTERVAL_MS);
    }
    if (observedNonEmptyFile) {
      logger.warn(
        `[VideoCapture] Device file ${deviceTempPath} did not visibly stabilize after ` +
          `${DEVICE_FILE_FINALIZE_POLL_ATTEMPTS} checks`,
      );
      return false;
    }
    if (observedFile) {
      if (!(await this.confirmDeviceScreenrecordExited(adb, backendHandle))) {
        return false;
      }
      throw new ActionableError(
        `Device recording remained empty (zero bytes) after ${DEVICE_FILE_FINALIZE_POLL_ATTEMPTS} checks with capture exit confirmed.`,
      );
    }
    logger.warn(
      `[VideoCapture] Could not observe device file ${deviceTempPath}; attempting bounded pull recovery`,
    );
    return true;
  }

  /**
   * Confirms THIS recording's recorder has exited. With a known device pid the answer
   * comes from that pid alone (#10019): an unrelated `screenrecord` on the device (a
   * released plan's recorder, Android Studio, a second daemon) must not keep this
   * recording retained. Only a recording whose pid was never learned falls back to the
   * device-wide `pidof`, which cannot tell recorders apart.
   */
  private async confirmDeviceScreenrecordExited(
    adb: AdbExecutor,
    backendHandle: AndroidBackendHandle,
  ): Promise<boolean> {
    const pid = backendHandle.devicePid?.pid;
    if (pid !== undefined) {
      return this.confirmDeviceRecorderPidExited(adb, backendHandle, pid);
    }
    try {
      // pidof exits 1 for no matches. Preserve its status explicitly rather
      // than masking command/transport failures with `|| true`.
      const result = await adb.executeCommand(
        'shell \'pidof screenrecord; printf "pidof-status:%s\\n" "$?"\'',
        5000,
        undefined,
        true,
      );
      return (
        !result.error && result.stderr.trim() === "" && result.stdout.trim() === "pidof-status:1"
      );
    } catch (error) {
      logger.warn("[VideoCapture] Could not confirm device screenrecord exit", error);
      return false;
    }
  }

  private async confirmDeviceRecorderPidExited(
    adb: AdbExecutor,
    backendHandle: AndroidBackendHandle,
    pid: number,
  ): Promise<boolean> {
    try {
      const result = await this.readDeviceRecorderCmdline(adb, pid);
      if (result.error) {
        return false;
      }
      // Gone, or reused by something that is not this recording's screenrecord.
      return !isOwnRecorderCmdline(result.stdout, backendHandle.deviceTempPath);
    } catch (error) {
      logger.warn(`[VideoCapture] Could not confirm device recorder pid ${pid} exit`, error);
      return false;
    }
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

  async forceStop(handle: RecordingHandle, options?: ForceStopOptions): Promise<void> {
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
    const killFailure = await this.forceKillDeviceRecorder(
      adb,
      backendHandle,
      handle.recordingId,
      options,
    );
    if (killFailure) {
      failures.push(killFailure);
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
    const display =
      config.physicalDisplayId === undefined
        ? await resolveAndroidRecordingDisplay(
            device,
            adb,
            config.display,
            config.abortSignal,
            this.timer,
          )
        : undefined;
    const physicalDisplayId = config.physicalDisplayId ?? display?.physicalId;
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
      "screenrecord",
      "--bit-rate",
      String(bitrateBps),
      "--time-limit",
      String(timeLimitSeconds),
    ];

    if (physicalDisplayId !== undefined) {
      args.push("--display-id", physicalDisplayId);
    }

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
    const {
      process,
      exitState,
      exitPromise,
      stderr,
      devicePid,
      warning,
      physicalDisplayId: effectivePhysicalId,
    } = await startScreenrecordProcess(adb, args, config, device, physicalDisplayId, {
      timer: this.timer,
      cleanupFailedStart: (pid) => this.cleanupFailedAndroidStartDetached(adb, deviceTempPath, pid),
    });

    const backendHandle: AndroidBackendHandle = {
      kind: "android",
      process,
      exitState,
      exitPromise,
      stderr,
      device,
      deviceTempPath,
      devicePid,
    };
    return {
      recordingId: config.recordingId,
      outputPath: config.outputPath,
      startedAt: config.startedAt,
      warning,
      physicalDisplayId: effectivePhysicalId,
      backendHandle,
    };
  }

  /**
   * Runs {@link cleanupFailedAndroidStart} detached from the request that started the
   * recording. A start fails most often because that request was cancelled, and `AdbClient`
   * defaults every call to the ambient request signal, so inside the request context each
   * cleanup command would throw at once and the recorder and temp file would be left behind.
   * Outside it the cleanup runs under its own bounded timeout instead.
   */
  private async cleanupFailedAndroidStartDetached(
    adb: AdbExecutor,
    deviceTempPath: string,
    devicePid: DeviceRecorderPid,
  ): Promise<void> {
    try {
      await runOutsideRequestContext(() =>
        raceWithDeadline(this.cleanupFailedAndroidStart(adb, deviceTempPath, devicePid), {
          timer: this.timer,
          timeoutMs: FAILED_START_CLEANUP_TIMEOUT_MS,
          label: "Failed video start cleanup",
        }),
      );
    } catch (error) {
      logger.warn(
        `[VideoCapture] Failed-start cleanup did not finish: ${errorMessage(error)}`,
        error,
      );
    }
  }

  /**
   * A start that failed after launching the recorder: stop it by its own device pid and
   * remove its temp file, the same cleanup a discard does. An unknown pid is not answered
   * with a device-wide `pkill`, which would signal other sessions' recorders; the temp
   * file is still removed. Best-effort and logged: the start error is what the caller sees.
   */
  private async cleanupFailedAndroidStart(
    adb: AdbExecutor,
    deviceTempPath: string,
    devicePid: DeviceRecorderPid,
  ): Promise<void> {
    const pid = devicePid.pid;
    try {
      if (pid === undefined) {
        logger.warn(
          "[VideoCapture] Failed start left no known device pid; not signalling screenrecord by name",
        );
      } else {
        const outcome = await this.signalDeviceRecorder(adb, { deviceTempPath }, pid, 9);
        logger.info(`[VideoCapture] Failed-start device recorder pid ${pid} SIGKILL: ${outcome}`);
      }
    } catch (error) {
      logger.warn(
        `[VideoCapture] Could not stop the device recorder after a failed start: ${errorMessage(error)}`,
        error,
      );
    }
    await this.cleanupDeviceRecording(adb, { deviceTempPath }, false);
  }

  private resolveAndroidTimeLimit(maxDurationSeconds?: number): number {
    if (maxDurationSeconds && maxDurationSeconds > 0) {
      return Math.min(maxDurationSeconds, ANDROID_SCREENRECORD_MAX_SECONDS);
    }

    return ANDROID_SCREENRECORD_MAX_SECONDS;
  }
}

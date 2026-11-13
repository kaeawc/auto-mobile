import { ActionableError, type BootedDevice } from "../../models";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import {
  createExitTracker,
  type ProcessExitState,
  type TrackedChildProcess,
} from "../../utils/ChildProcessTracker";
import type { VideoCaptureConfig } from "./VideoRecorderService";
import {
  buildPidReportingScreenrecordArgs,
  trackDeviceRecorderPid,
  type DeviceRecorderPid,
} from "./androidRecorderPid";
import { probeScreenrecordDisplayFlag } from "./AndroidRecordingDisplay";
import { logger } from "../../utils/logger";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import type { Timer } from "../../utils/SystemTimer";

/**
 * Android `adb shell screenrecord` enforces a maximum `--time-limit` of 180 seconds.
 * @see https://developer.android.com/studio/command-line/adb#screenrecord
 */
export const ANDROID_SCREENRECORD_MAX_SECONDS = 180;

/**
 * For long plan runs, start a new segment after this many milliseconds so the next
 * `screenrecord` begins before the device hits {@link ANDROID_SCREENRECORD_MAX_SECONDS}.
 */
export const ANDROID_PLAN_VIDEO_SEGMENT_ROTATE_MS = 170_000;

/** Device-command and exit-wait budgets for the screenrecord capture backend. */
export const SCREENRECORD_MS = {
  // Waiting for the host-side recorder process to exit after a graceful stop request.
  gracefulExit: 10000,
  // `pkill` of the on-device screenrecord process (SIGINT or SIGKILL).
  pkill: 8000,
  // Removing the on-device temp recording file.
  tempFileRemove: 8000,
  // Quick read-only device probes (`stat` of the recording, `pidof screenrecord`).
  probe: 5000,
  // Exec options for `pkill`.
  pkillOpts: { timeoutMs: 8000 },
} as const;

// Node may report `exit` before the last stderr chunk is read; wait this long for the pipe to end.
const SCREENRECORD_STDERR_DRAIN_MS = 100;

/** Best-effort: lets stderr that trails the exit event arrive before it is quoted in an error. */
export async function waitForStderrDrain(
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

// How long a fresh recorder must stay alive before `start` reports a recording (#10186).
// Every healthy start pays this much latency. The failure reported in #17951 exited
// at 0.7 s, beyond the former 300 ms window, when the host adb session was lost.
// The device recorder is now detached with setsid where available (#17951).
const SCREENRECORD_STARTUP_SETTLE_MS = 1000;
// The recorder can run for minutes, so the stderr kept for diagnostics is bounded to its
// most recent output, and an error message carries only the tail of it.
const SCREENRECORD_STDERR_MAX_CHARS = 8192;
const SCREENRECORD_STDERR_REPORT_CHARS = 1000;
const DEVICE_RECORDING_PATH_PATTERN = /\/sdcard\/auto-mobile-[^\s'":]+\.mp4/g;
const STDERR_TRACKER_OPTIONS = { maxStderrChars: SCREENRECORD_STDERR_MAX_CHARS };

export function recordingStderrTail(stderr: string[]): string {
  return stderr
    .join("")
    .replace(DEVICE_RECORDING_PATH_PATTERN, "<device recording file>")
    .trim()
    .slice(-SCREENRECORD_STDERR_REPORT_CHARS);
}

/**
 * Describes a recorder exit that is not a normal finish, or undefined when the recorder is
 * still running or exited 0 (its own time limit, or a clean stop). Built from the tool's
 * own exit state and stderr only, never from the launch command line.
 */
export function describeAbnormalExit(
  exitState: ProcessExitState,
  stderr: string[],
): string | undefined {
  const code = exitState.exitCode;
  const failedWithCode = code !== undefined && code !== null && code !== 0;
  if (!failedWithCode && !exitState.signal) {
    return undefined;
  }
  const how = exitState.signal ? `signal ${exitState.signal}` : `code ${code}`;
  const at = exitState.endedAt ? ` at ${exitState.endedAt}` : "";
  // screenrecord can quote its output file; the device temp path stays diagnostic-only.
  const detail = recordingStderrTail(stderr);
  return `exited${at} with ${how}${detail ? `: ${detail}` : ""}`;
}

/** What a start needs beyond adb and argv: its target, time, output paths and failed-start cleanup. */
export interface ScreenrecordStartContext {
  device: BootedDevice;
  physicalDisplayId: string | undefined;
  timer: Timer;
  /**
   * Device output file for the first launch and for the one retry. They must differ: a
   * failed start's cleanup is time-bounded, so an abandoned `rm` of the first path can still
   * land after the retry started and must not unlink the retry's recording.
   */
  deviceTempPaths: readonly [first: string, retry: string];
  /**
   * Called when the start fails after the recorder was launched, with the device pid the
   * launch shell reported (possibly still unknown) and that attempt's output path.
   * Best-effort: it must not throw.
   */
  cleanupFailedStart(devicePid: DeviceRecorderPid, deviceTempPath: string): Promise<void>;
}

interface ScreenrecordProcess {
  process: TrackedChildProcess;
  exitState: ProcessExitState;
  exitPromise: Promise<void>;
  stderr: string[];
  devicePid: DeviceRecorderPid;
  warning?: string;
  physicalDisplayId?: string;
  launchedAtMs: number;
  /** The device output file this recorder writes. */
  deviceTempPath: string;
}

interface FailedScreenrecordStart {
  failure: ActionableError;
  stderr: string[];
  devicePid: DeviceRecorderPid;
  launchedAtMs: number;
}

export async function startScreenrecordProcess(
  adb: Pick<AdbExecutor, "spawn">,
  screenrecordArgv: string[],
  config: VideoCaptureConfig,
  context: ScreenrecordStartContext,
): Promise<ScreenrecordProcess> {
  config.abortSignal?.throwIfAborted();
  const [firstPath, retryPath] = context.deviceTempPaths;
  const first = await startScreenrecordAttempt(
    adb,
    { argv: screenrecordArgv, deviceTempPath: firstPath },
    config,
    context,
  );
  if (!("failure" in first)) {
    return first;
  }
  if (!config.abortSignal?.aborted) {
    logger.warn(
      `[VideoCapture] ${first.failure.message} ${recordingStderrTail(first.stderr) ? "" : "stderr was empty; "}retrying once after ${context.timer.now() - first.launchedAtMs} ms since launch.`,
    );
  }
  await context.cleanupFailedStart(first.devicePid, firstPath);
  config.abortSignal?.throwIfAborted();
  const retry = await startScreenrecordAttempt(
    adb,
    { argv: screenrecordArgv, deviceTempPath: retryPath },
    config,
    context,
  );
  if ("failure" in retry) {
    await context.cleanupFailedStart(retry.devicePid, retryPath);
    config.abortSignal?.throwIfAborted();
    throw retry.failure;
  }
  return retry;
}

async function startScreenrecordAttempt(
  adb: Pick<AdbExecutor, "spawn">,
  { argv, deviceTempPath }: { argv: string[]; deviceTempPath: string },
  config: VideoCaptureConfig,
  { device, physicalDisplayId, timer, cleanupFailedStart }: ScreenrecordStartContext,
): Promise<ScreenrecordProcess | FailedScreenrecordStart> {
  const screenrecordArgv = [...argv, deviceTempPath];
  let launchedAtMs = timer.now();
  let process = await adb.spawn(buildPidReportingScreenrecordArgs(screenrecordArgv), {
    signal: config.abortSignal,
    abortSignalScope: "startup",
  });
  let devicePid = trackDeviceRecorderPid(process.stdout);
  const abortStartup = () => process.kill("SIGTERM");
  config.abortSignal?.addEventListener("abort", abortStartup, { once: true });
  let stderr: string[] = [];
  try {
    if (config.abortSignal?.aborted) {
      abortStartup();
    }
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
      launchedAtMs = timer.now();
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
      return {
        failure: new ActionableError(
          `Android screenrecord ${describeAbnormalExit(exitState, stderr)} within ${SCREENRECORD_STARTUP_SETTLE_MS} ms of launch, so no recording was started.`,
        ),
        stderr,
        devicePid,
        launchedAtMs,
      };
    }
    return {
      process,
      exitState,
      exitPromise,
      stderr,
      devicePid,
      warning,
      physicalDisplayId: effectivePhysicalId,
      launchedAtMs,
      deviceTempPath,
    };
  } catch (error) {
    // The recorder runs on the device, so a dead host `adb shell` (a dropped transport, an
    // adb server restart) does not mean it stopped. No handle is returned, so nothing would
    // ever stop it or remove its temp file; do it here.
    await cleanupFailedStart(devicePid, deviceTempPath);
    throw error;
  } finally {
    config.abortSignal?.removeEventListener("abort", abortStartup);
  }
}

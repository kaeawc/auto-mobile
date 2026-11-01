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

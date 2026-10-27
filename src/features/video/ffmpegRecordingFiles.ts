import { promises as fsPromises } from "node:fs";
import { toActionableError } from "../../models/ActionableError";
import { exponentialBackoff, normalizeBackoff, type BackoffInput } from "../../utils/Backoff";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { logger } from "../../utils/logger";
// Even after the `simctl recordVideo` process has fully exited, the raw `.mov`
// can lag behind on a loaded CI runner: the moov-atom flush and the filesystem
// write are not guaranteed to be visible the instant the process exits, so a
// single `stat` immediately after `waitForExit` can momentarily see the file
// missing or 0 bytes and hard-fail. We poll (bounded, with backoff) for the file
// to exist, be non-empty, and have a stable size before handing it to ffmpeg.
export const IOS_RECORDING_FILE_READY_TIMEOUT_MS = 15000;

const IOS_RECORDING_FILE_READY_INITIAL_BACKOFF_MS = 100;

const IOS_RECORDING_FILE_READY_MAX_BACKOFF_MS = 1000;

/**
 * Minimal filesystem surface for probing a recording file's size. Returns the
 * size in bytes, or `null` when the file does not yet exist. Narrowed so the
 * readiness poll can be unit-tested with a fake instead of a real `stat`.
 */
export interface RecordingFileProbe {
  size(filePath: string): Promise<number | null>;
}

export const defaultRecordingFileProbe: RecordingFileProbe = {
  async size(filePath: string): Promise<number | null> {
    try {
      const stats = await fsPromises.stat(filePath);
      return stats.size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw toActionableError(error, `Failed to stat recording ${filePath}`);
      }
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

/**
 * Minimal filesystem surface for deleting a raw capture file. Narrowed to the one
 * operation the iOS start-retry needs (rather than reusing the repo-wide
 * `FileSystem`) so the retry path can be unit-tested with a fake.
 */
export interface RecordingFileRemover {
  remove(filePath: string): Promise<void>;
}

export const defaultRecordingFileRemover: RecordingFileRemover = {
  async remove(filePath: string): Promise<void> {
    await fsPromises.rm(filePath, { force: true });
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
      const observed = describeRecordingFileReadiness(everExisted, previousSize);
      throw new Error(
        `iOS recording file not ready at ${filePath} after ${timeoutMs}ms (${attempt} probes): ${observed}`,
      );
    }

    await timer.sleep(backoff.delayForAttempt(attempt));
  }
}

function describeRecordingFileReadiness(everExisted: boolean, previousSize: number | null): string {
  return !everExisted
    ? "never appeared"
    : previousSize === null
      ? "disappeared after appearing"
      : previousSize === 0
        ? "stayed empty (0 bytes)"
        : `stopped at ${previousSize} bytes but never stabilized`;
}

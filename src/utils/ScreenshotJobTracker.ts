import { errorMessage } from "./describeUnknownError";
import { logger } from "./logger";
import { ScreenshotResult } from "../models/ScreenshotResult";
import { Timer, defaultTimer } from "./SystemTimer";
import { defaultIdGenerator, type IdGenerator, createTimestampedId } from "./IdGenerator";
import { OPERATION_CANCELLED_MESSAGE } from "./constants";

export interface ScreenshotJobHandle {
  jobId: string;
  promise: Promise<ScreenshotResult>;
  signal: AbortSignal;
}

interface ScreenshotJobCompletion {
  deviceId: string;
  jobId: string;
  result: ScreenshotResult;
  aborted: boolean;
  isLatest: boolean;
}

export interface ScreenshotJobOptions {
  parentSignal?: AbortSignal;
  onComplete?: (completion: ScreenshotJobCompletion) => void | Promise<void>;
  /**
   * If a job is already in flight for this device and has not been aborted,
   * return its handle instead of cancelling and starting a new one.
   *
   * Used by fire-and-forget callers during rapid polling (observe waitFor)
   * to avoid a self-inflicted cancel loop where each ~100ms poll aborts the
   * previous in-flight screencap before it can complete.
   */
  coalesceWithPending?: boolean;
  /**
   * Register a distinct capture immediately, but do not start its runner until
   * the most recently registered capture for this device has settled.
   *
   * The queued job remains tracked, so device/session cleanup can cancel it
   * before it reaches the runner.
   */
  queueAfterPending?: boolean;
}

interface ScreenshotJobEntry {
  jobId: string;
  promise: Promise<ScreenshotResult>;
  abortController: AbortController;
  startedAt: number;
  allowsCoalescing: boolean;
  cleanupParentSignal?: () => void;
}

export class ScreenshotJobTracker {
  private static jobs: Map<string, ScreenshotJobEntry[]> = new Map();
  private static latestJobIds: Map<string, string> = new Map();
  private static timer: Timer = defaultTimer;
  private static idGenerator: IdGenerator = defaultIdGenerator;

  static setTimer(timer: Timer): void {
    ScreenshotJobTracker.timer = timer;
  }

  static resetTimer(): void {
    ScreenshotJobTracker.timer = defaultTimer;
  }

  static setIdGenerator(idGenerator: IdGenerator): void {
    ScreenshotJobTracker.idGenerator = idGenerator;
  }

  static resetIdGenerator(): void {
    ScreenshotJobTracker.idGenerator = defaultIdGenerator;
  }

  private static shouldQueueAfterPending(
    options: ScreenshotJobOptions,
    existingJobs: ScreenshotJobEntry[],
  ): boolean {
    if (options.queueAfterPending) {
      return true;
    }
    return (
      options.coalesceWithPending === true &&
      existingJobs.some((entry) => !entry.abortController.signal.aborted)
    );
  }

  static startJob(
    deviceId: string,
    runner: (signal: AbortSignal) => Promise<ScreenshotResult>,
    options: ScreenshotJobOptions = {},
  ): ScreenshotJobHandle {
    const existingJobs = ScreenshotJobTracker.jobs.get(deviceId) ?? [];
    if (options.coalesceWithPending) {
      const existing = [...existingJobs]
        .reverse()
        .find((entry) => entry.allowsCoalescing && !entry.abortController.signal.aborted);
      if (existing && !existing.abortController.signal.aborted) {
        return {
          jobId: existing.jobId,
          promise: existing.promise,
          signal: existing.abortController.signal,
        };
      }
    }

    const queueAfterPending = ScreenshotJobTracker.shouldQueueAfterPending(options, existingJobs);
    if (!queueAfterPending) {
      ScreenshotJobTracker.cancelJob(deviceId);
    }
    const previous = queueAfterPending ? existingJobs.at(-1) : undefined;

    const abortController = new AbortController();
    let cleanupParentSignal: (() => void) | undefined;

    if (options.parentSignal) {
      const onAbort = () => {
        if (!abortController.signal.aborted) {
          abortController.abort();
        }
      };
      if (options.parentSignal.aborted) {
        onAbort();
      } else {
        options.parentSignal.addEventListener("abort", onAbort, { once: true });
        cleanupParentSignal = () => options.parentSignal?.removeEventListener("abort", onAbort);
      }
    }

    const jobId = createTimestampedId(
      "screenshot",
      ScreenshotJobTracker.timer,
      ScreenshotJobTracker.idGenerator,
    );
    const promise = Promise.resolve()
      .then(async () => {
        if (previous) {
          await previous.promise;
          if (abortController.signal.aborted) {
            return { success: false, error: OPERATION_CANCELLED_MESSAGE };
          }
        }
        if (queueAfterPending) {
          ScreenshotJobTracker.latestJobIds.set(deviceId, jobId);
        }
        return runner(abortController.signal);
      })
      .catch((error) => {
        const message = errorMessage(error);
        return { success: false, error: message };
      })
      .then(async (result) => {
        const isLatest = ScreenshotJobTracker.isLatest(deviceId, jobId);
        const completion: ScreenshotJobCompletion = {
          deviceId,
          jobId,
          result,
          aborted: abortController.signal.aborted,
          isLatest,
        };
        if (options.onComplete) {
          try {
            await options.onComplete(completion);
          } catch (err) {
            logger.warn(`[ScreenshotJobTracker] Completion handler failed: ${err}`);
          }
        }
        return result;
      });

    const entry: ScreenshotJobEntry = {
      jobId,
      promise,
      abortController,
      startedAt: ScreenshotJobTracker.timer.now(),
      allowsCoalescing: !options.queueAfterPending,
      cleanupParentSignal,
    };

    existingJobs.push(entry);
    ScreenshotJobTracker.jobs.set(deviceId, existingJobs);
    if (!queueAfterPending) {
      ScreenshotJobTracker.latestJobIds.set(deviceId, jobId);
    }

    promise.finally(() => {
      const current = ScreenshotJobTracker.jobs.get(deviceId);
      if (!current) {
        cleanupParentSignal?.();
        return;
      }
      const entryIndex = current.findIndex((candidate) => candidate.jobId === jobId);
      if (entryIndex !== -1) {
        current.splice(entryIndex, 1);
      }
      if (current.length === 0) {
        ScreenshotJobTracker.jobs.delete(deviceId);
        ScreenshotJobTracker.latestJobIds.delete(deviceId);
      }
      cleanupParentSignal?.();
    });

    return {
      jobId,
      promise,
      signal: abortController.signal,
    };
  }

  static cancelJob(deviceId: string): void {
    const entries = ScreenshotJobTracker.jobs.get(deviceId);
    if (!entries) {
      return;
    }
    for (const entry of entries) {
      if (!entry.abortController.signal.aborted) {
        entry.abortController.abort();
      }
    }
  }

  static isPending(deviceId: string): boolean {
    return ScreenshotJobTracker.jobs.has(deviceId);
  }

  static isLatest(deviceId: string, jobId: string): boolean {
    return ScreenshotJobTracker.latestJobIds.get(deviceId) === jobId;
  }

  static getMostRecentPendingDeviceId(): string | undefined {
    let latestDeviceId: string | undefined;
    let latestStart = 0;

    for (const [deviceId, entries] of ScreenshotJobTracker.jobs.entries()) {
      for (const entry of entries) {
        if (entry.startedAt >= latestStart) {
          latestStart = entry.startedAt;
          latestDeviceId = deviceId;
        }
      }
    }

    return latestDeviceId;
  }

  static async waitForCompletion(
    deviceId: string,
    timeoutMs: number,
  ): Promise<ScreenshotResult | null> {
    const entry = ScreenshotJobTracker.jobs.get(deviceId)?.at(-1);
    if (!entry) {
      return null;
    }

    let timeoutId: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<null>((resolve) => {
      timeoutId = ScreenshotJobTracker.timer.setTimeout(() => resolve(null), timeoutMs);
    });

    try {
      return await Promise.race([entry.promise, timeoutPromise]);
    } finally {
      if (timeoutId) {
        ScreenshotJobTracker.timer.clearTimeout(timeoutId);
      }
    }
  }

  static clear(): void {
    for (const entries of ScreenshotJobTracker.jobs.values()) {
      for (const entry of entries) {
        if (!entry.abortController.signal.aborted) {
          entry.abortController.abort();
        }
        entry.cleanupParentSignal?.();
      }
    }
    ScreenshotJobTracker.jobs.clear();
    ScreenshotJobTracker.latestJobIds.clear();
  }
}

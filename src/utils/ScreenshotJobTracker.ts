import { errorMessage } from "./describeUnknownError";
import { logger } from "./logger";
import { ScreenshotResult } from "../models/ScreenshotResult";
import { Timer, defaultTimer } from "./SystemTimer";
import { raceWithDeadline } from "./raceWithDeadline";
import { defaultIdGenerator, type IdGenerator, createTimestampedId } from "./IdGenerator";
import { OPERATION_CANCELLED_MESSAGE } from "./constants";
import { ActionableError } from "../models/ActionableError";

const MAX_TRACKED_JOBS_PER_DEVICE = 4;
type QueueKind = "fresh" | "observation" | "coalesced";

interface SupersededResult {
  promise: Promise<ScreenshotResult>;
  resolve: (result: ScreenshotResult) => void;
}

export interface ScreenshotJobHandle {
  jobId: string;
  promise: Promise<ScreenshotResult>;
  signal: AbortSignal;
}

export interface ScreenshotJobCompletion {
  deviceId: string;
  jobId: string;
  result: ScreenshotResult;
  aborted: boolean;
  isLatest: boolean;
}

export interface ScreenshotJobCompletionSnapshot {
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
   * A newer capture of the same queue kind replaces one that has not started.
   * Superseded handles receive the newest capture's result.
   */
  queueAfterPending?: boolean;
  /**
   * When a capture runner is already executing for this device, register a
   * distinct job behind it instead of coalescing with its stale result.
   *
   * Unlike `queueAfterPending`, requests that arrive before the runner starts
   * may still coalesce. This is used by observation-scoped captures, whose
   * pixels must correspond to the observation that requested them.
   */
  queueAfterPendingIfRunning?: boolean;
}

interface ScreenshotJobEntry {
  jobId: string;
  promise: Promise<ScreenshotResult>;
  abortController: AbortController;
  startedAt: number;
  allowsCoalescing: boolean;
  queueKind?: QueueKind;
  started: boolean;
  previous?: ScreenshotJobEntry;
  supersededResult?: Promise<ScreenshotResult>;
  supersededWaiters?: SupersededResult;
  cleanupParentSignal?: () => void;
}

export class ScreenshotJobTracker {
  private static jobs: Map<string, ScreenshotJobEntry[]> = new Map();
  private static latestJobIds: Map<string, string> = new Map();
  private static completions: Map<string, ScreenshotJobCompletionSnapshot> = new Map();
  private static completionReaderCounts: Map<string, number> = new Map();
  private static completionDeviceIds: Map<string, string> = new Map();
  private static runningJobIds: Set<string> = new Set();
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
    if (
      options.queueAfterPendingIfRunning &&
      existingJobs.some(
        (entry) =>
          ScreenshotJobTracker.runningJobIds.has(entry.jobId) &&
          !entry.abortController.signal.aborted,
      )
    ) {
      return true;
    }
    return (
      options.coalesceWithPending === true &&
      existingJobs.some((entry) => !entry.abortController.signal.aborted)
    );
  }

  private static shouldQueueAfterRunning(
    options: ScreenshotJobOptions,
    existingJobs: ScreenshotJobEntry[],
  ): boolean {
    return (
      options.queueAfterPendingIfRunning === true &&
      existingJobs.some(
        (entry) =>
          ScreenshotJobTracker.runningJobIds.has(entry.jobId) &&
          !entry.abortController.signal.aborted,
      )
    );
  }

  private static findCoalescedJob(
    options: ScreenshotJobOptions,
    existingJobs: ScreenshotJobEntry[],
    queueAfterPendingIfRunning: boolean,
  ): ScreenshotJobEntry | undefined {
    if (!options.coalesceWithPending || queueAfterPendingIfRunning) {
      return undefined;
    }
    return [...existingJobs]
      .reverse()
      .find((entry) => entry.allowsCoalescing && !entry.abortController.signal.aborted);
  }

  private static queueKindFor(options: ScreenshotJobOptions): QueueKind {
    if (options.queueAfterPending) {
      return "fresh";
    }
    return options.queueAfterPendingIfRunning ? "observation" : "coalesced";
  }

  private static supersededWaitersFor(entry: ScreenshotJobEntry): SupersededResult {
    if (entry.supersededWaiters) {
      return entry.supersededWaiters;
    }
    let resolve: (result: ScreenshotResult) => void = () => {};
    const promise = new Promise<ScreenshotResult>((settle) => {
      resolve = settle;
    });
    return { promise, resolve };
  }

  private static replaceableTail(
    jobs: ScreenshotJobEntry[],
    queueKind: QueueKind | undefined,
  ): ScreenshotJobEntry | undefined {
    const tail = jobs.at(-1);
    return tail && !tail.started && tail.queueKind === queueKind ? tail : undefined;
  }

  private static assertQueueDepth(deviceId: string, depth: number): void {
    if (depth >= MAX_TRACKED_JOBS_PER_DEVICE) {
      throw new ActionableError(
        `Screenshot queue for device ${deviceId} is full (${MAX_TRACKED_JOBS_PER_DEVICE} jobs). Wait for a capture to finish or cancel pending captures and retry.`,
      );
    }
  }

  private static prepareQueue(
    deviceId: string,
    options: ScreenshotJobOptions,
    queueAfterPending: boolean,
    currentJobs: ScreenshotJobEntry[],
  ): {
    existingJobs: ScreenshotJobEntry[];
    previous?: ScreenshotJobEntry;
    queueKind?: QueueKind;
    supersededWaiters?: SupersededResult;
  } {
    let existingJobs = currentJobs;
    if (!queueAfterPending) {
      ScreenshotJobTracker.cancelJob(deviceId);
      existingJobs = [];
    }
    const queueKind = queueAfterPending ? ScreenshotJobTracker.queueKindFor(options) : undefined;
    const tail = existingJobs.at(-1);
    const superseded = ScreenshotJobTracker.replaceableTail(existingJobs, queueKind);
    const previous = queueAfterPending ? (superseded?.previous ?? tail) : undefined;
    ScreenshotJobTracker.assertQueueDepth(deviceId, existingJobs.length - (superseded ? 1 : 0));

    const supersededWaiters = superseded
      ? ScreenshotJobTracker.supersededWaitersFor(superseded)
      : undefined;
    if (superseded) {
      superseded.supersededResult = supersededWaiters?.promise;
      existingJobs.pop();
      superseded.cleanupParentSignal?.();
    }
    return { existingJobs, previous, queueKind, supersededWaiters };
  }

  static startJob(
    deviceId: string,
    runner: (signal: AbortSignal) => Promise<ScreenshotResult>,
    options: ScreenshotJobOptions = {},
  ): ScreenshotJobHandle {
    const existingJobs = ScreenshotJobTracker.jobs.get(deviceId) ?? [];
    const queueAfterPendingIfRunning = ScreenshotJobTracker.shouldQueueAfterRunning(
      options,
      existingJobs,
    );
    const existing = ScreenshotJobTracker.findCoalescedJob(
      options,
      existingJobs,
      queueAfterPendingIfRunning,
    );
    if (existing) {
      return {
        jobId: existing.jobId,
        promise: existing.promise,
        signal: existing.abortController.signal,
      };
    }

    const queueAfterPending = ScreenshotJobTracker.shouldQueueAfterPending(options, existingJobs);
    const {
      existingJobs: jobs,
      previous,
      queueKind,
      supersededWaiters,
    } = ScreenshotJobTracker.prepareQueue(deviceId, options, queueAfterPending, existingJobs);

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
        if (entry.supersededResult) {
          return entry.supersededResult;
        }
        if (previous) {
          await previous.promise;
          if (entry.supersededResult) {
            return entry.supersededResult;
          }
          if (abortController.signal.aborted) {
            return { success: false, error: OPERATION_CANCELLED_MESSAGE };
          }
        }
        if (queueAfterPending) {
          ScreenshotJobTracker.latestJobIds.set(deviceId, jobId);
        }
        entry.started = true;
        ScreenshotJobTracker.runningJobIds.add(jobId);
        return runner(abortController.signal);
      })
      .catch((error) => {
        const message = errorMessage(error);
        return { success: false, error: message };
      })
      .then(async (result) => {
        if (!entry.supersededResult) {
          entry.supersededWaiters?.resolve(result);
        }
        const isLatest = ScreenshotJobTracker.isLatest(deviceId, jobId);
        const completion: ScreenshotJobCompletion = {
          deviceId,
          jobId,
          result,
          aborted: abortController.signal.aborted,
          isLatest,
        };
        ScreenshotJobTracker.completions.set(jobId, {
          aborted: completion.aborted,
          isLatest: completion.isLatest,
        });
        ScreenshotJobTracker.completionDeviceIds.set(jobId, deviceId);
        if (options.onComplete) {
          try {
            await options.onComplete(completion);
          } catch (err) {
            logger.warn(`[ScreenshotJobTracker] Completion handler failed: ${err}`);
          }
        }
        if (!ScreenshotJobTracker.completionReaderCounts.get(jobId)) {
          ScreenshotJobTracker.evictCompletion(jobId);
        }
        return result;
      });

    const entry: ScreenshotJobEntry = {
      jobId,
      get promise() {
        return promise;
      },
      abortController,
      startedAt: ScreenshotJobTracker.timer.now(),
      allowsCoalescing: !options.queueAfterPending,
      queueKind,
      started: false,
      previous,
      supersededWaiters,
      cleanupParentSignal,
    };

    jobs.push(entry);
    ScreenshotJobTracker.jobs.set(deviceId, jobs);
    if (!queueAfterPending) {
      ScreenshotJobTracker.latestJobIds.set(deviceId, jobId);
    }

    promise
      .finally(() => ScreenshotJobTracker.finishJob(deviceId, jobId, cleanupParentSignal))
      .catch((error) => {
        logger.warn(`[ScreenshotJobTracker] Job cleanup failed: ${errorMessage(error)}`, error);
      });

    return {
      jobId,
      promise,
      signal: abortController.signal,
    };
  }

  private static finishJob(
    deviceId: string,
    jobId: string,
    cleanupParentSignal?: () => void,
  ): void {
    const current = ScreenshotJobTracker.jobs.get(deviceId);
    if (!current) {
      ScreenshotJobTracker.runningJobIds.delete(jobId);
      if (ScreenshotJobTracker.latestJobIds.get(deviceId) === jobId) {
        ScreenshotJobTracker.latestJobIds.delete(deviceId);
      }
      cleanupParentSignal?.();
      return;
    }
    const entryIndex = current.findIndex((candidate) => candidate.jobId === jobId);
    if (entryIndex !== -1) {
      current.splice(entryIndex, 1);
    }
    ScreenshotJobTracker.runningJobIds.delete(jobId);
    if (current.length === 0) {
      ScreenshotJobTracker.jobs.delete(deviceId);
      ScreenshotJobTracker.latestJobIds.delete(deviceId);
    }
    cleanupParentSignal?.();
  }

  static cancelJob(deviceId: string): void {
    const entries = ScreenshotJobTracker.jobs.get(deviceId);
    if (entries) {
      ScreenshotJobTracker.jobs.delete(deviceId);
      for (const entry of entries) {
        if (!entry.abortController.signal.aborted) {
          entry.abortController.abort();
        }
        entry.supersededWaiters?.resolve({ success: false, error: OPERATION_CANCELLED_MESSAGE });
        entry.cleanupParentSignal?.();
      }
    }
    for (const [jobId, completionDeviceId] of ScreenshotJobTracker.completionDeviceIds) {
      if (completionDeviceId === deviceId) {
        ScreenshotJobTracker.evictCompletion(jobId);
      }
    }
  }

  static isPending(deviceId: string): boolean {
    return ScreenshotJobTracker.jobs.has(deviceId);
  }

  static isLatest(deviceId: string, jobId: string): boolean {
    return ScreenshotJobTracker.latestJobIds.get(deviceId) === jobId;
  }

  static getCompletion(jobId: string): ScreenshotJobCompletionSnapshot | undefined {
    return ScreenshotJobTracker.completions.get(jobId);
  }

  static registerCompletionReader(jobId: string): void {
    ScreenshotJobTracker.completionReaderCounts.set(
      jobId,
      (ScreenshotJobTracker.completionReaderCounts.get(jobId) ?? 0) + 1,
    );
  }

  static releaseCompletionReader(jobId: string): void {
    const readers = ScreenshotJobTracker.completionReaderCounts.get(jobId);
    if (!readers) {
      return;
    }
    if (readers > 1) {
      ScreenshotJobTracker.completionReaderCounts.set(jobId, readers - 1);
      return;
    }
    ScreenshotJobTracker.completionReaderCounts.delete(jobId);
    if (ScreenshotJobTracker.completions.has(jobId)) {
      ScreenshotJobTracker.evictCompletion(jobId);
    }
  }

  static async waitForCompletion(
    deviceId: string,
    timeoutMs: number,
  ): Promise<ScreenshotResult | null> {
    const entry = ScreenshotJobTracker.jobs.get(deviceId)?.at(-1);
    if (!entry) {
      return null;
    }

    const timedOut = new Error("Screenshot completion timed out");
    try {
      return await raceWithDeadline(entry.promise, {
        timer: ScreenshotJobTracker.timer,
        timeoutMs,
        label: "Screenshot completion",
        timeoutError: () => timedOut,
      });
    } catch (error) {
      if (error === timedOut) {
        return null;
      }
      throw error;
    }
  }

  static clear(): void {
    for (const entries of ScreenshotJobTracker.jobs.values()) {
      for (const entry of entries) {
        if (!entry.abortController.signal.aborted) {
          entry.abortController.abort();
        }
        entry.supersededWaiters?.resolve({ success: false, error: OPERATION_CANCELLED_MESSAGE });
        entry.cleanupParentSignal?.();
      }
    }
    ScreenshotJobTracker.jobs.clear();
    ScreenshotJobTracker.latestJobIds.clear();
    ScreenshotJobTracker.completions.clear();
    ScreenshotJobTracker.completionReaderCounts.clear();
    ScreenshotJobTracker.completionDeviceIds.clear();
    ScreenshotJobTracker.runningJobIds.clear();
  }

  private static evictCompletion(jobId: string): void {
    ScreenshotJobTracker.completions.delete(jobId);
    ScreenshotJobTracker.completionDeviceIds.delete(jobId);
    ScreenshotJobTracker.completionReaderCounts.delete(jobId);
  }
}

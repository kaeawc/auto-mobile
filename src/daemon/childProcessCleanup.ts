import type { VideoRecordingRecord } from "../db/videoRecordingRepository";
import {
  interruptVideoRecording,
  listActiveVideoRecordings,
  stopVideoRecording,
} from "../server/videoRecordingManager";
import { IOSCtrlProxyManager } from "../utils/IOSCtrlProxyManager";
import { logger } from "../utils/logger";
import { defaultTimer, type Timer } from "../utils/SystemTimer";

const CHILD_PROCESS_CLEANUP_TIMEOUT_MS = 10_000;

/**
 * Process owners which must be cleaned up before the daemon closes its database.
 * Kept injectable so shutdown ordering and best-effort behavior are covered
 * without starting real capture or iOS runner processes.
 */
export interface DaemonChildProcessCleanupDependencies {
  listActiveVideoRecordings(): Promise<VideoRecordingRecord[]>;
  stopVideoRecording(recordingId: string): Promise<unknown>;
  interruptVideoRecording(recordingId: string): Promise<void>;
  shutdownIOSCtrlProxies(): Promise<void>;
  timer?: Timer;
  timeoutMs?: number;
}

const defaultDependencies: DaemonChildProcessCleanupDependencies = {
  listActiveVideoRecordings,
  stopVideoRecording,
  interruptVideoRecording,
  shutdownIOSCtrlProxies: () => IOSCtrlProxyManager.shutdownAll(),
};

/**
 * Stop every capture child and iOS CtrlProxy instance during daemon shutdown.
 * Failures are deliberately isolated: a failed child must not strand unrelated
 * recordings or CtrlProxy/iproxy processes during the same shutdown.
 */
export async function cleanupDaemonChildProcesses(
  dependencies: DaemonChildProcessCleanupDependencies = defaultDependencies
): Promise<void> {
  const timer = dependencies.timer ?? defaultTimer;
  const timeoutMs = dependencies.timeoutMs ?? CHILD_PROCESS_CLEANUP_TIMEOUT_MS;
  let activeRecordings: VideoRecordingRecord[] = [];
  try {
    const result = await settleWithin(
      dependencies.listActiveVideoRecordings(),
      timer,
      timeoutMs
    );
    if (result.status === "fulfilled") {
      activeRecordings = result.value;
    } else {
      logger.warn(`[Daemon] Failed to list active recordings during shutdown: ${result.error}`);
    }
  } catch (error) {
    logger.warn(`[Daemon] Failed to list active recordings during shutdown: ${error}`);
  }

  await Promise.all(activeRecordings.map(async recording => {
    try {
      const result = await settleWithin(
        dependencies.stopVideoRecording(recording.recordingId),
        timer,
        timeoutMs
      );
      if (result.status === "fulfilled") {
        return;
      }
      logger.warn(
        `[Daemon] Failed to stop recording ${recording.recordingId} during shutdown: ${result.error}`
      );
      const interrupted = await settleWithin(
        dependencies.interruptVideoRecording(recording.recordingId),
        timer,
        timeoutMs
      );
      if (interrupted.status !== "fulfilled") {
        logger.warn(
          `[Daemon] Failed to interrupt recording ${recording.recordingId} during shutdown: ${interrupted.error}`
        );
      }
    } catch (error) {
      logger.warn(`[Daemon] Unexpected recording cleanup error during shutdown: ${error}`);
    }
  }));

  const proxies = await settleWithin(dependencies.shutdownIOSCtrlProxies(), timer, timeoutMs);
  if (proxies.status !== "fulfilled") {
    logger.warn(`[Daemon] Failed to stop iOS CtrlProxy instances during shutdown: ${proxies.error}`);
  }
}

type Settled<T> =
  | { status: "fulfilled"; value: T }
  | { status: "failed"; error: unknown };

async function settleWithin<T>(work: Promise<T>, timer: Timer, timeoutMs: number): Promise<Settled<T>> {
  let handle: NodeJS.Timeout | undefined;
  const settled: Promise<Settled<T>> = work.then(
    value => ({ status: "fulfilled", value }),
    error => ({ status: "failed", error })
  );
  const timeout = new Promise<Settled<T>>(resolve => {
    handle = timer.setTimeout(
      () => resolve({ status: "failed", error: new Error(`timed out after ${timeoutMs}ms`) }),
      timeoutMs
    );
  });
  try {
    return await Promise.race([settled, timeout]);
  } finally {
    if (handle) {
      timer.clearTimeout(handle);
    }
  }
}

import type { VideoRecordingRecord } from "../db/videoRecordingRepository";
import {
  interruptVideoRecording,
  listActiveVideoRecordings,
  forceStopVideoRecording,
  stopAcceptingVideoRecordingStarts,
  stopVideoRecording,
} from "../server/videoRecordingManager";
import { IOSCtrlProxyManager } from "../utils/IOSCtrlProxyManager";
import { logger } from "../utils/logger";
import { defaultTimer, type Timer } from "../utils/SystemTimer";

// DaemonManager and stdin lifecycle both force-exit after ten seconds. Keep each
// best-effort stage short enough for the fallback force-stop to run before that
// outer deadline, even when listing, graceful stop, and interruption all stall.
const CHILD_PROCESS_CLEANUP_TIMEOUT_MS = 1_500;

/**
 * Process owners which must be cleaned up before the daemon closes its database.
 * Kept injectable so shutdown ordering and best-effort behavior are covered
 * without starting real capture or iOS runner processes.
 */
export interface DaemonChildProcessCleanupDependencies {
  stopAcceptingVideoRecordingStarts(): Promise<void>;
  listActiveVideoRecordings(): Promise<VideoRecordingRecord[]>;
  stopVideoRecording(recordingId: string): Promise<unknown>;
  forceStopVideoRecording(recordingId: string): Promise<void>;
  interruptVideoRecording(recordingId: string): Promise<void>;
  shutdownIOSCtrlProxies(): Promise<void>;
  timer?: Timer;
  timeoutMs?: number;
}

const defaultDependencies: DaemonChildProcessCleanupDependencies = {
  stopAcceptingVideoRecordingStarts,
  listActiveVideoRecordings,
  stopVideoRecording,
  forceStopVideoRecording,
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
    const admission = await settleWithin(
      dependencies.stopAcceptingVideoRecordingStarts(),
      timer,
      timeoutMs
    );
    if (admission.status !== "fulfilled") {
      logger.warn(`[Daemon] Failed to quiesce recording starts during shutdown: ${admission.error}`);
    }
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
      const stop = dependencies.stopVideoRecording(recording.recordingId);
      const result = await settleWithin(
        stop,
        timer,
        timeoutMs
      );
      if (result.status === "fulfilled") {
        return;
      }
      logger.warn(
        `[Daemon] Failed to stop recording ${recording.recordingId} during shutdown: ${result.error}`
      );
      const forceStopped = await settleWithin(
        dependencies.forceStopVideoRecording(recording.recordingId),
        timer,
        timeoutMs
      );
      if (forceStopped.status !== "fulfilled") {
        logger.warn(
          `[Daemon] Failed to force-stop recording ${recording.recordingId} during shutdown: ${forceStopped.error}`
        );
      }
      // A timed stop can have already finalized the backend and still be
      // persisting archive metadata. Do not race that finalization with an
      // interruption or database closure; the outer daemon deadline remains
      // the bounded escape hatch for a permanently wedged finalizer.
      try {
        await stop;
        return;
      } catch (error) {
        logger.warn(
          `[Daemon] Recording ${recording.recordingId} did not finish after force-stop: ${error}`
        );
      }
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

import type { VideoRecordingRecord } from "../db/videoRecordingRepository";
import {
  interruptVideoRecording,
  listActiveVideoRecordings,
  stopVideoRecording,
} from "../server/videoRecordingManager";
import { IOSCtrlProxyManager } from "../utils/IOSCtrlProxyManager";
import { logger } from "../utils/logger";

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
  let activeRecordings: VideoRecordingRecord[] = [];
  try {
    activeRecordings = await dependencies.listActiveVideoRecordings();
  } catch (error) {
    logger.warn(`[Daemon] Failed to list active recordings during shutdown: ${error}`);
  }

  for (const recording of activeRecordings) {
    try {
      await dependencies.stopVideoRecording(recording.recordingId);
    } catch (error) {
      logger.warn(
        `[Daemon] Failed to stop recording ${recording.recordingId} during shutdown: ${error}`
      );
      try {
        await dependencies.interruptVideoRecording(recording.recordingId);
      } catch (interruptError) {
        logger.warn(
          `[Daemon] Failed to interrupt recording ${recording.recordingId} during shutdown: ${interruptError}`
        );
      }
    }
  }

  try {
    await dependencies.shutdownIOSCtrlProxies();
  } catch (error) {
    logger.warn(`[Daemon] Failed to stop iOS CtrlProxy instances during shutdown: ${error}`);
  }
}

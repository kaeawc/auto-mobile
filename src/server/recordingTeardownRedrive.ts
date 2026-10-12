import type { SessionManager } from "../daemon/sessionManager";
import type {
  VideoRecordingRecord,
  VideoRecordingRepository,
} from "../db/videoRecordingRepository";
import type { VideoCaptureTeardownDescriptor } from "../features/video/VideoRecorderService";
import { ANDROID_SCREENRECORD_MAX_SECONDS } from "../features/video/androidScreenrecord";
import { ActionableError, type BootedDevice } from "../models";
import { logger } from "../utils/logger";
import { INCOMPLETE_MARK_GRACE_MS } from "./videoRecordingManager";

export const ORPHAN_SCREENRECORD_EXIT_MARGIN_MS = 5_000;

export interface RecordingTeardownRedriveDeps {
  recordingRepository: Pick<VideoRecordingRepository, "listRecordings" | "updateRecording">;
  liveDaemonSessionIds: ReadonlySet<string>;
  ownedCaptureIds(): readonly string[];
  getDevice(deviceId: string): BootedDevice | undefined;
  getDeviceIncarnation(deviceId: string): number | undefined;
  forceStopOrphanedCapture(
    device: BootedDevice,
    descriptor: VideoCaptureTeardownDescriptor,
  ): Promise<void>;
  now(): number;
}

/** Read and mark only: background health recovery owns the retries, never startup. */
export async function redriveUnconfirmedCaptureTeardowns(
  manager: Pick<SessionManager, "markDeviceNeedsRecorderTeardown">,
  deps: RecordingTeardownRedriveDeps,
): Promise<boolean> {
  let rows: VideoRecordingRecord[];
  try {
    rows = await deps.recordingRepository.listRecordings({
      hasCaptureTeardown: true,
      excludeLiveDaemonSessionIds: deps.liveDaemonSessionIds,
    });
  } catch (error) {
    logger.warn(
      "[RecordingTeardownRedrive] Could not read unconfirmed capture teardowns; continuing startup",
      error,
    );
    return false;
  }
  const owned = new Set(deps.ownedCaptureIds());
  const byDevice = new Map<string, VideoRecordingRecord[]>();
  for (const row of rows) {
    if (!row.captureTeardown || owned.has(row.recordingId)) {
      continue;
    }
    const group = byDevice.get(row.deviceId) ?? [];
    group.push(row);
    byDevice.set(row.deviceId, group);
  }
  for (const [deviceId, records] of byDevice) {
    if (deps.getDeviceIncarnation(deviceId) === undefined) {
      logger.warn(
        `[RecordingTeardownRedrive] Device ${deviceId} has no pool incarnation; retaining capture descriptors for next startup`,
      );
      continue;
    }
    manager.markDeviceNeedsRecorderTeardown(
      deviceId,
      () => retryOrphanedCaptures(deviceId, records, deps),
      INCOMPLETE_MARK_GRACE_MS,
    );
  }
  return true;
}

async function retryOrphanedCaptures(
  deviceId: string,
  records: VideoRecordingRecord[],
  deps: RecordingTeardownRedriveDeps,
): Promise<void> {
  const unconfirmed: string[] = [];
  for (const row of records) {
    if (!row.captureTeardown) {
      continue;
    }
    try {
      await confirmOrphanedCapture(row, deps);
      await deps.recordingRepository.updateRecording(row.recordingId, {
        captureTeardown: undefined,
      });
      row.captureTeardown = undefined;
    } catch (error) {
      logger.warn(
        `[RecordingTeardownRedrive] Teardown unconfirmed for ${row.recordingId} on ${deviceId}`,
        error,
      );
      unconfirmed.push(row.recordingId);
    }
  }
  if (unconfirmed.length > 0) {
    throw new ActionableError(
      `Orphan recorder teardown on ${deviceId} is unconfirmed for ${unconfirmed.join(", ")}. Recover the device if retries fail.`,
    );
  }
}

async function confirmOrphanedCapture(
  row: VideoRecordingRecord,
  deps: RecordingTeardownRedriveDeps,
): Promise<void> {
  const descriptor = row.captureTeardown!;
  if (descriptor.devicePid === undefined) {
    const expiresAt =
      Date.parse(row.startedAt) +
      ANDROID_SCREENRECORD_MAX_SECONDS * 1_000 +
      ORPHAN_SCREENRECORD_EXIT_MARGIN_MS;
    if (!Number.isFinite(expiresAt) || deps.now() < expiresAt) {
      throw new ActionableError(
        `Orphan recorder ${row.recordingId} on ${row.deviceId} has no pid and its screenrecord hard limit has not elapsed.`,
      );
    }
    return;
  }
  const device = deps.getDevice(row.deviceId);
  if (!device) {
    throw new ActionableError(
      `Cannot find device ${row.deviceId} to confirm orphan recorder teardown.`,
    );
  }
  await deps.forceStopOrphanedCapture(device, descriptor);
}

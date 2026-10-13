import type { SessionManager } from "../daemon/sessionManager";
import type {
  VideoRecordingRecord,
  VideoRecordingRepository,
} from "../db/videoRecordingRepository";
import type { VideoCaptureTeardownDescriptor } from "../features/video/VideoRecorderService";
import { ANDROID_SCREENRECORD_MAX_SECONDS } from "../features/video/androidScreenrecord";
import { ActionableError, type BootedDevice } from "../models";
import { logger } from "../utils/logger";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import type { Timer } from "../utils/SystemTimer";
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
  onDeviceIncarnationAssigned?(listener: (deviceId: string) => void): void;
  now(): number;
  timer: Pick<Timer, "sleep" | "setTimeout" | "clearTimeout">;
}

type RedriveManager = Pick<
  SessionManager,
  | "markDeviceNeedsRecorderTeardown"
  | "getSessionForDevice"
  | "onSessionRelease"
  | "onSessionDeviceUnbound"
  | "registerPendingDeviceCleanup"
>;

/** Idle devices are marked now; held devices redrive under release-time quarantine. */
export async function redriveUnconfirmedCaptureTeardowns(
  manager: RedriveManager,
  deps: RecordingTeardownRedriveDeps,
): Promise<boolean> {
  const byDevice = new Map<string, VideoRecordingRecord[]>();
  const pending = new Map<string, PendingRedrive>();
  const redrivenIncarnations = new Map<string, number>();
  let subscribedPending = false;
  const redriveDevice = (deviceId: string, hookDriven: boolean): void => {
    const incarnation = deps.getDeviceIncarnation(deviceId);
    const owned = new Set(deps.ownedCaptureIds());
    const records = (byDevice.get(deviceId) ?? []).filter(
      (row) => row.captureTeardown && (!hookDriven || !owned.has(row.recordingId)),
    );
    if (
      records.length === 0 ||
      (incarnation !== undefined && redrivenIncarnations.get(deviceId) === incarnation)
    ) {
      return;
    }
    if (incarnation === undefined) {
      logger.warn(
        `[RecordingTeardownRedrive] Device ${deviceId} has no pool incarnation; retaining capture descriptors until the device is pooled`,
      );
      return;
    }
    redrivenIncarnations.set(deviceId, incarnation);
    if (manager.getSessionForDevice(deviceId) !== null) {
      pending.set(deviceId, { records, hookDriven });
      if (!subscribedPending) {
        subscribePendingRedrive(manager, pending, deps);
        subscribedPending = true;
      }
    } else {
      markOrphanedCaptures(manager, deviceId, records, deps, hookDriven);
    }
  };
  // Install before the startup read yields: its loop handles devices added during the read.
  deps.onDeviceIncarnationAssigned?.((deviceId) => redriveDevice(deviceId, true));
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
  for (const row of rows) {
    if (!row.captureTeardown || owned.has(row.recordingId)) {
      continue;
    }
    const group = byDevice.get(row.deviceId) ?? [];
    group.push(row);
    byDevice.set(row.deviceId, group);
  }
  for (const deviceId of byDevice.keys()) {
    redriveDevice(deviceId, false);
  }
  return true;
}

function markOrphanedCaptures(
  manager: RedriveManager,
  deviceId: string,
  records: VideoRecordingRecord[],
  deps: RecordingTeardownRedriveDeps,
  hookDriven = false,
): void {
  const remainingMs = records.map((row) => {
    const expiry = orphanExpiresAt(row);
    return Number.isFinite(expiry) ? Math.max(0, expiry - deps.now()) : 0;
  });
  manager.markDeviceNeedsRecorderTeardown(
    deviceId,
    () => retryOrphanedCaptures(deviceId, records, deps, true, hookDriven),
    Math.max(INCOMPLETE_MARK_GRACE_MS, ...remainingMs.map((ms) => ms + INCOMPLETE_MARK_GRACE_MS)),
  );
}

interface PendingRedrive {
  records: VideoRecordingRecord[];
  hookDriven: boolean;
}

function subscribePendingRedrive(
  manager: RedriveManager,
  pending: Map<string, PendingRedrive>,
  deps: RecordingTeardownRedriveDeps,
): void {
  const consume = (deviceId: string, identityReplaced = false): void => {
    const work = pending.get(deviceId);
    if (!work) {
      return;
    }
    const { records, hookDriven } = work;
    pending.delete(deviceId);
    if (identityReplaced) {
      void clearReplacedDescriptors(records, deps);
      return;
    }
    manager.registerPendingDeviceCleanup(
      deviceId,
      confirmReleasedCaptures(manager, deviceId, records, deps, hookDriven),
      INCOMPLETE_MARK_GRACE_MS,
    );
  };
  manager.onSessionRelease((_sessionId, deviceId, _reason, _snapshot, options) => {
    if (!options?.upgradeOnly) {
      consume(deviceId, options?.deviceIdentityReplaced);
    }
  });
  manager.onSessionDeviceUnbound((_sessionId, deviceId) => consume(deviceId));
}

async function clearReplacedDescriptors(
  records: VideoRecordingRecord[],
  deps: RecordingTeardownRedriveDeps,
): Promise<void> {
  for (const row of records) {
    try {
      await deps.recordingRepository.updateRecording(row.recordingId, {
        captureTeardown: undefined,
      });
      row.captureTeardown = undefined;
    } catch (error) {
      logger.warn(
        `[RecordingTeardownRedrive] Could not clear replaced-device descriptor for ${row.recordingId}`,
        error,
      );
    }
  }
}

async function confirmReleasedCaptures(
  manager: RedriveManager,
  deviceId: string,
  records: VideoRecordingRecord[],
  deps: RecordingTeardownRedriveDeps,
  hookDriven: boolean,
): Promise<void> {
  try {
    await raceWithDeadline(
      () => retryOrphanedCaptures(deviceId, records, deps, false, hookDriven),
      {
        timer: deps.timer,
        timeoutMs: INCOMPLETE_MARK_GRACE_MS,
        label: `Released orphan recorder teardown on ${deviceId}`,
      },
    );
  } catch (error) {
    logger.warn(
      `[RecordingTeardownRedrive] Release-time teardown unconfirmed on ${deviceId}`,
      error,
    );
    // Mark synchronously before this pending cleanup settles, so allocation stays fenced.
    markOrphanedCaptures(manager, deviceId, records, deps, hookDriven);
  }
}

async function retryOrphanedCaptures(
  deviceId: string,
  records: VideoRecordingRecord[],
  deps: RecordingTeardownRedriveDeps,
  waitForExpiry: boolean,
  hookDriven = false,
): Promise<void> {
  const unconfirmed: string[] = [];
  for (const row of records) {
    if (!row.captureTeardown) {
      continue;
    }
    try {
      if (hookDriven && !(await hookRowStillUnconfirmed(row, deps))) {
        continue;
      }
      await confirmOrphanedCapture(row, deps, waitForExpiry);
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

/** Revalidate only startup work; rows newly discovered by this read are never acted on. */
async function hookRowStillUnconfirmed(
  row: VideoRecordingRecord,
  deps: RecordingTeardownRedriveDeps,
): Promise<boolean> {
  if (deps.ownedCaptureIds().includes(row.recordingId)) {
    return false;
  }
  const current = await deps.recordingRepository.listRecordings({
    hasCaptureTeardown: true,
    excludeLiveDaemonSessionIds: deps.liveDaemonSessionIds,
    deviceId: row.deviceId,
  });
  if (current.some((candidate) => candidate.recordingId === row.recordingId)) {
    return !deps.ownedCaptureIds().includes(row.recordingId);
  }
  // Cleared or now peer-owned: acknowledge locally, without writing somebody else's row.
  row.captureTeardown = undefined;
  return false;
}

function orphanExpiresAt(row: VideoRecordingRecord): number {
  if (row.captureTeardown?.devicePid !== undefined || !row.captureTeardown) {
    return NaN;
  }
  return (
    Date.parse(row.startedAt) +
    ANDROID_SCREENRECORD_MAX_SECONDS * 1_000 +
    ORPHAN_SCREENRECORD_EXIT_MARGIN_MS
  );
}

async function confirmOrphanedCapture(
  row: VideoRecordingRecord,
  deps: RecordingTeardownRedriveDeps,
  waitForExpiry: boolean,
): Promise<void> {
  const descriptor = row.captureTeardown!;
  if (descriptor.devicePid === undefined) {
    const expiresAt = orphanExpiresAt(row);
    if (!Number.isFinite(expiresAt) || (!waitForExpiry && deps.now() < expiresAt)) {
      throw new ActionableError(
        `Orphan recorder ${row.recordingId} on ${row.deviceId} has no pid and its screenrecord hard limit has not elapsed.`,
      );
    }
    if (deps.now() < expiresAt) {
      await deps.timer.sleep(expiresAt - deps.now());
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

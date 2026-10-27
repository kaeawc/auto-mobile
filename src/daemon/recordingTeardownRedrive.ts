import { ORPHAN_SCREENRECORD_EXIT_MARGIN_MS } from "./recorderTeardownRecovery";
import { DeviceUnreachableError } from "../models/DeviceUnreachableError";
import type { SessionManager } from "./sessionManager";
import type {
  VideoRecordingRecord,
  VideoRecordingRepository,
} from "../db/videoRecordingRepository";
import type {
  OrphanCaptureStopOptions,
  VideoCaptureTeardownDescriptor,
} from "../features/video/VideoRecorderService";
import { ANDROID_SCREENRECORD_MAX_SECONDS } from "../features/video/androidScreenrecord";
import { ActionableError, type BootedDevice } from "../models";
import { logger } from "../utils/logger";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import type { Timer } from "../utils/SystemTimer";
import { INCOMPLETE_MARK_GRACE_MS } from "./videoRecordingManager";

export { ORPHAN_SCREENRECORD_EXIT_MARGIN_MS } from "./recorderTeardownRecovery";

export interface StartupOrphanCaptures {
  /** Retained startup rows on this device whose descriptor is still unconfirmed. */
  list(
    deviceId: string,
  ): readonly { recordingId: string; deviceId: string; ownerSessionUuid?: string }[];
  /** Which device holds the retained orphan with this id, if any. */
  find(
    recordingId: string,
  ): { recordingId: string; deviceId: string; ownerSessionUuid?: string } | undefined;
  /** Stop and acknowledge startup rows; reject when teardown remains unconfirmed. */
  stop(deviceId: string, recordingId?: string, options?: OrphanCaptureStopOptions): Promise<void>;
}

export interface RecordingTeardownRedriveDeps {
  recordingRepository: Pick<VideoRecordingRepository, "listRecordings" | "updateRecording">;
  liveDaemonSessionIds: ReadonlySet<string>;
  ownedCaptureIds(): readonly string[];
  getDevice(deviceId: string): BootedDevice | undefined;
  getDeviceIncarnation(deviceId: string): number | undefined;
  forceStopOrphanedCapture(
    device: BootedDevice | undefined,
    descriptor: VideoCaptureTeardownDescriptor,
    options?: OrphanCaptureStopOptions,
  ): Promise<void>;
  onStartupOrphans?(handle: StartupOrphanCaptures): void;
  onDeviceProcessStarted?(listener: (deviceId: string) => void | Promise<void>): void;
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

/** Startup-only bookkeeping; never written back to the repository. */
interface RetainedCaptureRow extends VideoRecordingRecord {
  confirmation?: Promise<void>;
  hookDriven?: boolean;
  withdrawRetry?: () => void;
  firstMarkedIncarnation?: number;
  warnedUnconfirmableRedrive?: boolean;
}

/** Idle devices are marked now; held devices redrive under release-time quarantine. */
export async function redriveUnconfirmedCaptureTeardowns(
  manager: RedriveManager,
  deps: RecordingTeardownRedriveDeps,
): Promise<boolean> {
  const byDevice = new Map<string, RetainedCaptureRow[]>();
  const pending = new Map<string, PendingRedrive>();
  const redrivenIncarnations = new Map<string, number | undefined>();
  let subscribedPending = false;
  const orphans = createStartupOrphanCaptures(byDevice, deps);
  const redriveDevice = (deviceId: string, hookDriven: boolean): void => {
    const incarnation = deps.getDeviceIncarnation(deviceId);
    const owned = new Set(deps.ownedCaptureIds());
    const records = (byDevice.get(deviceId) ?? []).filter(
      (row) =>
        row.captureTeardown &&
        (!hookDriven || !owned.has(row.recordingId)) &&
        canRedriveCapture(row, incarnation),
    );
    if (
      records.length === 0 ||
      (incarnation !== undefined && redrivenIncarnations.get(deviceId) === incarnation)
    ) {
      return;
    }
    if (
      incarnation === undefined &&
      records.some((row) => row.captureTeardown?.kind !== "ios-host-recorder")
    ) {
      logger.warn(
        `[RecordingTeardownRedrive] Device ${deviceId} has no pool incarnation; retaining capture descriptors until the device is pooled`,
      );
      return;
    }
    for (const row of records) {
      row.hookDriven ||= hookDriven;
    }
    redrivenIncarnations.set(deviceId, incarnation);
    if (manager.getSessionForDevice(deviceId) !== null) {
      pending.set(deviceId, { records, hookDriven });
      if (!subscribedPending) {
        subscribePendingRedrive(manager, pending, deps);
        subscribedPending = true;
      }
    } else {
      if (incarnation === undefined) {
        // Host identities can be confirmed before the device is added to the pool.
        manager.registerPendingDeviceCleanup(
          deviceId,
          confirmReleasedCaptures(manager, deviceId, records, deps, hookDriven),
          INCOMPLETE_MARK_GRACE_MS,
        );
      } else {
        markOrphanedCaptures(manager, deviceId, records, deps, hookDriven);
      }
    }
  };
  // Install before the startup read yields: its loop handles devices added during the read.
  deps.onDeviceIncarnationAssigned?.((deviceId) => redriveDevice(deviceId, true));
  deps.onDeviceProcessStarted?.(async (deviceId) => {
    if (orphans.list(deviceId).length === 0) {
      return;
    }
    try {
      // Quick-boot snapshots can restore a recorder: a new child is not teardown proof.
      await raceWithDeadline(() => orphans.stop(deviceId, undefined, { mode: "background" }), {
        timer: deps.timer,
        timeoutMs: INCOMPLETE_MARK_GRACE_MS,
        label: `Process-start orphan recorder teardown on ${deviceId}`,
      });
    } catch (error) {
      logger.warn(
        `[RecordingTeardownRedrive] Process-start teardown unconfirmed on ${deviceId}`,
        error,
      );
    }
  });
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
    group.push({ ...row });
    byDevice.set(row.deviceId, group);
  }
  for (const deviceId of byDevice.keys()) {
    redriveDevice(deviceId, false);
  }
  deps.onStartupOrphans?.(orphans);
  return true;
}

function createStartupOrphanCaptures(
  byDevice: Map<string, RetainedCaptureRow[]>,
  deps: RecordingTeardownRedriveDeps,
): StartupOrphanCaptures {
  const retained = (deviceId: string) =>
    (byDevice.get(deviceId) ?? []).filter(
      (row) =>
        row.captureTeardown &&
        !deps.ownedCaptureIds().includes(row.recordingId) &&
        canRedriveCapture(row, deps.getDeviceIncarnation(deviceId)),
    );
  const reference = (row: RetainedCaptureRow) => ({
    recordingId: row.recordingId,
    deviceId: row.deviceId,
    ownerSessionUuid: row.ownerSessionUuid,
  });
  return {
    list: (deviceId) => retained(deviceId).map(reference),
    find: (recordingId) => {
      for (const deviceId of byDevice.keys()) {
        const row = retained(deviceId).find((row) => row.recordingId === recordingId);
        if (row) {
          return reference(row);
        }
      }
      return undefined;
    },
    stop: async (deviceId, recordingId, options) => {
      const records = retained(deviceId).filter(
        (row) => !recordingId || row.recordingId === recordingId,
      );
      try {
        await retryOrphanedCaptures(deviceId, records, deps, false, false, options?.mode ?? "user");
      } finally {
        // A disposer belongs to a whole registered batch, not to an individual row.
        const batches = new Set(records.map((row) => row.withdrawRetry));
        for (const withdraw of batches) {
          if (
            withdraw &&
            !(byDevice.get(deviceId) ?? []).some(
              (row) => row.withdrawRetry === withdraw && row.captureTeardown,
            )
          ) {
            withdraw();
          }
        }
      }
    },
  };
}

function canRedriveCapture(row: RetainedCaptureRow, incarnation: number | undefined): boolean {
  if (
    incarnation === undefined ||
    row.firstMarkedIncarnation === undefined ||
    row.firstMarkedIncarnation === incarnation ||
    hasConfirmableIdentity(row.captureTeardown) ||
    Number.isFinite(orphanExpiresAt(row))
  ) {
    return true;
  }
  if (!row.warnedUnconfirmableRedrive) {
    logger.warn(
      `[RecordingTeardownRedrive] Unconfirmable descriptor for ${row.recordingId} is retained; device ${row.deviceId} is no longer quarantined for it after its first marked incarnation`,
    );
    row.warnedUnconfirmableRedrive = true;
  }
  return false;
}

function markOrphanedCaptures(
  manager: RedriveManager,
  deviceId: string,
  records: RetainedCaptureRow[],
  deps: RecordingTeardownRedriveDeps,
  hookDriven = false,
): void {
  records = records.filter((row) => row.captureTeardown);
  if (records.length === 0) {
    return;
  }
  const remainingMs = records.map((row) => {
    const expiry = orphanExpiresAt(row);
    return Number.isFinite(expiry) ? Math.max(0, expiry - deps.now()) : 0;
  });
  const withdrawRetry = manager.markDeviceNeedsRecorderTeardown(
    deviceId,
    () => retryOrphanedCaptures(deviceId, records, deps, true, hookDriven),
    Math.max(INCOMPLETE_MARK_GRACE_MS, ...remainingMs.map((ms) => ms + INCOMPLETE_MARK_GRACE_MS)),
  );
  for (const row of records) {
    row.withdrawRetry = withdrawRetry;
    row.firstMarkedIncarnation ??= deps.getDeviceIncarnation(deviceId);
  }
}

interface PendingRedrive {
  records: RetainedCaptureRow[];
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
    const { hookDriven } = work;
    let { records } = work;
    pending.delete(deviceId);
    if (identityReplaced) {
      void clearReplacedDescriptors(
        records.filter((row) => row.captureTeardown?.kind !== "ios-host-recorder"),
        deps,
      );
      records = records.filter((row) => row.captureTeardown?.kind === "ios-host-recorder");
      if (records.length === 0) {
        return;
      }
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
  manager.onSessionDeviceUnbound((_sessionId, deviceId, options) =>
    consume(deviceId, options?.deviceIdentityReplaced),
  );
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
  records: RetainedCaptureRow[],
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
  records: RetainedCaptureRow[],
  deps: RecordingTeardownRedriveDeps,
  waitForExpiry: boolean,
  hookDriven = false,
  mode: "user" | "background" = "background",
): Promise<void> {
  const unconfirmed: string[] = [];
  const failures: unknown[] = [];
  for (const row of records) {
    if (!row.captureTeardown || deps.ownedCaptureIds().includes(row.recordingId)) {
      continue;
    }
    try {
      await confirmRetainedCapture(row, deps, waitForExpiry, hookDriven, mode);
    } catch (error) {
      logger.warn(
        `[RecordingTeardownRedrive] Teardown unconfirmed for ${row.recordingId} on ${deviceId}`,
        error,
      );
      unconfirmed.push(row.recordingId);
      failures.push(error);
    }
  }
  if (unconfirmed.length > 0) {
    const Failure = failures.every((error) => error instanceof DeviceUnreachableError)
      ? DeviceUnreachableError
      : ActionableError;
    throw new Failure(
      `Orphan recorder teardown on ${deviceId} is unconfirmed for ${unconfirmed.join(", ")}. Recover the device if retries fail.`,
      { cause: failures[0] },
    );
  }
}

/** Share PID confirmation and acknowledgement across caller, release and health retries. */
async function confirmRetainedCapture(
  row: RetainedCaptureRow,
  deps: RecordingTeardownRedriveDeps,
  waitForExpiry: boolean,
  hookDriven: boolean,
  mode: "user" | "background",
): Promise<void> {
  // A caller preflight never joins a health retry waiting for a pid-less hard limit.
  if (!waitForExpiry && !hasConfirmableIdentity(row.captureTeardown) && row.captureTeardown) {
    await confirmOrphanedCapture(row, deps, false, mode);
  }
  if (row.confirmation) {
    return row.confirmation;
  }
  const confirmation = (async () => {
    if ((hookDriven || row.hookDriven) && !(await hookRowStillUnconfirmed(row, deps))) {
      return;
    }
    const descriptor = row.captureTeardown;
    if (!descriptor || deps.ownedCaptureIds().includes(row.recordingId)) {
      return;
    }
    await confirmOrphanedCapture(row, deps, waitForExpiry, mode);
    // Identity replacement can retire this row while device confirmation yields.
    if (row.captureTeardown !== descriptor) {
      return;
    }
    await deps.recordingRepository.updateRecording(row.recordingId, { captureTeardown: undefined });
    row.captureTeardown = undefined;
  })();
  row.confirmation = confirmation;
  try {
    await confirmation;
  } finally {
    if (row.confirmation === confirmation) {
      row.confirmation = undefined;
    }
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

function hasConfirmableIdentity(descriptor: VideoCaptureTeardownDescriptor | undefined): boolean {
  return descriptor?.kind === "ios-host-recorder"
    ? descriptor.hostPid !== undefined
    : descriptor?.devicePid !== undefined;
}

function orphanExpiresAt(row: VideoRecordingRecord): number {
  if (hasConfirmableIdentity(row.captureTeardown) || !row.captureTeardown) {
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
  mode: "user" | "background",
): Promise<void> {
  const descriptor = row.captureTeardown!;
  if (descriptor.kind === "ios-host-recorder") {
    await deps.forceStopOrphanedCapture(undefined, descriptor, { mode });
    return;
  }
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
    throw new DeviceUnreachableError(
      `Cannot find device ${row.deviceId} to confirm orphan recorder teardown.`,
    );
  }
  await deps.forceStopOrphanedCapture(device, descriptor);
}

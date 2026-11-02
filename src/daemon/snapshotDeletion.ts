import { ActionableError, type BootedDevice } from "../models";
import { assertSafeSnapshotName } from "../utils/snapshotNameValidation";
import { logger } from "../utils/logger";
import {
  deleteDeviceSnapshotRecord,
  getDeviceSnapshotConfig,
  getDeviceSnapshotDependencies,
  hydrateLegacySnapshot,
  notifySnapshotResources,
  removeSnapshotArchiveAndRowAfterRecovery,
  withExclusiveSnapshotRecord,
} from "./deviceSnapshotManager";
import { assertSnapshotMatchesDevice } from "./snapshotDeviceMatch";

/**
 * Delete a snapshot by name (#14065): its row, archive data and, for a VM snapshot, its in-AVD
 * payload. A legacy snapshot is found the way restore finds it. The device must be the snapshot's
 * own, as for a restore; a VM payload its emulator cannot reclaim now stays pending.
 */
export async function deleteDeviceSnapshot(
  device: BootedDevice,
  args: { snapshotName: string; vmSnapshotTimeoutMs?: number },
): Promise<{ snapshotName: string; deleted: boolean; pendingReclaim?: true }> {
  // Also refuses a session broker baseline name.
  assertSafeSnapshotName(args.snapshotName);
  const { snapshotRepository, snapshotStore, now } = await getDeviceSnapshotDependencies();
  const record =
    (await snapshotRepository.getSnapshot(args.snapshotName)) ??
    (await hydrateLegacySnapshot(args.snapshotName, snapshotStore, snapshotRepository, now));
  if (!record) {
    throw new ActionableError(`Snapshot '${args.snapshotName}' not found`);
  }
  assertSnapshotMatchesDevice(record, device, "deleted");
  const timeoutMs =
    args.vmSnapshotTimeoutMs ?? (await getDeviceSnapshotConfig()).vmSnapshotTimeoutMs;
  if (await deleteDeviceSnapshotRecord(record, timeoutMs)) {
    await notifySnapshotResources();
    return { snapshotName: record.snapshotName, deleted: true };
  }
  if ((await snapshotRepository.getSnapshot(record.snapshotName))?.pendingReclaim) {
    return { snapshotName: record.snapshotName, deleted: false, pendingReclaim: true };
  }
  throw new ActionableError(
    `Snapshot '${record.snapshotName}' is in use by another snapshot operation; retry the delete`,
  );
}

/**
 * Forget the fixtures of an AVD the deleteDevice workflow destroyed (#14065). Their in-AVD payloads
 * went with the AVD, so no emulator is asked. Returns the names removed; a fixture another snapshot
 * operation holds is left and named, and its next restore removes it as invalidated.
 */
export async function forgetFixturesOfDestroyedAvd(avdName: string): Promise<string[]> {
  const { snapshotRepository } = await getDeviceSnapshotDependencies();
  const fixtures = (await snapshotRepository.listSnapshots({ snapshotType: "vm" })).filter(
    (record) => record.deviceName === avdName && record.manifest.fixture !== undefined,
  );
  const removed: string[] = [];
  for (const record of fixtures) {
    const outcome = await withExclusiveSnapshotRecord(record, () =>
      removeSnapshotArchiveAndRowAfterRecovery(record),
    );
    if (outcome === true) {
      removed.push(record.snapshotName);
    } else {
      logger.warn(
        `[DeviceSnapshot] Fixture '${record.snapshotName}' of destroyed AVD '${avdName}' was in use ` +
          "and is left; its next restore removes it",
      );
    }
  }
  if (removed.length > 0) {
    await notifySnapshotResources();
  }
  return removed;
}

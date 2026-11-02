import type { DeviceSnapshotRecord } from "../db/deviceSnapshotRepository";
import {
  AVD_DEFAULT_BOOT_SNAPSHOT,
  type AvdSnapshotOperations,
} from "../utils/android-cmdline-tools/AvdSnapshotService";
import { logger } from "../utils/logger";

/** An in-AVD snapshot directory with no archive row behind it (#6490). */
export interface OrphanedAvdSnapshot {
  avdName: string;
  snapshotName: string;
  /**
   * The directory the scan resolved, so manual cleanup can target it verbatim.
   * ANDROID_AVD_HOME and an `<avd>.ini` redirect both move an AVD off the
   * conventional `~/.android/avd/<avd>.avd` path (#6891 review).
   */
  directoryPath: string;
  sizeBytes: number | null;
}

export interface OrphanedAvdSnapshotSummary {
  count: number;
  totalSizeBytes: number;
  unsizedCount: number;
  entries: OrphanedAvdSnapshot[];
}

/**
 * Identity of an in-AVD snapshot payload: `<avd>.avd/snapshots/<name>`. A bare
 * snapshot name is NOT that identity — two AVDs can each hold a `foo` directory,
 * and an iOS or archive-type record named `foo` owns bytes somewhere else
 * entirely. Keying the accounted set on the name alone let any one of those hide
 * a genuine orphan and all of its bytes (#6490 review).
 */
function avdSnapshotKey(avdName: string, snapshotName: string): string {
  return `${avdName}\u0000${snapshotName}`;
}

/**
 * Enumerate `<avd>.avd/snapshots/*` for every AVD on this host and report the
 * directories no record accounts for.
 *
 * Only an Android `vm` record accounts for an in-AVD directory, and only for its
 * OWN AVD — `deviceName` on such a record is the AVD name.
 *
 * Report only — an orphan may predate AutoMobile, or be a user-made snapshot
 * someone relies on, so nothing here deletes. The field found nine such
 * directories holding 17.3 GB with no way to even see them (#6490); removing one
 * is a deliberate manual step (see docs/using/test-prep-tools.md).
 */
export async function summarizeOrphanedAvdSnapshots(
  records: DeviceSnapshotRecord[],
  avdSnapshots: Pick<AvdSnapshotOperations, "listKnownAvdNames" | "listAvdSnapshotDirectories">,
): Promise<OrphanedAvdSnapshotSummary> {
  const accounted = new Set(
    records
      .filter((record) => record.platform === "android" && record.snapshotType === "vm")
      .map((record) => avdSnapshotKey(record.deviceName, record.snapshotName)),
  );

  const entries: OrphanedAvdSnapshot[] = [];
  try {
    for (const avdName of await avdSnapshots.listKnownAvdNames()) {
      const directories = await avdSnapshots.listAvdSnapshotDirectories(avdName);
      entries.push(
        ...directories
          // Only the literal default_boot directory is the emulator's own
          // quick-boot state. Keep this comparison exact: on case-sensitive
          // filesystems, DEFAULT_BOOT and Default_boot are distinct directories
          // that may contain real orphaned data and must be reported. The
          // capture-rejection check elsewhere remains case-insensitive because
          // it prevents aliasing names from colliding with default_boot on
          // case-insensitive hosts; that is a separate capture-time concern.
          .filter(
            (entry) =>
              entry.snapshotName !== AVD_DEFAULT_BOOT_SNAPSHOT &&
              !accounted.has(avdSnapshotKey(avdName, entry.snapshotName)),
          )
          .map((entry) => ({ avdName, ...entry })),
      );
    }
  } catch (error) {
    // Orphan reporting is diagnostic garnish on the archive listing; a failure
    // to scan must not fail the listing itself (CLAUDE.md strategy 2).
    logger.warn(`[DeviceSnapshot] Failed to scan for orphaned in-AVD snapshots: ${error}`, error);
  }

  return {
    count: entries.length,
    totalSizeBytes: entries.reduce((sum, entry) => sum + (entry.sizeBytes ?? 0), 0),
    unsizedCount: entries.filter((entry) => entry.sizeBytes === null).length,
    entries,
  };
}

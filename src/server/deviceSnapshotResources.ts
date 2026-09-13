import { ResourceRegistry, type ResourceContent } from "./resourceRegistry";
import { getDeviceSnapshotConfig, listDeviceSnapshots } from "./deviceSnapshotManager";
import { DEVICE_SNAPSHOT_RESOURCE_URIS } from "./deviceSnapshotResourceUris";
import { logger } from "../utils/logger";

async function getSnapshotArchive(): Promise<ResourceContent> {
  try {
    const {
      snapshots,
      count,
      totalSizeBytes,
      unsizedCount,
      pendingReclaimCount,
      orphanedAvdSnapshots,
    } = await listDeviceSnapshots();
    const config = await getDeviceSnapshotConfig();

    return {
      uri: DEVICE_SNAPSHOT_RESOURCE_URIS.ARCHIVE,
      mimeType: "application/json",
      text: JSON.stringify(
        {
          snapshots,
          count,
          totalSizeBytes,
          // Records whose payload could not be measured. They are NOT in
          // totalSizeBytes, so a non-zero count here means the archive is
          // bigger than the total says (#6490).
          unsizedCount,
          // Records whose in-AVD payload still needs an emulator-console
          // delete; the sweep completes them when that AVD is next live.
          pendingReclaimCount,
          // In-AVD snapshot directories with no record behind them. Reported,
          // never auto-deleted — see docs/using/test-prep-tools.md for the
          // manual cleanup path.
          orphanedAvdSnapshots,
          maxArchiveSizeMb: config.maxArchiveSizeMb,
        },
        null,
        2,
      ),
    };
  } catch (error) {
    logger.error(`[DeviceSnapshotResources] Failed to list snapshots: ${error}`);
    return {
      uri: DEVICE_SNAPSHOT_RESOURCE_URIS.ARCHIVE,
      mimeType: "application/json",
      text: JSON.stringify(
        {
          error: `Failed to list snapshots: ${error}`,
        },
        null,
        2,
      ),
    };
  }
}

export function registerDeviceSnapshotResources(): void {
  ResourceRegistry.register(
    DEVICE_SNAPSHOT_RESOURCE_URIS.ARCHIVE,
    "Device Snapshot Archive",
    "Metadata list for captured device snapshots.",
    "application/json",
    getSnapshotArchive,
  );

  logger.info("[DeviceSnapshotResources] Registered device snapshot resources");
}

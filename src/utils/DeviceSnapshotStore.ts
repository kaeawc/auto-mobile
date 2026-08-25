import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";
import { logger } from "./logger";
import type { Platform } from "../models";

/**
 * Suffix of the sibling directory that {@link DeviceSnapshotStore.replaceSnapshotData}
 * moves an existing snapshot into while a fresh capture writes. Reserved: capture
 * rejects any snapshotName ending in it (see `assertSnapshotNameWritable`) and the
 * legacy-archive scan skips directories bearing it, so this internal set-aside path
 * can never collide with — or be re-imported as — a real user snapshot (issue #5713).
 */
export const SNAPSHOT_REPLACING_SUFFIX = ".replacing";

export interface SnapshotPathOptions {
  platform?: Platform;
  deviceId?: string;
  /**
   * Android AVD name. Android snapshots are keyed by AVD name — unique
   * (avdmanager enforces one AVD per name) and stable across reboots, unlike the
   * port-based emulator serial. Only set for emulator snapshots; physical
   * Android devices have no AVD name and fall back to the unscoped path (#5707).
   */
  avdName?: string;
}

export class DeviceSnapshotStore {
  private basePath: string;

  constructor(customBasePath?: string) {
    this.basePath = customBasePath || path.join(os.homedir(), ".auto-mobile", "snapshots");
  }

  getBasePath(): string {
    return this.basePath;
  }

  async ensureSnapshotsDirectory(): Promise<void> {
    try {
      await fs.mkdir(this.basePath, { recursive: true });
    } catch (error) {
      logger.error(`Failed to create snapshots directory: ${error}`);
      throw error;
    }
  }

  getSnapshotPath(snapshotName: string): string {
    return path.join(this.basePath, snapshotName);
  }

  getSnapshotPathWithOptions(snapshotName: string, options?: SnapshotPathOptions): string {
    if (options?.platform === "ios" && options.deviceId) {
      return path.join(this.basePath, "ios", options.deviceId, snapshotName);
    }

    // Android emulators scope by AVD name so the same snapshot name can be
    // reused across AVDs without a filesystem collision (#5707).
    if (options?.platform === "android" && options.avdName) {
      return path.join(this.basePath, "android", options.avdName, snapshotName);
    }

    return this.getSnapshotPath(snapshotName);
  }

  getSettingsPath(snapshotName: string, options?: SnapshotPathOptions): string {
    return path.join(this.getSnapshotPathWithOptions(snapshotName, options), "settings.json");
  }

  getMetadataPath(snapshotName: string, options?: SnapshotPathOptions): string {
    return path.join(this.getSnapshotPathWithOptions(snapshotName, options), "metadata.json");
  }

  getAppDataPath(snapshotName: string, options?: SnapshotPathOptions): string {
    const folderName = options?.platform === "ios" ? "app-data" : "app_data";
    return path.join(this.getSnapshotPathWithOptions(snapshotName, options), folderName);
  }

  async snapshotDirectoryExists(
    snapshotName: string,
    options?: SnapshotPathOptions,
  ): Promise<boolean> {
    try {
      await fs.access(this.getSnapshotPathWithOptions(snapshotName, options));
      return true;
    } catch (error) {
      // fs.access throws when the snapshot directory doesn't exist yet, which is a
      // normal "no snapshot taken" state, not an error — report false.
      logger.debug(`src/utils/DeviceSnapshotStore.ts fallback failed: ${error}`, error);
      return false;
    }
  }

  /**
   * Run `capture` as an atomic overwrite of `snapshotName`'s on-disk data.
   *
   * Any existing snapshot directory is moved aside first, so the capture writes
   * into a clean directory and no stale files from a prior capture survive
   * ("replace", not "merge"). On success the set-aside copy is discarded; on
   * failure the partial capture is removed and the prior data is restored — a
   * failed overwrite must never destroy the snapshot it was replacing. Callers
   * serialize same-name captures at a higher layer, so the fixed sibling
   * set-aside path (`<dir>.replacing`) only ever hosts one overwrite at a time
   * (issue #5713).
   */
  async replaceSnapshotData<T>(
    snapshotName: string,
    options: SnapshotPathOptions | undefined,
    capture: () => Promise<T>,
  ): Promise<T> {
    const snapshotPath = this.getSnapshotPathWithOptions(snapshotName, options);
    const asidePath = `${snapshotPath}${SNAPSHOT_REPLACING_SUFFIX}`;

    // Clear any set-aside leftover from a prior interrupted overwrite so the
    // rename below can't collide with stale state.
    await fs.rm(asidePath, { recursive: true, force: true });

    let hadExisting = false;
    try {
      await fs.rename(snapshotPath, asidePath);
      hadExisting = true;
    } catch (error) {
      // ENOENT means there was nothing to replace (first capture of this name),
      // which is normal. Any other error means we could not move the existing
      // data aside — fail rather than risk a dirty, half-overwritten snapshot.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    let result: T;
    try {
      result = await capture();
    } catch (error) {
      // Capture (and the record write it wraps) failed: discard the partial
      // fresh capture and restore the prior snapshot. A cleanup step failing
      // here must not mask the real capture error, so log-and-continue and
      // rethrow the original (CLAUDE.md catch convention).
      try {
        await fs.rm(snapshotPath, { recursive: true, force: true });
        if (hadExisting) {
          await fs.rename(asidePath, snapshotPath);
        }
      } catch (rollbackError) {
        logger.warn(
          `Failed to roll back snapshot '${snapshotName}' after a failed overwrite; ` +
            `prior data may be stranded at '${asidePath}': ${rollbackError}`,
        );
      }
      throw error;
    }

    // Capture succeeded and the record is already committed. Removing the
    // set-aside copy is best-effort cleanup — its failure must NOT roll back the
    // committed snapshot (that would leave the DB record describing the fresh
    // capture while the directory reverted to the old data). Log and continue;
    // the next overwrite clears it and the legacy scan skips *.replacing dirs.
    try {
      await fs.rm(asidePath, { recursive: true, force: true });
    } catch (cleanupError) {
      logger.warn(
        `Failed to remove set-aside snapshot copy '${asidePath}' after a successful ` +
          `overwrite; it will be cleaned up on the next capture: ${cleanupError}`,
      );
    }
    return result;
  }

  async deleteSnapshotData(snapshotName: string, options?: SnapshotPathOptions): Promise<void> {
    const snapshotPath = this.getSnapshotPathWithOptions(snapshotName, options);
    try {
      await fs.rm(snapshotPath, { recursive: true, force: true });
    } catch (error) {
      logger.warn(`Failed to delete snapshot data '${snapshotName}': ${error}`);
    }
  }

  generateSnapshotName(deviceName?: string): string {
    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, "-").replace("T", "_").split(".")[0];

    if (deviceName) {
      const sanitized = deviceName.replace(/[^a-zA-Z0-9-_]/g, "_");
      return `${sanitized}_${timestamp}`;
    }

    return `snapshot_${timestamp}`;
  }

  async getSnapshotSizeBytes(snapshotName: string, options?: SnapshotPathOptions): Promise<number> {
    const snapshotPath = this.getSnapshotPathWithOptions(snapshotName, options);
    return this.getDirectorySize(snapshotPath);
  }

  private async getDirectorySize(dirPath: string): Promise<number> {
    let size = 0;

    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);

        if (entry.isDirectory()) {
          size += await this.getDirectorySize(fullPath);
        } else {
          const stats = await fs.stat(fullPath);
          size += stats.size;
        }
      }
    } catch (error) {
      logger.debug(`Failed to get directory size for ${dirPath}: ${error}`);
    }

    return size;
  }
}

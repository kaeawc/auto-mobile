import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";
import { logger } from "./logger";
import type { Platform } from "../models";

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

import * as os from "os";
import * as path from "path";
import type { DeviceSnapshotStore } from "../../src/utils/DeviceSnapshotStore";

type DeviceSnapshotStoreContract = Pick<
  DeviceSnapshotStore,
  | "getBasePath"
  | "getSnapshotPath"
  | "generateSnapshotName"
  | "snapshotDirectoryExists"
  | "getSnapshotSizeBytes"
  | "deleteSnapshotData"
  | "replaceSnapshotData"
>;

export class FakeDeviceSnapshotStore implements DeviceSnapshotStoreContract {
  private basePath: string;
  private sizes = new Map<string, number>();
  private existing = new Set<string>();
  private deleted = new Set<string>();
  private generatedNames: string[] = [];
  private nameCounter = 0;

  constructor(basePath?: string) {
    this.basePath = basePath ?? path.join(os.tmpdir(), "auto-mobile-fake-snapshots");
  }

  getBasePath(): string {
    return this.basePath;
  }

  getSnapshotPath(snapshotName: string): string {
    return path.join(this.basePath, snapshotName);
  }

  setSnapshotSize(snapshotName: string, sizeBytes: number): void {
    this.sizes.set(snapshotName, sizeBytes);
  }

  setSnapshotExists(snapshotName: string, exists: boolean): void {
    if (exists) {
      this.existing.add(snapshotName);
    } else {
      this.existing.delete(snapshotName);
    }
  }

  queueGeneratedName(snapshotName: string): void {
    this.generatedNames.push(snapshotName);
  }

  getDeletedSnapshots(): string[] {
    return Array.from(this.deleted);
  }

  generateSnapshotName(_deviceName?: string): string {
    if (this.generatedNames.length > 0) {
      return this.generatedNames.shift() as string;
    }
    this.nameCounter += 1;
    return `snapshot-${this.nameCounter}`;
  }

  async snapshotDirectoryExists(snapshotName: string): Promise<boolean> {
    return this.existing.has(snapshotName);
  }

  async getSnapshotSizeBytes(snapshotName: string): Promise<number> {
    return this.sizes.get(snapshotName) ?? 0;
  }

  async replaceSnapshotData<T>(
    snapshotName: string,
    _options: unknown,
    capture: () => Promise<T>,
  ): Promise<T> {
    // The fresh capture replaces any prior on-disk data for this name. On
    // failure the prior "exists" flag is left intact (the real store restores
    // the set-aside copy), mirroring the atomic-overwrite contract.
    const priorExists = this.existing.has(snapshotName);
    this.existing.delete(snapshotName);
    try {
      const result = await capture();
      this.existing.add(snapshotName);
      return result;
    } catch (error) {
      if (priorExists) {
        this.existing.add(snapshotName);
      }
      throw error;
    }
  }

  async deleteSnapshotData(snapshotName: string): Promise<void> {
    this.deleted.add(snapshotName);
    this.existing.delete(snapshotName);
    this.sizes.delete(snapshotName);
  }
}
